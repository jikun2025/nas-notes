"""部署验证：对着指定 nas-notes 实例跑一遍增量同步协议全流程。

用法：python tools/verify_deploy.py http://127.0.0.1:28081
只读/写临时实例，不碰线上数据。
"""
import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:28081").rstrip("/")
TOKEN = ""
PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  PASS  %s" % name)
    else:
        FAIL += 1
        print("  FAIL  %s  -> %r" % (name, detail))


def req(method, path, body=None, token=None, raw=False):
    url = BASE + path
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        r.add_header("Content-Type", "application/json")
    tok = token if token is not None else TOKEN
    if tok:
        r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            payload = resp.read()
            return resp.status, (payload if raw else json.loads(payload.decode())), len(payload)
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            parsed = json.loads(payload.decode())
        except Exception:
            parsed = payload.decode(errors="replace")
        return e.code, parsed, len(payload)


def note(nid, stamp, deleted=False, device="pc"):
    return {
        "iv": "aXYt" + nid,
        "payload": "Y2lwaGVy" * 20 + "-" + nid,
        "updated_at": stamp,
        "device": device,
        "deleted": deleted,
    }


def main():
    global TOKEN
    print("== 目标 %s ==" % BASE)

    code, body, _ = req("GET", "/api/health")
    check("健康检查 200", code == 200 and body.get("ok") is True, (code, body))

    code, body, _ = req("POST", "/api/login",
                        {"username": "admin", "password": "admin"})
    check("默认账户登录成功", code == 200 and bool(body.get("token")), (code, body))
    TOKEN = body.get("token", "")

    code, body, _ = req("PUT", "/api/meta", {
        "salt": "c2FsdA==", "wrapped": "aXY6Y3Q=", "iterations": 310000, "version": 1,
    })
    check("初始化加密库元数据", code == 200, (code, body))

    code, body, _ = req("GET", "/api/meta")
    check("meta 带 epoch 代际", code == 200 and body.get("epoch") == 1, body)

    # 老客户端不带 since：仍是一次性全量
    code, body, _ = req("GET", "/api/notes")
    check("老客户端无 since 走全量且不报错",
          code == 200 and body.get("notes") == [] and body.get("partial") is False, body)

    revs = []
    for nid, stamp in (("n1", "2026-11-26T10:00:01.000Z"),
                       ("n2", "2026-11-26T10:00:02.000Z")):
        code, body, _ = req("PUT", "/api/notes/" + nid, note(nid, stamp))
        check("写入 %s 并被接受" % nid, code == 200 and body.get("applied") is True, (code, body))
        revs.append(body["note"]["rev"])
    check("写入分配单调递增 rev", revs == sorted(revs) and len(set(revs)) == 2, revs)

    head = max(revs)
    code, body, full_bytes = req("GET", "/api/notes?since=0")
    check("since=0 拉全量 2 条", code == 200 and len(body["notes"]) == 2, len(body.get("notes") or []))
    check("nextSince 等于服务端 head rev",
          body.get("nextSince") == body.get("rev") == head, (body.get("nextSince"), body.get("rev"), head))

    code, body, inc_bytes = req("GET", "/api/notes?since=%d" % head)
    check("无变更时增量返回 0 条", code == 200 and body["notes"] == [], body)
    check("空增量响应只有协议头体积（<300B）", inc_bytes < 300, inc_bytes)

    code, body, _ = req("PUT", "/api/notes/n3", note("n3", "2026-11-26T10:00:03.000Z"))
    rev3 = body["note"]["rev"]
    code, body, _ = req("GET", "/api/notes?since=%d" % head)
    ids = [n["id"] for n in body["notes"]]
    check("新增 1 条只拉 1 条", ids == ["n3"], ids)
    check("新条目 rev 继续递增", rev3 > head, (rev3, head))

    code, body, _ = req("PUT", "/api/notes/n1",
                        note("n1", "2026-11-26T10:00:09.000Z", deleted=True))
    rev_del = body["note"]["rev"]
    code, body, _ = req("GET", "/api/notes?since=%d" % rev3)
    check("删除以墓碑下发", len(body["notes"]) == 1 and body["notes"][0]["id"] == "n1"
          and body["notes"][0]["deleted"] is True, body["notes"])

    # 旧时间戳写入必须被 LWW 拒绝，且 rev 不前进
    code, body, _ = req("PUT", "/api/notes/n2", note("n2", "2026-11-26T09:00:00.000Z"))
    check("过期写入被 LWW 拒绝且不分配 rev",
          body.get("applied") is False and body["note"]["rev"] < rev_del, body)

    code, body, _ = req("GET", "/api/notes?since=%d" % rev_del)
    check("游标之后确实没有新变更", body["notes"] == [], body)

    code, body, _ = req("GET", "/api/notes?since=abc")
    check("非法 since 退化为全量不报错", code == 200 and len(body["notes"]) == 3, code)

    code, body, _ = req("GET", "/api/notes?since=999999")
    check("超前游标返回空集而非报错", code == 200 and body["notes"] == [], body)

    # 真实规模下的流量对比：40 条密文入库后，日常同步是否只搬协议头
    for i in range(40):
        req("PUT", "/api/notes/bulk%02d" % i,
            note("bulk%02d" % i, "2026-11-26T11:%02d:%02d.000Z" % (i // 60, i % 60)))
    code, body, bulk_full = req("GET", "/api/notes?since=0")
    check("40 条库全量可拉全", len(body["notes"]) == 43, len(body.get("notes") or []))
    head2 = body.get("nextSince")
    code, body, bulk_inc = req("GET", "/api/notes?since=%d" % head2)
    check("40 条库日常同步只拉空集", body["notes"] == [], body.get("notes"))
    check("日常同步流量不到全量的 2%",
          bulk_inc * 50 < bulk_full, (bulk_inc, bulk_full))
    print("  INFO  全量 %d B → 空增量 %d B（%.1f%%）"
          % (bulk_full, bulk_inc, bulk_inc * 100.0 / bulk_full))

    # 静态资源：新脚本已随镜像发布，且加载顺序正确（垫片最先、索引在 app 前）
    code, html, _ = req("GET", "/index.html", raw=True)
    text = html.decode("utf-8", "replace") if isinstance(html, bytes) else str(html)
    order = [text.find(s) for s in ("compat.js", "nn-index.js", "app.js")]
    check("index.html 注入 compat/nn-index/app",
          all(i >= 0 for i in order) and order == sorted(order), order)

    code, sw, _ = req("GET", "/sw.js", raw=True)
    swtext = sw.decode("utf-8", "replace")
    check("SW 缓存版本已升到 v28", "nas-notes-v28" in swtext, swtext.splitlines()[0])
    code, js, _ = req("GET", "/nn-index.js", raw=True)
    check("nn-index.js 可下载且含倒排实现",
          code == 200 and b"bigram" in js.lower(), code)

    print("\n== 结果：%d 通过 / %d 失败 ==" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
