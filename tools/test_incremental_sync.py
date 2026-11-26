#!/usr/bin/env python3
"""增量同步服务端桩测（真实 server.py + 临时 SQLite，零第三方依赖）。

覆盖：rev 单调序号、?since= 只拉变更、删除墓碑、分页、epoch 代际、
时钟回拨/同毫秒写入不漏、非法 since 回退全量、老客户端兼容、LWW 裁决、
请求体上限与鉴权。运行：python tools/test_incremental_sync.py [port]
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18931
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://127.0.0.1:%d" % PORT

passed = 0
failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS " + name)
    else:
        failed += 1
        print("  FAIL " + name + ("（" + str(extra) + "）" if extra else ""))


def req(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("X-Token", token)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"raw": raw}


def req_raw(method, path, token=None):
    r = urllib.request.Request(BASE + path, method=method)
    if token:
        r.add_header("X-Token", token)
    with urllib.request.urlopen(r, timeout=15) as resp:
        return resp.status, resp.read().decode()


def stamp(ms=0):
    return "2026-11-26T10:00:%02d.%03dZ" % (ms // 1000, ms % 1000)


def put(token, note_id, updated_at=None, device="dev-a", deleted=False):
    payload = {
        "iv": "a" * 16,
        "payload": "ciphertext-for-" + note_id,
        "updated_at": updated_at or datetime.now(timezone.utc).isoformat(
            timespec="milliseconds").replace("+00:00", "Z"),
        "device": device,
    }
    method = "DELETE" if deleted else "PUT"
    return req(method, "/api/notes/" + note_id, payload, token)


def main():
    tmp = tempfile.mkdtemp(prefix="nn-incsync-test-")
    env = dict(os.environ, PORT=str(PORT), DATA_DIR=tmp,
               STATIC_DIR=os.path.join(ROOT, "static"))
    env.pop("NOTES_USER", None)
    env.pop("NOTES_PASS", None)
    proc = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "server.py")], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 10
        while True:
            try:
                req("GET", "/api/health")
                break
            except (urllib.error.URLError, ConnectionError):
                if time.time() > deadline:
                    raise RuntimeError("server.py 未启动")
                time.sleep(0.2)

        status, login = req("POST", "/api/login",
                            {"username": "admin", "password": "admin"})
        check("登录成功", status == 200 and bool(login.get("token")), login)
        token = login.get("token", "")

        # ---- 鉴权与空库 ----
        code, body = req("GET", "/api/notes?since=0")
        check("增量接口仍需鉴权", code == 401, (code, body))
        code, empty = req("GET", "/api/notes?since=0", token=token)
        check("空库增量返回 rev=0 / epoch=1 / 无分页",
              code == 200 and empty["notes"] == [] and empty["rev"] == 0
              and empty["epoch"] == 1 and empty["partial"] is False,
              empty)

        # ---- rev 单调递增 ----
        revs = []
        for i in range(1, 4):
            code, result = put(token, "n%d" % i)
            check("PUT n%d 生效且带 rev" % i,
                  code == 200 and result.get("applied") is True
                  and isinstance(result["note"].get("rev"), int), result)
            revs.append(result["note"]["rev"])
        check("rev 严格递增 1,2,3", revs == [1, 2, 3], revs)

        code, full = req("GET", "/api/notes?since=0", token=token)
        check("since=0 全量分页拉到 3 条并按 rev 升序",
              len(full["notes"]) == 3
              and [n["rev"] for n in full["notes"]] == [1, 2, 3]
              and full["partial"] is False and full["nextSince"] == 3, full)
        check("响应带服务端 rev / epoch / serverTime",
              full["rev"] == 3 and full["epoch"] == 1 and "serverTime" in full, full)

        code, none = req("GET", "/api/notes?since=3", token=token)
        check("无变更时只回空列表（不再重复 3 条）",
              none["notes"] == [] and none["rev"] == 3
              and none["nextSince"] == 3 and none["partial"] is False, none)

        # ---- 只拉变更 ----
        code, r4 = put(token, "n4")
        code, delta = req("GET", "/api/notes?since=3", token=token)
        check("since=3 只返回新增的 1 条",
              len(delta["notes"]) == 1 and delta["notes"][0]["id"] == "n4"
              and delta["notes"][0]["rev"] == 4, delta)

        # ---- 删除 = 墓碑，增量可拉到 ----
        code, deleted = put(token, "n2", deleted=True)
        check("DELETE 分配新 rev", deleted["applied"] is True
              and deleted["note"]["rev"] == 5, deleted)
        code, tomb = req("GET", "/api/notes?since=4", token=token)
        check("增量同步能拉到删除墓碑",
              len(tomb["notes"]) == 1 and tomb["notes"][0]["id"] == "n2"
              and tomb["notes"][0]["deleted"] is True
              and tomb["notes"][0]["rev"] == 5, tomb)

        # ---- 时钟回拨 / 同毫秒写入不漏（rev 与 updated_at 解耦）----
        old_time = "2020-01-01T00:00:00.000Z"
        for i in (5, 6):
            code, result = put(token, "clock%d" % i, updated_at=stamp(100),
                               device="dev-%d" % i)
            check("同一毫秒 + 不同 device 写入生效", code == 200
                  and result["applied"] is True, result)
        code, clock = req("GET", "/api/notes?since=5", token=token)
        check("rev 序号与客户端时钟无关，新写入不漏",
              len(clock["notes"]) == 2
              and set(n["id"] for n in clock["notes"]) == {"clock5", "clock6"}, clock)
        code, stale = put(token, "clock5", updated_at=old_time, device="dev-z")
        check("旧时间戳写入被 LWW 拒绝（applied=false）",
              stale["applied"] is False and stale["note"]["rev"] == 6, stale)

        # ---- 非法 since 回退全量 ----
        for bad in ("-1", "abc", "1.5", "99999999999999999999"):
            code, body = req("GET", "/api/notes?since=" + urllib.parse.quote(bad), token=token)
            # 此刻库里共 6 条：n1/n2(墓碑)/n3/n4/clock5/clock6；
            # 旧时间戳那次写入被 LWW 拒绝，不产生新行。
            check("非法 since=%s 回退全量" % bad,
                  code == 200 and len(body["notes"]) >= 6, body.get("notes") and len(body["notes"]))

        # ---- 分页 ----
        for i in range(410):
            put(token, "bulk%03d" % i)
        code, page1 = req("GET", "/api/notes?since=0", token=token)
        check("超过 PAGE_LIMIT 触发分页",
              page1["partial"] is True and len(page1["notes"]) == 400
              and page1["nextSince"] == page1["notes"][-1]["rev"],
              (page1["partial"], len(page1["notes"]), page1["nextSince"]))
        seen = set(n["id"] for n in page1["notes"])
        cursor = page1["nextSince"]
        pages = 1
        while True:
            code, page = req("GET", "/api/notes?since=" + str(cursor), token=token)
            seen.update(n["id"] for n in page["notes"])
            pages += 1
            if not page["partial"]:
                break
            cursor = page["nextSince"]
            if pages > 10:
                break
        check("分页游标不跳号、不漏条目",
              pages <= 5 and len(seen) == 6 + 410
              and "bulk409" in seen, (pages, len(seen)))

        # ---- 流量对比：无变更时增量只回元数据，不再重复整个库 ----
        code, full_raw = req_raw("GET", "/api/notes", token=token)
        head = json.loads(full_raw)["rev"]
        code, inc_raw = req_raw("GET", "/api/notes?since=" + str(head), token=token)
        inc = json.loads(inc_raw)
        check("无变更时增量响应仅元数据，体积不到全量的 1%",
              len(inc_raw) < 1024 and len(full_raw) > 100 * len(inc_raw)
              and inc["notes"] == [] and inc["rev"] == head,
              (len(full_raw), len(inc_raw)))
        print("    实测：全量 %d B / 增量 %d B（%d 条便签）"
              % (len(full_raw), len(inc_raw), len(json.loads(full_raw)["notes"])))

        # ---- epoch：RESET 换代号，客户端据此强制全量 ----
        code, meta_before = req("GET", "/api/meta", token=token)
        head_before = req("GET", "/api/notes?since=0", token=token)[1]["rev"]
        code, reset = req("DELETE", "/api/vault", {"confirm": "RESET"}, token)
        check("RESET 成功", code == 200 and reset.get("ok") is True, reset)
        code, meta_after = req("GET", "/api/meta", token=token)
        check("RESET 后 epoch 递增", meta_after["epoch"] == meta_before["epoch"] + 1,
              (meta_before["epoch"], meta_after["epoch"]))
        code, after = req("GET", "/api/notes?since=0", token=token)
        check("RESET 后 rev 不回退、notes 为空",
              after["notes"] == [] and after["rev"] >= head_before,
              (len(after["notes"]), after["rev"], head_before))
        code, fresh = put(token, "post-reset")
        check("RESET 后新写入仍能分配更大 rev",
              fresh["note"]["rev"] > head_before, fresh["note"].get("rev"))

        # ---- 老客户端兼容 ----
        code, legacy = req("GET", "/api/notes", token=token)
        check("不带 since 的老客户端仍一次拿到全部（忽略分页字段）",
              code == 200 and len(legacy["notes"]) == 1
              and legacy["notes"][0]["id"] == "post-reset", legacy)
        code, meta_legacy = req("GET", "/api/meta", token=token)
        check("老客户端读 meta 不受新增 epoch 字段影响",
              "initialized" in meta_legacy and isinstance(meta_legacy.get("epoch"), int),
              meta_legacy)

        # ---- 请求体上限不变 ----
        big = {"iv": "a" * 16, "payload": "x" * (13 * 1024 * 1024),
               "updated_at": stamp(0), "device": "dev-a"}
        code, body = req("PUT", "/api/notes/too-big", big, token)
        check("单条密文超过 12MB 仍返回 413", code == 413, (code, body))

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    print("\n增量同步服务端桩测：%d 通过，%d 失败" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
