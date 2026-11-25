#!/usr/bin/env python3
"""NasNotes - 轻量便签同步服务（密文存储，仅使用 Python 标准库）。

服务端只保存 AES-GCM 密文、随机 IV 和同步元数据；
无法解密便签内容，也不提供服务端全文搜索。

鉴权：标准账户登录（默认 admin / admin，首次登录后请在「设置」里修改），
登录换取随机会话令牌（X-Token / Bearer 头）。

口令不上传明文：客户端先用「账户登录盐 + 10 万次迭代」PBKDF2 派生出
登录凭证 credential，服务端只对 credential 再做一层 PBKDF2 哈希保存。
因此服务端数据库、日志与请求里都不会出现登录口令本身。
便签内容的端到端密钥（随机保险库密钥 wkey）由登录口令派生的密钥包裹
（wrapped），服务端只见密文包裹，换口令只换包裹层、不动笔记密文。
"""

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.parse
from contextlib import closing
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
DATA_DIR = os.environ.get("DATA_DIR", "/data")
STATIC_DIR = os.environ.get(
    "STATIC_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
)
DB_PATH = os.path.join(DATA_DIR, "notes.db")

# 默认账户：首次启动写入，用户在页面「设置」里自助改名/改密。
DEFAULT_USERNAME = os.environ.get("NOTES_USER", "").strip() or "admin"
DEFAULT_PASSWORD = os.environ.get("NOTES_PASS", "").strip() or "admin"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-\u4e00-\u9fff]{1,64}$")
MAX_IV = 128
# 单条便签密文上限：预留图片/录音 base64（约 8 MiB 原始内容）。
MAX_PAYLOAD = 12 * 1024 * 1024
# 整个请求体上限，略大于 MAX_PAYLOAD，防止超大请求占用内存。
MAX_BODY = 14 * 1024 * 1024
META_VERSION = 1

# 口令哈希（服务端账户表用，与客户端端到端 KDF 相互独立）
PWD_ITERATIONS = 200_000
# 客户端登录凭证派生参数（credential = PBKDF2-SHA256(passphrase, login_salt)）
LOGIN_ITERS = 100_000
LOGIN_SALT_RE = re.compile(r"^[A-Za-z0-9+/=]{8,512}$")
# 会话令牌：16 字节随机、24 小时有效、内存态（重启即全部失效）
SESSION_TTL_SECONDS = 24 * 3600
SESSION_SWEEP_INTERVAL = 300

# 登录限速：同一来源 60 秒窗口内最多 8 次失败，防在线爆破
LOGIN_WINDOW_SECONDS = 60
LOGIN_MAX_FAILS = 8

_sessions = {}
_sessions_lock = threading.Lock()
_last_sweep = 0.0

# ip -> [失败时间戳...]
_login_fails = {}
_login_fails_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def transaction(fn):
    conn = connect()
    try:
        with conn:
            return fn(conn)
    finally:
        conn.close()


# ---------- 口令哈希（PBKDF2-HMAC-SHA256，标准库 hashlib） ----------

def hash_password(password):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PWD_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PWD_ITERATIONS, base64.b64encode(salt).decode(), base64.b64encode(dk).decode()
    )


def verify_password(password, stored):
    try:
        scheme, iterations, salt_b64, hash_b64 = str(stored).split("$")
        if scheme != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), base64.b64decode(salt_b64), int(iterations)
        )
        return hmac.compare_digest(base64.b64encode(dk).decode(), hash_b64)
    except (ValueError, TypeError):
        return False


# ---------- 会话令牌 ----------

def sweep_sessions(now):
    global _last_sweep
    if now - _last_sweep < SESSION_SWEEP_INTERVAL:
        return
    _last_sweep = now
    cutoff = now + SESSION_TTL_SECONDS
    with _sessions_lock:
        for t, row in list(_sessions.items()):
            if row[1] <= now:
                _sessions.pop(t, None)


def create_session(username):
    token = secrets.token_urlsafe(32)
    with _sessions_lock:
        _sessions[token] = (username, time.time() + SESSION_TTL_SECONDS)
    return token


def lookup_session(token):
    with _sessions_lock:
        row = _sessions.get(token)
        if not row:
            return None
        if row[1] <= time.time():
            _sessions.pop(token, None)
            return None
        return row[0]


def drop_sessions(token=None, username=None):
    with _sessions_lock:
        if token:
            _sessions.pop(token, None)
        elif username:
            for t, row in list(_sessions.items()):
                if row[0] == username:
                    _sessions.pop(t, None)


# ---------- 登录限速 ----------

def login_rate_limited(ip):
    now = time.time()
    with _login_fails_lock:
        fails = [t for t in _login_fails.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        _login_fails[ip] = fails
        return len(fails) >= LOGIN_MAX_FAILS


def login_fail_record(ip):
    now = time.time()
    with _login_fails_lock:
        fails = [t for t in _login_fails.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        fails.append(now)
        _login_fails[ip] = fails


def login_fail_clear(ip):
    with _login_fails_lock:
        _login_fails.pop(ip, None)


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with closing(connect()) as conn:
        conn.execute("PRAGMA journal_mode=WAL")

        columns = [row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()]
        if columns and "title" in columns:
            conn.execute("DROP TABLE notes")
            conn.commit()
            print(
                "WARNING: 检测到旧版明文 notes 表，已删除。请用新版本重新创建便签。",
                flush=True,
            )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS notes (
                id         TEXT PRIMARY KEY,
                iv         TEXT NOT NULL DEFAULT '',
                payload    TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted    INTEGER NOT NULL DEFAULT 0,
                device     TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at)")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                username TEXT PRIMARY KEY,
                login_salt TEXT NOT NULL DEFAULT '',
                pass_hash TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        acct_columns = [
            row[1] for row in conn.execute("PRAGMA table_info(accounts)").fetchall()
        ]
        if acct_columns and "login_salt" not in acct_columns:
            # 旧版账户表没有 login_salt：补列，默认口令引导账户在
            # 下次改密时自动升级；旧行 login_salt 为空串，登录时视为
            # “直接口令哈希”的遗留模式（仅用于升级前过渡）。
            conn.execute("ALTER TABLE accounts ADD COLUMN login_salt TEXT NOT NULL DEFAULT ''")
        row = conn.execute("SELECT username FROM accounts").fetchone()
        if not row:
            # 默认账户引导：服务端按客户端同一 KDF 规范，从默认口令算出
            # 登录凭证（credential）再哈希入库——登录时客户端传的是
            # PBKDF2(口令, login_salt, 100k)，口令明文从不离开客户端。
            login_salt = base64.b64encode(secrets.token_bytes(16)).decode()
            credential = base64.b64encode(hashlib.pbkdf2_hmac(
                "sha256", DEFAULT_PASSWORD.encode("utf-8"),
                base64.b64decode(login_salt), LOGIN_ITERS, 32
            )).decode()
            conn.execute(
                "INSERT INTO accounts (username, login_salt, pass_hash, updated_at) VALUES (?, ?, ?, ?)",
                (DEFAULT_USERNAME, login_salt, hash_password(credential), now_iso()),
            )
            if DEFAULT_PASSWORD == "admin":
                print(
                    "NOTICE: 已创建默认账户 admin / admin —— 请首次登录后在「设置」中修改口令。",
                    flush=True,
                )
        conn.commit()


def note_dict(row):
    return {
        "id": row["id"],
        "iv": row["iv"],
        "payload": row["payload"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "deleted": bool(row["deleted"]),
        "device": row["device"],
    }


def is_newer(updated_a, device_a, updated_b, device_b):
    """last-write-wins，时间戳相同时用 device 字典序作为确定性裁决。"""
    if updated_a != updated_b:
        return updated_a > updated_b
    return device_a > device_b


class Handler(BaseHTTPRequestHandler):
    server_version = "NasNotes/3.0"

    # ---------- 基础响应 ----------
    def _send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _bearer(self):
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:].strip()
        return self.headers.get("X-Token", "").strip()

    def _session_user(self):
        token = self._bearer()
        if not token:
            return None
        return lookup_session(token)

    def _authorized(self):
        return self._session_user() is not None

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length < 0:
            return None
        if length > MAX_BODY:
            if length > 64 * 1024 * 1024:
                # 异常巨大的请求体：不读完，直接关闭连接。
                self.close_connection = True
                return None
            # 先把请求体读完再拒绝，否则客户端仍在发送时连接会被重置。
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
            return None
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            return {}
        try:
            value = json.loads(raw.decode("utf-8"))
            return value if isinstance(value, dict) else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _require_auth(self):
        if not self._authorized():
            self._send_json(
                401,
                {"error": "未登录或会话已过期", "code": "session",
                 "hint": "请在登录页输入账户与口令"},
            )
            return False
        return True

    # ---------- API ----------
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/login":
            sweep_sessions(time.time())
            payload = self._read_json()
            if payload is None:
                self._send_json(400, {"error": "invalid JSON"})
                return
            username = str(payload.get("username") or "").strip()
            credential = str(payload.get("credential") or "").strip()
            ip = self.client_address[0]
            if login_rate_limited(ip):
                self._send_json(
                    429,
                    {"error": "尝试次数过多，请 1 分钟后再试", "code": "rate_limited"},
                )
                return

            # credential = PBKDF2-SHA256(口令, login_salt, 100k)：由客户端
            # 派生后上传，口令明文从不离开本机；服务端只存它的哈希。
            def op(conn):
                row = conn.execute(
                    "SELECT login_salt, pass_hash FROM accounts WHERE username = ?",
                    (username,),
                ).fetchone()
                return row

            row = transaction(op)
            if not row or not row["login_salt"] or not credential:
                login_fail_record(ip)
                self._send_json(401, {"error": "账户或口令不正确", "code": "bad_credentials"})
                return
            if not verify_password(credential, row["pass_hash"]):
                login_fail_record(ip)
                # 统一提示，不区分“账户不存在”与“口令错误”
                self._send_json(401, {"error": "账户或口令不正确", "code": "bad_credentials"})
                return
            login_fail_clear(ip)
            token = create_session(username)
            self._send_json(
                200,
                {"ok": True, "token": token, "username": username,
                 "expiresIn": SESSION_TTL_SECONDS},
            )
            return

        if path == "/api/logout":
            if not self._require_auth():
                return
            drop_sessions(token=self._bearer())
            self._send_json(200, {"ok": True})
            return

        self._send_json(404, {"error": "not found"})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self._send_json(200, {"ok": True, "service": "nas-notes", "encrypted": True})
            return

        if path == "/api/login-salt":
            # 免鉴权：登录前取派生盐。无论账户是否存在都返回 200，
            # 不存在的账户返回随机盐（登录必然 401），防账户名枚举。
            qs = urllib.parse.parse_qs(parsed.query)
            username = (qs.get("username") or [""])[0].strip()
            salt = None
            if username and USERNAME_RE.fullmatch(username):
                def op(conn):
                    row = conn.execute(
                        "SELECT login_salt FROM accounts WHERE username = ?", (username,)
                    ).fetchone()
                    return row["login_salt"] if row and row["login_salt"] else None

                salt = transaction(op)
            if salt is None:
                salt = base64.b64encode(secrets.token_bytes(16)).decode()
            self._send_json(200, {"salt": salt, "iterations": LOGIN_ITERS})
            return

        # 会话令牌只保护 API。页面与静态资源必须免登录可加载：
        # 否则用户永远进不了登录页，且 Service Worker 注册 /sw.js 会
        # 401、PWA 离线失效。数据本身已端到端加密。
        if not path.startswith("/api/"):
            self._serve_static(path)
            return

        if not self._require_auth():
            return

        if path == "/api/meta":
            def op(conn):
                row = conn.execute("SELECT value FROM meta WHERE key = 'vault'").fetchone()
                if not row:
                    return {"initialized": False}
                value = json.loads(row["value"])
                value["initialized"] = True
                return value

            self._send_json(200, transaction(op))
            return

        if path == "/api/account":
            def op(conn):
                row = conn.execute("SELECT username FROM accounts ORDER BY updated_at").fetchone()
                return {"username": row["username"] if row else ""}

            self._send_json(200, transaction(op))
            return

        if path == "/api/notes":
            def op(conn):
                rows = conn.execute("SELECT * FROM notes ORDER BY updated_at DESC").fetchall()
                return {"notes": [note_dict(r) for r in rows], "serverTime": now_iso()}

            self._send_json(200, transaction(op))
            return

        self._send_json(404, {"error": "not found"})

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/meta":
            if not self._require_auth():
                return
            payload = self._read_json()
            if payload is None:
                self._send_json(400, {"error": "invalid JSON"})
                return
            required = ("salt", "wrapped", "iterations", "version")
            if any(key not in payload for key in required):
                self._send_json(400, {"error": "missing vault parameters"})
                return
            replace = bool(payload.get("replace"))

            def op_meta(conn):
                existing = conn.execute("SELECT value FROM meta WHERE key = 'vault'").fetchone()
                if existing and not replace:
                    return 409, {"error": "vault already initialized"}
                value = {
                    "salt": str(payload["salt"])[:256],
                    # 保险库密钥（wkey）的密文包裹：AES-GCM(KDF(口令,salt), wkey)
                    # 服务端只见密文，解不开 wkey 就无法解密任何笔记。
                    "wrapped": str(payload["wrapped"])[:2048],
                    "iterations": int(payload["iterations"]),
                    "version": int(payload["version"]),
                }
                conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES ('vault', ?)",
                    (json.dumps(value),),
                )
                value["initialized"] = True
                return 200, value

            status, body = transaction(op_meta)
            self._send_json(status, body)
            return

        if path == "/api/account":
            user = self._session_user()
            if user is None:
                self._send_json(401, {"error": "未登录或会话已过期", "code": "session"})
                return
            payload = self._read_json()
            if payload is None:
                self._send_json(400, {"error": "invalid JSON"})
                return
            current_credential = str(payload.get("current_credential") or "").strip()
            new_username = str(payload.get("username") or "").strip()
            new_credential = str(payload.get("new_credential") or "").strip()
            new_login_salt = str(payload.get("new_login_salt") or "").strip()
            vault = payload.get("vault")
            if vault is not None and (
                not isinstance(vault, dict)
                or any(key not in vault for key in ("salt", "wrapped", "iterations", "version"))
            ):
                self._send_json(400, {"error": "vault parameters incomplete"})
                return
            if new_credential:
                # 改口令必须同时带新盐与新的 vault 包裹，缺一拒绝，
                # 防止“登录口令换了但加密库包裹还是旧口令派生”。
                if not LOGIN_SALT_RE.fullmatch(new_login_salt):
                    self._send_json(400, {"error": "缺少有效的 new_login_salt"})
                    return
                if vault is None:
                    self._send_json(400, {"error": "改口令必须同时提交新的 vault 包裹"})
                    return

            def op_account(conn):
                row = conn.execute(
                    "SELECT username, login_salt, pass_hash FROM accounts WHERE username = ?",
                    (user,),
                ).fetchone()
                if not row or not row["login_salt"] or not current_credential:
                    return 403, {"error": "当前口令不正确"}
                if not verify_password(current_credential, row["pass_hash"]):
                    return 403, {"error": "当前口令不正确"}
                target_username = new_username or row["username"]
                if new_username and not USERNAME_RE.fullmatch(new_username):
                    return 400, {"error": "账户名只能包含中英文、数字、._-（最长 64）"}
                if new_username and new_username != row["username"]:
                    clash = conn.execute(
                        "SELECT 1 FROM accounts WHERE username = ?", (new_username,)
                    ).fetchone()
                    if clash:
                        return 409, {"error": "该账户名已被使用"}
                login_salt = new_login_salt or row["login_salt"]
                pass_hash = (
                    hash_password(new_credential) if new_credential else row["pass_hash"]
                )
                conn.execute(
                    "INSERT OR REPLACE INTO accounts (username, login_salt, pass_hash, updated_at) VALUES (?, ?, ?, ?)",
                    (target_username, login_salt, pass_hash, now_iso()),
                )
                if new_username and new_username != row["username"]:
                    conn.execute("DELETE FROM accounts WHERE username = ?", (row["username"],))
                # 改口令时用同一个事务原子替换 vault 包裹层——账户哈希与新
                # wrapped 要么同时生效要么都不生效，杜绝“口令已换但加密库
                # 还是旧包裹”导致笔记解不开的半程状态。
                if vault is not None and new_credential:
                    value = {
                        "salt": str(vault["salt"])[:256],
                        "wrapped": str(vault["wrapped"])[:2048],
                        "iterations": int(vault["iterations"]),
                        "version": int(vault["version"]),
                    }
                    conn.execute(
                        "INSERT OR REPLACE INTO meta (key, value) VALUES ('vault', ?)",
                        (json.dumps(value),),
                    )
                return 200, {"ok": True, "username": target_username}

            status, body = transaction(op_account)
            if status == 200:
                # 账户变更后撤销旧会话，强制重新登录；客户端应先完成
                # 密钥重包裹（PUT /api/meta replace + 全量重写笔记）再调用本接口。
                drop_sessions(username=user)
            self._send_json(status, body)
            return

        match = re.fullmatch(r"/api/notes/([^/]+)", path)
        if not match:
            self._send_json(404, {"error": "not found"})
            return
        if not self._require_auth():
            return

        note_id = urllib.parse.unquote(match.group(1))
        if not ID_RE.fullmatch(note_id):
            self._send_json(400, {"error": "invalid note id"})
            return

        payload = self._read_json()
        if payload is None:
            self._send_json(400, {"error": "invalid JSON"})
            return

        iv = str(payload.get("iv") or "")[:MAX_IV]
        ciphertext = str(payload.get("payload") or "")
        if not iv or not ciphertext:
            self._send_json(400, {"error": "iv and payload are required"})
            return
        if len(ciphertext) > MAX_PAYLOAD:
            self._send_json(413, {"error": "note payload too large"})
            return
        updated_at = str(payload.get("updated_at") or now_iso())[:40]
        device = str(payload.get("device") or "")[:64]
        deleted_flag = 1 if str(payload.get("deleted", "")).lower() in ("1", "true") else 0

        def op(conn):
            row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if row and not is_newer(updated_at, device, row["updated_at"], row["device"]):
                return {"applied": False, "note": note_dict(row)}

            created_at = row["created_at"] if row else updated_at
            conn.execute(
                """INSERT OR REPLACE INTO notes
                   (id, iv, payload, created_at, updated_at, deleted, device)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (note_id, iv, ciphertext, created_at, updated_at, deleted_flag, device),
            )
            saved = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            return {"applied": True, "note": note_dict(saved)}

        self._send_json(200, transaction(op))

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/vault":
            # 重置加密库：清空 vault 与全部密文（口令丢失时的逃生口）。
            if not self._require_auth():
                return
            payload = self._read_json()
            confirm = str((payload or {}).get("confirm") or "")
            if confirm != "RESET":
                self._send_json(400, {"error": '需要 {"confirm": "RESET"}'})
                return

            def op(conn):
                conn.execute("DELETE FROM meta WHERE key = 'vault'")
                conn.execute("DELETE FROM notes")

            transaction(op)
            self._send_json(200, {"ok": True})
            return

        match = re.fullmatch(r"/api/notes/([^/]+)", path)
        if not match:
            self._send_json(404, {"error": "not found"})
            return
        if not self._require_auth():
            return

        note_id = urllib.parse.unquote(match.group(1))
        if not ID_RE.fullmatch(note_id):
            self._send_json(400, {"error": "invalid note id"})
            return

        payload = self._read_json()
        if payload is None:
            self._send_json(400, {"error": "invalid JSON"})
            return

        updated_at = str(payload.get("updated_at") or now_iso())[:40]
        device = str(payload.get("device") or "")[:64]

        def op(conn):
            row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if row and not is_newer(updated_at, device, row["updated_at"], row["device"]):
                return {"applied": False, "note": note_dict(row)}

            created_at = row["created_at"] if row else updated_at
            iv = row["iv"] if row else ""
            ciphertext = row["payload"] if row else ""
            conn.execute(
                """INSERT OR REPLACE INTO notes
                   (id, iv, payload, created_at, updated_at, deleted, device)
                   VALUES (?, ?, ?, ?, ?, 1, ?)""",
                (note_id, iv, ciphertext, created_at, updated_at, device),
            )
            saved = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            return {"applied": True, "note": note_dict(saved)}

        self._send_json(200, transaction(op))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, PUT, POST, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- 静态资源 ----------
    def _serve_static(self, path):
        root = os.path.abspath(STATIC_DIR)
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        full = os.path.abspath(os.path.join(root, rel))

        if os.path.commonpath([root, full]) != root:
            self.send_error(403)
            return
        if not os.path.isfile(full):
            full = os.path.join(root, "index.html")
        if not os.path.isfile(full):
            self.send_error(404)
            return

        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".webmanifest"):
            ctype = "application/manifest+json"
        if full.endswith("sw.js"):
            ctype = "application/javascript"

        with open(full, "rb") as fh:
            data = fh.read()

        if ctype.startswith("text/") or "json" in ctype or ctype.startswith("application/javascript"):
            ctype += "; charset=utf-8"

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache" if full.endswith("sw.js") else "public, max-age=300")
        if full.endswith("sw.js"):
            self.send_header("Service-Worker-Allowed", "/")
        self.end_headers()
        self.wfile.write(data)


def main():
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"NasNotes listening on 0.0.0.0:{PORT} (data: {DB_PATH})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
