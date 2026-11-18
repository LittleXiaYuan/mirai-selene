"""自动推演之后，画面是否稳定？（用来区分产品问题与测试时序）"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from cdp import connect, open_page  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
URL = sys.argv[1] if len(sys.argv) > 1 else "https://mirai.cloudtori.cn/"

FP = """
(() => {
  const pts = [[0.18,0.12],[0.42,0.08],[0.66,0.16],[0.86,0.1],[0.3,0.3],
               [0.58,0.34],[0.78,0.28],[0.12,0.44],[0.5,0.48],[0.9,0.42]];
  const cv = document.querySelector('canvas');
  if (!cv) return 'nocanvas';
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
})()
"""


def main():
    proc, c = connect(CHROME, 9530, os.path.join(os.environ.get("TEMP", "/tmp"), "stability"), 390, 844)
    try:
        open_page(c, URL, 390, 844)
        c.eval("(() => { localStorage.setItem('mirai.tour.v1','1'); localStorage.removeItem('mirai.app.v2'); return 1; })()")
        c.call("Page.reload")
        time.sleep(4)
        c.wait_ready()
        c.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
        time.sleep(1)

        c.eval("(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').includes('走进这个世界')); if (b) b.click(); return 1; })()")
        time.sleep(3)

        # 走一幕（人工）
        c.eval(
            "(() => { const el = document.querySelector('input[aria-label=\"你想让她做什么\"]');"
            "const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
            "s.call(el, '她站起来'); el.dispatchEvent(new Event('input', { bubbles: true }));"
            "document.querySelector('form').requestSubmit(); return 1; })()"
        )
        for _ in range(90):
            time.sleep(1)
            if c.eval("(() => { const c = document.querySelector('[class*=caret]'); return !c && (document.body.innerText||'').length > 200; })()"):
                break
        print("人工一幕完成")

        # 连读 6 次，间隔 3 秒
        readings = []
        for i in range(6):
            readings.append(c.eval(FP))
            print(f"  t+{i * 3}s: {readings[-1]}")
            time.sleep(3)

        unique = set(readings)
        print(f"\n不同取值数: {len(unique)} → {'稳定' if len(unique) == 1 else '画面在变'}")

        # 再跑自动推演，看完之后是否稳定
        c.eval("(() => { const b = document.querySelector('[aria-label=\"自动推演三幕\"]'); if (b) b.click(); return 1; })()")
        for _ in range(90):
            time.sleep(2)
            p = c.eval("(() => { const e = document.querySelector('[class*=autoProgress]'); return e ? e.innerText : 'none'; })()")
            if p and p.replace(" ", "").startswith("3/"):
                break
        print("\n自动推演完成，冷却 8 秒后连读：")
        time.sleep(8)
        after = []
        for i in range(5):
            after.append(c.eval(FP))
            print(f"  t+{i * 3}s: {after[-1]}")
            time.sleep(3)
        uniq2 = set(after)
        print(f"不同取值数: {len(uniq2)} → {'稳定' if len(uniq2) == 1 else '画面在变'}")
        return 0
    finally:
        c.close()
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
