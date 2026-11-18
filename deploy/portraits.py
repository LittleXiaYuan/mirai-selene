"""生成缺失的角色立绘（母亲 / 导师），存成 webp。

用法：python deploy/portraits.py
需要本机 8080 上的 serve.mjs 在跑（带 MINIMAX_API_KEY）。
"""

import io
import os
import sys
import urllib.request

from PIL import Image

API = "http://127.0.0.1:8080/mirai-api/image"
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app", "public", "mirai"))

TARGETS = [
    (
        "mother",
        "一位 50 岁中国女性，短发，系着围裙，站在厨房窗边，神情温和但忧虑，"
        "写实摄影，自然光，半身，竖构图，电影感",
    ),
    (
        "mentor",
        "一位 45 岁中国男性学者，戴眼镜，衬衫，站在办公室书架前，神情沉静，"
        "写实摄影，自然光，半身，竖构图，电影感",
    ),
]


def post(payload):
    body = __import__("json").dumps(payload).encode()
    req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return __import__("json").loads(r.read().decode())


def main():
    for name, prompt in TARGETS:
        dest = os.path.join(OUT, f"{name}.webp")
        if os.path.exists(dest):
            print(f"{name}: 已存在，跳过")
            continue
        print(f"{name}: 生成中…")
        data = post(
            {
                "place": name,
                "time": "黄昏",
                "mood": "安静",
                "weather": "",
                "scene": prompt,
                "aspectRatio": "3:4",
            }
        )
        url = data.get("url")
        if not url:
            print(f"  失败: {data.get('reason')}")
            continue
        raw = urllib.request.urlopen(url, timeout=90).read()
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        # 立绘用 512 宽，和现有立绘一致
        h = round(im.height * 512 / im.width)
        im = im.resize((512, h), Image.LANCZOS)
        im.save(dest, "WEBP", quality=84, method=6)
        print(f"  完成 {os.path.getsize(dest) // 1024} KB -> {dest}")


if __name__ == "__main__":
    sys.exit(main())
