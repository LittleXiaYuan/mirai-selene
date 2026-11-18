"""测判断接口：用 Python 发请求，排除 curl 的编码问题。"""

import json
import sys
import urllib.request

API = sys.argv[1] if len(sys.argv) > 1 else "https://mirai.cloudtori.cn/mirai-api/judge"

PAYLOAD = {
    "world": {
        "name": "林夏的毕业选择",
        "hook": "青岛女生在上海 offer、考研、留在青岛之间",
        "characters": [
            {"name": "林夏", "role": "主角", "traits": "22 岁，怕的不是选错，是没有选择"},
            {"name": "母亲", "role": "家人", "traits": "嘴硬心软"},
        ],
    },
    "path": [
        {"label": "她撕了上海的信", "narration": "纸被撕开的声音很轻，她却听见了。"},
        {"label": "她给母亲打了电话", "narration": "电话响了三声，母亲接起来，先问的是吃饭没有。"},
    ],
    "memories": [{"key": "安心", "value": 7}, {"key": "房租压力", "value": 3}],
}


def main():
    body = json.dumps(PAYLOAD, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        API, data=body, headers={"Content-Type": "application/json; charset=utf-8"}
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.loads(r.read().decode("utf-8"))

    v = data.get("verdict", {})
    print("最可能:", v.get("likely"))
    print("信心:", v.get("confidence"))
    print("假设:")
    for a in v.get("assumptions", []):
        print("  ·", a)
    print("改什么会不同:")
    for s in v.get("sensitivity", []):
        print("  ·", s.get("change"), "→", s.get("effect"))
    print("该注意:")
    for x in v.get("risks", []):
        print("  ·", x)
    print("建议:", v.get("advice"))

    # 检查乱码
    text = json.dumps(v, ensure_ascii=False)
    bad = [c for c in text if ord(c) < 32 or c == "\ufffd"]
    print("\n乱码字符数:", len(bad))
    print("是否引用了实际动作:", "撕" in text or "打电话" in text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
