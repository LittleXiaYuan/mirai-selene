"""用户系统端到端测试：注册 → 登录 → 存世界 → 取回 → 权限隔离 → 登出。

全部走真实 HTTP，用 cookie 维持会话。
用法：python deploy/test_auth.py [base_url]
"""

import json
import sys
import http.cookiejar
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8099"
RESULTS = []


def check(label, cond, detail=""):
    mark = "PASS" if cond else "FAIL"
    print(f"  [{mark}] {label} {detail}")
    RESULTS.append((label, cond))


def make_opener():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(opener, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with opener.open(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw or "{}")
        except Exception:
            return e.code, {"raw": raw[:200]}


DEMO_TREE = {
    "nodes": {
        "n1-aaaa": {
            "id": "n1-aaaa",
            "parentId": None,
            "label": "测试起点",
            "kind": "root",
            "state": {"numeric": {}, "scalars": {}, "tombstones": {}},
            "stateHash": "deadbeef",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "seq": 1,
            "mergedFrom": [],
        }
    },
    "rootId": "n1-aaaa",
    "audit": [],
    "seq": 1,
}


def main():
    print(f"base = {BASE}\n")

    # --- 匿名访问 ---
    anon = make_opener()
    status, data = call(anon, "/api/auth/me")
    check("匿名 /me 返回 user=null", status == 200 and data.get("user") is None, f"status={status}")

    status, data = call(anon, "/api/worlds")
    check("匿名读世界被拒 401", status == 401, f"status={status}")

    # --- 注册 ---
    import time

    email = f"test{int(time.time())}@example.com"
    alice = make_opener()
    status, data = call(
        alice, "/api/auth/register", "POST",
        {"email": email, "name": "测试者", "password": "supersecret123"},
    )
    check("注册成功 201", status == 201, f"status={status} {data.get('error','')}")
    check("注册返回用户", (data.get("user") or {}).get("email") == email)

    status, data = call(
        alice, "/api/auth/register", "POST",
        {"email": email, "name": "重复", "password": "supersecret123"},
    )
    check("重复邮箱被拒 409", status == 409, f"status={status}")

    status, data = call(
        make_opener(), "/api/auth/register", "POST",
        {"email": "bad", "name": "", "password": "123"},
    )
    check("弱输入被拒 400", status == 400, f"status={status}")

    # --- 存世界 ---
    world = {
        "id": "w-test-1",
        "name": "测试世界",
        "hook": "一个用于测试的世界",
        "characters": [{"id": "c1", "name": "甲", "role": "主角", "traits": "谨慎", "portrait": "/mirai/linxia.png"}],
        "tree": DEMO_TREE,
        "cursor": "n1-aaaa",
    }
    status, data = call(alice, "/api/worlds/w-test-1", "PUT", world)
    check("写入世界成功", status == 200, f"status={status} {data.get('error','')}")

    status, data = call(alice, "/api/worlds")
    worlds = data.get("worlds") or []
    check("列表能读回世界", len(worlds) == 1 and worlds[0]["id"] == "w-test-1", f"count={len(worlds)}")
    check("世界内容完整", (worlds[0].get("tree") or {}).get("rootId") == "n1-aaaa")

    # --- 权限隔离 ---
    bob = make_opener()
    email2 = f"bob{int(time.time())}@example.com"
    status, _ = call(bob, "/api/auth/register", "POST", {"email": email2, "name": "另一个人", "password": "supersecret123"})
    check("第二个用户注册成功", status == 201, f"status={status}")

    status, data = call(bob, "/api/worlds")
    check("看不到别人的世界", len(data.get("worlds") or []) == 0, f"count={len(data.get('worlds') or [])}")

    status, data = call(bob, "/api/worlds/w-test-1")
    check("直接读别人世界 404", status == 404, f"status={status}")

    status, data = call(bob, "/api/worlds/w-test-1", "DELETE")
    check("删不掉别人的世界", status == 404, f"status={status}")

    # --- 登出 ---
    status, _ = call(alice, "/api/auth/logout", "POST")
    check("登出成功", status == 200, f"status={status}")

    status, data = call(alice, "/api/worlds")
    check("登出后读世界 401", status == 401, f"status={status}")

    # --- 重新登录 ---
    status, data = call(alice, "/api/auth/login", "POST", {"email": email, "password": "supersecret123"})
    check("重新登录成功", status == 200, f"status={status}")
    check("登录带回世界", len(data.get("worlds") or []) == 1)

    status, data = call(make_opener(), "/api/auth/login", "POST", {"email": email, "password": "wrongpass123"})
    check("错误密码 401", status == 401, f"status={status}")

    # --- 与 LLM 代理共存 ---
    status, data = call(make_opener(), "/api/mirai/health")
    check("LLM 代理仍可用", status == 200 and data.get("ok") is True, f"status={status}")

    # --- 静态文件 ---
    with urllib.request.urlopen(BASE + "/app.html", timeout=15) as r:
        html = r.read().decode()
    check("新 App 页面可达", "Mirai-Selene" in html, f"len={len(html)}")

    print("\n=== 汇总 ===")
    passed = sum(1 for _, c in RESULTS if c)
    print(f"{passed}/{len(RESULTS)} 通过")
    for label, cond in RESULTS:
        if not cond:
            print(f"  未通过: {label}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
