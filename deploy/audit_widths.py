"""按 Arc 规范在 390 / 768 / 1024 / 1440 四个宽度下验证。

每个宽度检查：横向溢出、文字裁切、触摸目标、对比度。
桌面宽度额外确认两栏布局真的生效（不是手机布局居中）。

用法：python deploy/audit_widths.py [url]
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from cdp import CDP, connect  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9350
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5274/"
WIDTHS = [390, 768, 1024, 1440]
HEIGHT = 900

PROBE = r"""
(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const bgOf = (el) => {
    let p = el;
    while (p && p !== document.documentElement) {
      const c = parse(getComputedStyle(p).backgroundColor);
      if (c && c.a > 0.85) return c;
      p = p.parentElement;
    }
    return { r: 10, g: 11, b: 16, a: 1 };
  };

  const out = { contrast: 0, tinyTargets: [], clipped: [], overflowX: 0, wide: 0, cols: 0 };

  // 横向溢出
  out.overflowX = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // 文字裁切：元素宽度小于自身内容且没有省略号
  document.querySelectorAll('h1,h2,h3,p,span,a,button').forEach((el) => {
    if (!el.getClientRects().length) return;
    // sr-only 是给读屏用的，故意裁切，不算问题
    if (el.closest('.srOnly, [class*=srOnly], [class*=sr-only]')) return;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'hidden' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) {
      out.clipped.push((el.innerText || '').trim().slice(0, 24));
    }
  });

  // 触摸目标（只在窄屏判定）
  if (window.innerWidth < 1024) {
    document.querySelectorAll('button, a, input, select, textarea, [role=button]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (r.height < 44) {
        out.tinyTargets.push((el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 20) + ` ${Math.round(r.height)}px`);
      }
    });
  }

  // 对比度
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let n;
  while ((n = walker.nextNode())) {
    const t = (n.textContent || '').trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    if (ratio(fg, bgOf(el)) < (large ? 3 : 4.5)) out.contrast += 1;
  }

  // 桌面是否真的两栏
  const shell = document.querySelector('[class*=shell]');
  if (shell) {
    const cs = getComputedStyle(shell);
    const tracks = (cs.gridTemplateColumns || '').split(' ').filter(Boolean);
    out.cols = tracks.length;
    out.wide = Math.round(shell.getBoundingClientRect().width);
  }

  out.tinyTargets = [...new Set(out.tinyTargets)].slice(0, 6);
  out.clipped = [...new Set(out.clipped)].slice(0, 6);
  return JSON.stringify(out);
})()
"""


def main():
    proc, c = connect(CHROME, PORT, os.path.join(os.environ.get("TEMP", "/tmp"), "mirai-widths"), WIDTHS[0], HEIGHT)
    bad = 0
    try:
        c.call("Page.enable")
        c.call("Page.navigate", {"url": URL})
        time.sleep(3)
        c.wait_ready()

        # 两栏布局只在 Stage 里，所以先进去
        c.eval(
            "(() => { const b = [...document.querySelectorAll('button')]"
            ".find(x => (x.innerText||'').includes('走进这个世界')); if (b) b.click(); return 1; })()"
        )
        time.sleep(2)

        for w in WIDTHS:
            c.call(
                "Emulation.setDeviceMetricsOverride",
                {"width": w, "height": HEIGHT, "deviceScaleFactor": 1, "mobile": w < 768},
            )
            time.sleep(1.0)
            raw = c.eval(PROBE)
            if not raw:
                print(f"{w}px: 探测失败")
                bad += 1
                continue
            d = json.loads(raw)
            problems = []
            if d["overflowX"] > 0:
                problems.append(f"横向溢出 {d['overflowX']}px")
            if d["contrast"]:
                problems.append(f"对比度 {d['contrast']} 处")
            if d["tinyTargets"]:
                problems.append("触摸目标 " + "、".join(d["tinyTargets"]))
            if d["clipped"]:
                problems.append("文字裁切 " + "、".join(d["clipped"]))

            layout = f"栏数 {d['cols']} / 宽 {d['wide']}px"
            if w >= 1024 and d["cols"] < 2:
                problems.append("桌面仍是单栏")

            status = "OK" if not problems else " / ".join(problems)
            if problems:
                bad += 1
            print(f"{w:>4}px  {layout:<22} {status}")

        print()
        print("全部通过" if bad == 0 else f"{bad} 个宽度有问题")
        return 0 if bad == 0 else 1
    finally:
        c.close()
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
