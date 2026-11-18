"""验证并行世界线、自动推演、合并预演（生产环境）。

用真实浏览器，按真实 DOM 定位。
用法：python deploy/test_lanes.py [url]
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from cdp import CDP, connect, open_page  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9460
URL = sys.argv[1] if len(sys.argv) > 1 else "https://mirai.cloudtori.cn/"
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "promo", "live"))
W, H = 390, 844

RESULTS = []

# 轮询到画面稳定：连续 4 次读到同一个值才算定住
STABLE_FP = """
new Promise((resolve) => {
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
    return acc.toString(16).padStart(8, '0').slice(0, 6);
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


def stable_fp(c, label=""):
    """轮询到画面稳定（连续 4 次同值）再取值。"""
    r = c.call("Runtime.evaluate", {"expression": STABLE_FP, "awaitPromise": True, "returnByValue": True})
    return r.get("result", {}).get("result", {}).get("value")


def wait_visual_settle(c, timeout=20):
    """等价于 stable_fp，只等不留值。生成刚结束时插值还没走完。"""
    stable_fp(c)
    return True


def check(label, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {label} {detail}")
    RESULTS.append((label, cond))


def ev(c, expr, await_promise=False):
    if await_promise:
        r = c.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        return r.get("result", {}).get("result", {}).get("value")
    return c.eval(expr)


def click(c, aria):
    return c.eval(
        "(() => {"
        f"  const b = document.querySelector('[aria-label=' + {json.dumps(aria)} + ']');"
        "  if (!b) return 'NF';"
        "  b.click(); return 'ok';"
        "})()"
    )


def click_text(c, text):
    return c.eval(
        "(() => {"
        "  const b = [...document.querySelectorAll('button')]"
        f"    .find(x => (x.innerText||'').includes({json.dumps(text)}));"
        "  if (!b) return 'NF';"
        "  b.click(); return 'ok';"
        "})()"
    )


def type_action(c, text):
    return c.eval(
        "(() => {"
        "  const el = document.querySelector('input[aria-label=\"你想让她做什么\"]');"
        "  if (!el) return 'NF';"
        "  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
        f"  s.call(el, {json.dumps(text)});"
        "  el.dispatchEvent(new Event('input', { bubbles: true }));"
        "  document.querySelector('form').requestSubmit();"
        "  return 'ok';"
        "})()"
    )


def wait_beat(c, timeout=110):
    """等到这一句不再「正在生成」。

    切句之后一屏只有一句（约 20-40 字），所以不能按整段长度判断；
    改看：光标停了 + 有句数标记 + 输入框重新可用。
    """
    for _ in range(timeout):
        time.sleep(1)
        ready = c.eval(
            "(() => {"
            "  const n = document.querySelector('[class*=lineText]');"
            "  const caret = document.querySelector('[class*=caret]');"
            "  const input = document.querySelector('input[aria-label=\"你想让她做什么\"]');"
            "  if (!n || !input) return false;"
            "  return n.innerText.trim().length > 8 && !caret && !input.disabled;"
            "})()"
        )
        if ready:
            return True
    return False


def lane_labels(c):
    v = c.eval("JSON.stringify([...document.querySelectorAll('[data-lane]')].map(x => x.innerText.replace(/\\n/g,' ').trim()))")
    try:
        return json.loads(v)
    except Exception:
        return []


def main():
    os.makedirs(OUT, exist_ok=True)
    proc, c = connect(CHROME, PORT, os.path.join(os.environ.get("TEMP", "/tmp"), "mirai-lanes"), W, H)
    try:
        open_page(c, URL, W, H)
        c.eval("(() => { localStorage.setItem('mirai.tour.v1','1'); localStorage.removeItem('mirai.app.v2'); return 1; })()")
        c.call("Page.reload")
        time.sleep(4)
        c.wait_ready()
        c.call("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": 2, "mobile": True})
        time.sleep(1)

        click_text(c, "走进这个世界")
        time.sleep(3)

        body = c.eval("document.body.innerText") or ""
        check("并行面板存在", "同时看几条线" in body)
        check("自动推演入口存在", "让世界自己走几幕" in body)
        check("起始只有一条线", len(lane_labels(c)) == 1, f"{lane_labels(c)}")

        base_nodes = int(c.eval("Object.keys(JSON.parse(localStorage.getItem('mirai.app.v2'))[0].tree.nodes).length") or 0)

        # --- 开一条新线 ---
        c.eval(
            "(() => { const el = document.querySelector('input[placeholder*=\"留空就自动命名\"]');"
            "if (!el) return 'NF';"
            "const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
            "s.call(el, '如果她留下'); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()"
        )
        time.sleep(0.5)
        check("点开新线", click(c, "从这一步开一条新线") == "ok")
        time.sleep(1.5)
        lanes = lane_labels(c)
        check("变成两条线", len(lanes) == 2, f"{lanes}")
        check("新线有名字", any("如果她留下" in x for x in lanes), f"{lanes}")

        # --- 在新线上写一幕 ---
        check("在新线写一幕", type_action(c, "她拒绝了那份 offer") == "ok")
        check("这一幕生成成功", wait_beat(c))
        # 生成结束不等于画面到位：插值还要约 1 秒
        wait_visual_settle(c)
        time.sleep(1)
        lanes2 = lane_labels(c)
        check("两条线步数可分别看到", len(lanes2) == 2, f"{lanes2}")
        c.screenshot(os.path.join(OUT, "lanes-parallel.png"))

        # --- 合并预演 ---
        check("打开合并选择器", c.eval(
            "(() => { const b = document.querySelector('[role=combobox], button[aria-haspopup]');"
            "if (!b) return 'NF'; b.click(); return 'ok'; })()"
        ) == "ok")
        time.sleep(1)
        opts = c.eval("JSON.stringify([...document.querySelectorAll('[role=option]')].map(o => o.innerText.trim()))")
        check("有可选的线", opts and opts != "[]", str(opts)[:80])
        # 选第一个非空选项
        picked = c.eval(
            "(() => { const o = [...document.querySelectorAll('[role=option]')]"
            ".find(x => x.innerText && !x.innerText.includes('选一条'));"
            "if (!o) return 'NF'; o.click(); return o.innerText.trim(); })()"
        )
        check("选中一条线", picked != "NF", str(picked)[:30])
        time.sleep(0.8)

        check("点预演", click(c, "预演合并结果") == "ok")
        time.sleep(2)
        after = c.eval("document.body.innerText") or ""
        check("预演给出结论", ("接得上" in after) or ("接不上" in after))
        check("预演说清共同起点", "共同起点是" in after)
        check("预演列出条目", ("相加" in after) or ("新增" in after) or ("拒绝" in after) or ("收起" in after))
        c.screenshot(os.path.join(OUT, "lanes-merge.png"))

        # --- 自动推演 ---
        click(c, "自动推演三幕")
        ok_auto = False
        for _ in range(60):
            time.sleep(2)
            p = c.eval("(() => { const e = document.querySelector('[class*=autoProgress]'); return e ? e.innerText : 'none'; })()")
            if p and p.replace(" ", "").startswith("3/"):
                ok_auto = True
                break
        check("自动推演走满三幕", ok_auto)

        nodes_now = int(c.eval("Object.keys(JSON.parse(localStorage.getItem('mirai.app.v2'))[0].tree.nodes).length") or 0)
        check("自动推演落成节点", nodes_now >= base_nodes + 3, f"{base_nodes} → {nodes_now}")
        c.screenshot(os.path.join(OUT, "lanes-auto.png"))

        # --- 指纹仍可复现 ---
        # 用轮询到稳定再取，而不是读 UI 上那个值：
        # UI 有自己的取样时机，测试去追它会变成在测时序。
        # 从 DOM 读当前停在哪个节点（localStorage 可能还没落盘）
        cur = c.eval("(() => { const e = document.querySelector('[aria-current=step]');"
                     "return e ? e.getAttribute('data-stop') : 'none'; })()")
        # 先走到别处再回来，否则点击当前节点是空操作，测不出东西
        c.eval("(() => { const s = [...document.querySelectorAll('[data-stop]')];"
               "if (s.length) s[0].click(); return 'ok'; })()")
        time.sleep(1)
        stable_fp(c, "先走到起点")
        c.eval(
            "(() => { const t = " + json.dumps(cur) + ";"
            "const s = [...document.querySelectorAll('[data-stop]')].find(x => x.getAttribute('data-stop') === t);"
            "if (!s) return 'NF'; s.click(); return 'ok'; })()"
        )
        time.sleep(1)
        fp_back = stable_fp(c, "第一次回到该节点")
        c.eval("(() => { const s = [...document.querySelectorAll('[data-stop]')];"
               "if (s.length) s[s.length - 1].click(); return 'ok'; })()")
        time.sleep(1)
        stable_fp(c, "再走开")
        c.eval(
            "(() => { const t = " + json.dumps(cur) + ";"
            "const s = [...document.querySelectorAll('[data-stop]')].find(x => x.getAttribute('data-stop') === t);"
            "if (s) s.click(); return 'ok'; })()"
        )
        time.sleep(1)
        fp_again = stable_fp(c, "第二次回到该节点")
        check("同一节点两次画面一致", fp_back == fp_again and fp_back != "none", f"{fp_back} / {fp_again}")

        print()
        passed = sum(1 for _, ok in RESULTS if ok)
        print(f"{passed}/{len(RESULTS)} 通过")
        for label, ok in RESULTS:
            if not ok:
                print(f"  未通过: {label}")
        return 0 if passed == len(RESULTS) else 1
    finally:
        c.close()
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
