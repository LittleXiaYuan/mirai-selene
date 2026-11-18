"""线上/本地多视图截图 + 每步断言，确保不是拍到重复页面。

用法：python deploy/shots.py [url]
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from cdp import connect, open_page  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9346
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5274/"
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "promo", "live"))
W, H = 390, 844


def by_text(c, text, exact=False):
    import json as js

    op = "===" if exact else ".includes"
    code = (
        "(() => {"
        "const b = [...document.querySelectorAll('button, [role=tab], a')]"
        f".find(x => (x.innerText||'').trim(){op}({js.dumps(text)}));"
        "if (!b) return 'NOTFOUND';"
        "b.click();"
        "return 'ok';"
        "})()"
    )
    return c.eval(code)


def by_aria(c, label):
    import json as js

    code = (
        "(() => {"
        f"const b = document.querySelector('[aria-label=' + {js.dumps(label)} + ']');"
        "if (!b) return 'NOTFOUND';"
        "b.click();"
        "return 'ok';"
        "})()"
    )
    return c.eval(code)


def main():
    os.makedirs(OUT, exist_ok=True)
    proc, c = connect(CHROME, PORT, os.path.join(os.environ.get("TEMP", "/tmp"), "mirai-shots3"), W, H)
    results = []
    try:
        open_page(c, URL, W, H)
        print(f"视口 {c.eval('innerWidth + \"x\" + innerHeight')}")

        def snap(name, expect=None):
            text = c.eval("document.body.innerText") or ""
            ok = expect is None or expect in text
            path = os.path.join(OUT, f"{name}.png")
            c.screenshot(path)
            mark = "OK" if ok else f"MISSING:{expect}"
            print(f"  {name}.png  {mark}")
            results.append(ok)
            return ok

        snap("1-home", "走进这个世界")

        print("  点击 走进这个世界:", by_text(c, "走进这个世界"))
        time.sleep(1.8)
        snap("2-stage", "这条世界线")

        print("  点击 记忆:", by_text(c, "记忆", exact=True))
        time.sleep(1.2)
        snap("3-memories", "她记得什么")

        print("  关闭抽屉:", c.eval("""(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === 'Close' || (x.getAttribute('aria-label')||'') === '关闭');
  if (!b) { document.querySelector('[data-state]')?.click(); return 'no-close-btn'; }
  b.click(); return 'ok';
})()"""))
        time.sleep(0.8)

        print("  点击 编辑这个世界:", by_aria(c, "编辑这个世界"))
        time.sleep(1.6)
        snap("4-edit", "每个人只要三件事")

        print("  切到 世界线:", by_text(c, "世界线", exact=True))
        time.sleep(1.2)
        snap("5-worldline", "起点")

        print("  切到 带走:", by_text(c, "带走", exact=True))
        time.sleep(1.2)
        snap("6-file", "导出的文件里装着整个世界")

        print("  回到世界列表:", by_aria(c, "回到世界列表"))
        time.sleep(1.4)
        print("  打开登录:", by_text(c, "登录"))
        time.sleep(1.6)
        snap("7-auth", "回到你的世界")

        print()
        print(f"{sum(results)}/{len(results)} 张截图符合预期")
        return 0 if all(results) else 1
    finally:
        c.close()
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
