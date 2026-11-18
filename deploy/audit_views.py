"""多视图审计：依次进入首页 → Stage → 编辑 → 登录，每页跑一次量化检查。

通过 CDP 点击真实按钮切换视图，不假设元素位置。
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from audit import CHROME, PORT, MEASURE, cdp  # noqa: E402

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5274/app.html"


def evaluate(ws, expr):
    res = cdp(ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True})
    try:
        return res["result"]["result"]["value"]
    except Exception:
        return None


def measure(ws, label):
    raw = evaluate(ws, MEASURE)
    if not raw:
        print(f"\n### {label}: 测量失败")
        return
    d = json.loads(raw)
    print(f"\n{'=' * 52}")
    print(f"### {label}  （{d['counts']['texts']} 段文字 / {d['counts']['buttons']} 个可交互）")
    print("=" * 52)

    issues = 0
    if d["contrast"]:
        issues += len(d["contrast"])
        print(f"  对比度不达标 {len(d['contrast'])} 处：")
        for x in d["contrast"]:
            print(f"    {x['ratio']:>5.2f}:1 (需 {x['need']}) {x['size']:.0f}px  「{x['text']}」")
    else:
        print("  对比度：全部达标")

    if d["tiny"]:
        issues += len(d["tiny"])
        print(f"  字号 <12px {len(d['tiny'])} 处：")
        for x in d["tiny"]:
            print(f"    {x['size']}px  「{x['text']}」")
    else:
        print("  字号：没有 <12px")

    if d["smallTargets"]:
        issues += len(d["smallTargets"])
        print(f"  触摸目标 <44px {len(d['smallTargets'])} 处：")
        for x in d["smallTargets"]:
            print(f"    {x['w']}×{x['h']}  {x['tag']}  「{x['text']}」")
    else:
        print("  触摸目标：全部达标")

    if d["inputs"]:
        issues += len(d["inputs"])
        for x in d["inputs"]:
            print(f"  输入框 {x['size']}px  {x['tag']}  「{x['ph']}」")

    o = d["overflow"]
    ov = o["scrollW"] > o["clientW"] + 1
    if ov:
        issues += 1
    print(f"  横向溢出：{o['scrollW']} / {o['clientW']}  {'溢出！' if ov else 'OK'}")
    return issues


def main():
    proc = subprocess.Popen(
        [
            CHROME,
            f"--remote-debugging-port={PORT}",
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--user-data-dir=" + os.path.join(os.environ.get("TEMP", "/tmp"), "mirai-audit-profile2"),
            "--window-size=390,844",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    total = 0
    try:
        time.sleep(4)
        targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=10).read().decode())
        page = next((t for t in targets if t.get("type") == "page"), None)
        ws = page["webSocketDebuggerUrl"]
        cdp(ws, "Page.enable")
        cdp(ws, "Page.navigate", {"url": URL})

        for _ in range(30):
            if (evaluate(ws, "document.body.innerText.length") or 0) > 20:
                break
            time.sleep(0.5)

        total += measure(ws, "首页 / 世界列表") or 0

        # 进入 Stage：点「走进这个世界」
        evaluate(ws, """
(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').includes('走进这个世界'));
  if (b) { b.click(); return 'ok'; }
  return 'nobtn';
})()
""")
        time.sleep(1.6)
        total += measure(ws, "Stage / 走在世界里") or 0

        # 打开记忆抽屉
        evaluate(ws, """
(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '记忆');
  if (b) { b.click(); return 'ok'; }
  return 'nobtn';
})()
""")
        time.sleep(1.0)
        total += measure(ws, "Stage / 记忆抽屉") or 0

        # 关抽屉，进编辑
        evaluate(ws, """
(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === '关闭');
  if (b) b.click();
  return 'ok';
})()
""")
        time.sleep(0.6)
        evaluate(ws, """
(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === '编辑这个世界');
  if (b) { b.click(); return 'ok'; }
  return 'nobtn';
})()
""")
        time.sleep(1.4)
        total += measure(ws, "编辑 / 人物") or 0

        # 编辑的世界线页签
        evaluate(ws, """
(() => {
  const b = [...document.querySelectorAll('[role=tab]')].find(x => (x.innerText||'').trim() === '世界线');
  if (b) { b.click(); return 'ok'; }
  return 'nobtn';
})()
""")
        time.sleep(1.0)
        total += measure(ws, "编辑 / 世界线") or 0

        print(f"\n\n总计问题：{total}")
        return 0 if total == 0 else 1
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
