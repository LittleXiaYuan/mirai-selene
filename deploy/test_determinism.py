"""验证渲染的确定性：同一节点，两次取到同一帧。

不看 UI 的指纹显示（它有自己的取样时机），而是在页面里
轮询 canvas 直到连续 4 次读到同一个值，再比对。

用法：python deploy/test_determinism.py [url]
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from cdp import connect, open_page  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9461
URL = sys.argv[1] if len(sys.argv) > 1 else "https://mirai.cloudtori.cn/"
W, H = 390, 844

# 在页面里轮询到稳定：连续 4 次相同才算定住
STABLE_FP = """
new Promise((resolve) => {
  window.__fpPoll = window.__fpPoll || 0;
  const pts = [[0.18,0.12],[0.42,0.08],[0.66,0.16],[0.86,0.1],[0.3,0.3],
               [0.58,0.34],[0.78,0.28],[0.12,0.44],[0.5,0.48],[0.9,0.42]];
  const read = () => {
    const cv = document.querySelector('canvas');
    if (!cv) return null;
    const ctx = cv.getContext('2d');
    let acc = 0x811c9dc5;
    for (const [fx, fy] of pts) {
      const x = Math.min(cv.width - 1, Math.round(cv.width * fx));
      const y = Math.min(cv.height - 1, Math.round(cv.height * fy));
      const d = ctx.getImageData(x, y, 1, 1).data;
      const q = ((d[0] >> 4) << 8) | ((d[1] >> 4) << 4) | (d[2] >> 4);
      acc ^= q; acc = Math.imul(acc, 0x01000193) >>> 0;
    }
    return acc.toString(16).padStart(8, '0').slice(0, 6) + '@' + cv.width + 'x' + cv.height;
  };
  let last = '', stable = 0, ticks = 0;
  const tick = () => {
    ticks++;
    const v = read();
    if (v) {
      if (v === last) stable++; else { last = v; stable = 0; }
      if (stable >= 4 || ticks > 60) return resolve(last);
    }
    setTimeout(tick, 120);
  };
  tick();
})
"""


def stable_fp(c, label):
    v = c.call("Runtime.evaluate", {"expression": STABLE_FP, "awaitPromise": True, "returnByValue": True})
    val = v.get("result", {}).get("result", {}).get("value")
    print(f"  {label}: {val}")
    return val


def main():
    proc, c = connect(CHROME, PORT, os.path.join(os.environ.get("TEMP", "/tmp"), "mirai-det"), W, H)
    results = []
    try:
        open_page(c, URL, W, H)
        c.eval("(() => { localStorage.setItem('mirai.tour.v1','1'); localStorage.removeItem('mirai.app.v2'); return 1; })()")
        c.call("Page.reload")
        time.sleep(4)
        c.wait_ready()
        c.call("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": 2, "mobile": True})
        time.sleep(1)

        c.eval("(() => { const b = [...document.querySelectorAll('button')].find(x=>(x.innerText||'').includes('走进这个世界')); if (b) b.click(); return 1; })()")
        time.sleep(3)

        cur = c.eval("JSON.parse(localStorage.getItem('mirai.app.v2'))[0].cursor")
        print(f"节点 A = {cur}")
        fp1 = stable_fp(c, "第一次停在 A")

        # 走两幕
        for i, act in enumerate(["她走到窗边", "她拿起那封信"]):
            c.eval(
                "(() => { const el = document.querySelector('input[aria-label=\"你想让她做什么\"]');"
                "const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
                f"s.call(el, {json.dumps(act)}); el.dispatchEvent(new Event('input', {{bubbles:true}}));"
                "document.querySelector('form').requestSubmit(); return 1; })()"
            )
            for _ in range(60):
                time.sleep(1)
                if c.eval("(() => { const n = document.querySelector('[class*=lineText]');"
                          "return Boolean(n && n.innerText.length > 70 && !document.querySelector('[class*=caret]')); })()"):
                    break
            time.sleep(2)
            print(f"  第 {i + 1} 幕: {c.eval('(()=>document.querySelector(\"[class*=speakerRole]\").innerText)()')}")

        fp2 = stable_fp(c, "走过两幕后")
        results.append(("两幕之间画面不同", fp1 != fp2, f"{fp1} vs {fp2}"))

        # 精确回到 A
        c.eval(
            "(() => { const t = " + json.dumps(cur) + ";"
            "const s = [...document.querySelectorAll('[data-stop]')].find(x => x.getAttribute('data-stop') === t);"
            "if (!s) return 'NF'; s.click(); return 'ok'; })()"
        )
        time.sleep(2)
        fp3 = stable_fp(c, "回到 A")
        results.append(("回到 A 与首次相同", fp1 == fp3, f"{fp1} vs {fp3}"))

        # 再走开再回来一次，确认不是巧合
        c.eval(
            "(() => { const s = [...document.querySelectorAll('[data-stop]')];"
            "if (s.length) s[s.length - 1].click(); return 'ok'; })()"
        )
        time.sleep(2.5)
        stable_fp(c, "走到末节点")
        c.eval(
            "(() => { const t = " + json.dumps(cur) + ";"
            "const s = [...document.querySelectorAll('[data-stop]')].find(x => x.getAttribute('data-stop') === t);"
            "if (s) s.click(); return 'ok'; })()"
        )
        time.sleep(2)
        fp4 = stable_fp(c, "第二次回到 A")
        results.append(("第二次回到 A 仍相同", fp1 == fp4, f"{fp1} vs {fp4}"))

        # 节点数不应因为回退而增加
        nodes = c.eval("Object.keys(JSON.parse(localStorage.getItem('mirai.app.v2'))[0].tree.nodes).length")
        results.append(("回退不产生新节点", int(nodes) == 13, f"nodes={nodes}"))

        print()
        passed = sum(1 for _, ok, _ in results if ok)
        for label, ok, detail in results:
            print(f"  [{'PASS' if ok else 'FAIL'}] {label} {detail}")
        print(f"\n{passed}/{len(results)} 通过")
        return 0 if passed == len(results) else 1
    finally:
        c.close()
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
