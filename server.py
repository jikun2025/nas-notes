#!/usr/bin/env python3
"""NasNotes - 轻量便签同步服务（密文存储，仅使用 Python 标准库）。

服务端只保存 AES-GCM 密文、随机 IV 和同步元数据；
无法解密便签内容，也不提供服务端全文搜索。
"""

import json
import mimetypes
import os
import re
import sqlite3
import urllib.parse
from contextlib import closing
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
DATA_DIR = os.environ.get("DATA_DIR", "/data")
STATIC_DIR = os.environ.get(
    "STATIC_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
)
TOKEN = os.environ.get("NOTES_TOKEN", "").strip()
DB_PATH = os.path.join(DATA_DIR, "notes.db")

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_IV = 128
# 单条便签密文上限：预留图片/录音 base64（约 8 MiB 原始内容）。
MAX_PAYLOAD = 12 * 1024 * 1024
# 整个请求体上限，略大于 MAX_PAYLOAD，防止超大请求占用内存。
MAX_BODY = 14 * 1024 * 1024
META_VERSION = 1


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
    server_version = "NasNotes/2.0"

    # ---------- 基础响应 ----------
    def _send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        if not TOKEN:
            return True
        if self.headers.get("X-Token", "") == TOKEN:
            return True
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and auth[7:].strip() == TOKEN

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
            self._send_json(401, {"error": "需要访问令牌，请在页面设置中填写 NOTES_TOKEN"})
            return False
        return True

    # ---------- API ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self._send_json(200, {"ok": True, "service": "nas-notes", "encrypted": True})
            return

        # 令牌只保护 API。页面与静态资源必须无令牌可加载：否则设了
        # NOTES_TOKEN 后用户永远进不了「设置」（先有页面才能填令牌），
        # 且 Service Worker 注册 /sw.js 会 401、PWA 离线失效。数据本身已端到端加密。
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
            required = ("salt", "verifier", "iterations", "version")
            if any(key not in payload for key in required):
                self._send_json(400, {"error": "missing vault parameters"})
                return

            def op_meta(conn):
                existing = conn.execute("SELECT value FROM meta WHERE key = 'vault'").fetchone()
                if existing:
                    return 409, {"error": "vault already initialized"}
                value = {
                    "salt": str(payload["salt"])[:256],
                    "verifier": str(payload["verifier"])[:1024],
                    "iterations": int(payload["iterations"]),
                    "version": int(payload["version"]),
                }
                conn.execute(
                    "INSERT INTO meta (key, value) VALUES ('vault', ?)",
                    (json.dumps(value),),
                )
                value["initialized"] = True
                return 200, value

            status, body = transaction(op_meta)
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
        match = re.fullmatch(r"/api/notes/([^/]+)", parsed.path)
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
        self.send_header("Allow", "GET, PUT, DELETE, OPTIONS")
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
