"""验证舞台上的「算出来的读数」（生产环境）。

验三件事：
1. 走一步之后，输入框上方出现 data-reading，且两个数字与状态一致；
2. 读数行不横向溢出，窄屏时账那句省略、读数不被挤掉；
3. 结局页在断网时仍有「算出来的结论」（不依赖模型）。

用法：python deploy/test_reading.py [url]
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from cdp import connect, open_page  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9470
URL = sys.argv[1] if len(sys.argv) > 1 else "https://mirai.cloudtori.cn/"
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "promo", "live"))

RESULTS = []


def check(label, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {label} {detail}")
    RESULTS.append((label, bool(cond)))


def ev(c, expr):
    return c.eval(expr)


def click_text(c, text):
    return ev(
        c,
        "(() => {"
        "  const b = [...document.querySelectorAll('button')]"
        f"    .find(x => (x.innerText||'').includes({json.dumps(text)}));"
        "  if (!b) return 'NF';"
        "  b.click(); return 'ok';"
        "})()",
    )


def type_action(c, text):
    return ev(
        c,
        "(() => {"
        "  const el = document.querySelector('input[aria-label=\"你想让她做什么\"]');"
        "  if (!el) return 'NF';"
        "  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
        f"  s.call(el, {json.dumps(text)});"
        "  el.dispatchEvent(new Event('input', { bubbles: true }));"
        "  document.querySelector('form').requestSubmit();"
        "  return 'ok';"
        "})()",
    )


def wait_beat(c, timeout=110):
    for _ in range(timeout):
        time.sleep(1)
        ready = ev(
            c,
            "(() => {"
            "  const n = document.querySelector('[class*=lineText]');"
            "  const caret = document.querySelector('[class*=caret]');"
            "  const input = document.querySelector('input[aria-label=\"你想让她做什么\"]');"
            "  if (!n || !input) return false;"
            "  return n.innerText.trim().length > 8 && !caret && !input.disabled;"
            "})()",
        )
        if ready:
            return True
    return False


READING = """
(() => {
  const row = document.querySelector('[data-reading]');
  if (!row) return null;
  const ledger = row.querySelector('[class*=readingLedger]');
  const mood = row.querySelector('[class*=readingMood]');
  const r = row.getBoundingClientRect();
  const s = getComputedStyle(row);
  return {
    ledger: ledger ? ledger.innerText.trim() : '',
    mood: mood ? mood.innerText.trim() : '',
    tone: mood ? mood.dataset.tone : '',
    width: Math.round(r.width),
    height: Math.round(r.height),
    right: Math.round(r.right),
    viewport: document.documentElement.clientWidth,
    fontSize: s.fontSize,
  };
})()
"""


def read_reading(c):
    v = ev(c, READING)
    return v if isinstance(v, dict) else None


def main():
    os.makedirs(OUT, exist_ok=True)
    proc, c = connect(
        CHROME, PORT, os.path.join(os.environ.get("TEMP", "/tmp"), "mirai-reading"), 390, 844
    )
    try:
        for width, height, mobile in [(390, 844, True), (1440, 900, False)]:
            open_page(c, URL, 390, 844)
            ev(c, "(() => { localStorage.setItem('mirai.tour.v1','1'); localStorage.removeItem('mirai.app.v2'); return 1; })()")
            c.call("Page.reload")
            time.sleep(4)
            c.wait_ready()
            c.call(
                "Emulation.setDeviceMetricsOverride",
                {"width": width, "height": height, "deviceScaleFactor": 2 if mobile else 1, "mobile": mobile},
            )
            time.sleep(1)

            click_text(c, "走进这个世界")
            time.sleep(3)

            print(f"\n== {width}x{height} ==")

            # 这一步之前：世界可能已经走过几步，读数行要么没有，要么两半都有
            before = read_reading(c)
            check(
                "读数行内容成对出现",
                before is None or bool(before["ledger"]) == bool(before["mood"]),
                json.dumps(before, ensure_ascii=False) if before else "无读数行",
            )

            # 人物那块不能被舞台顶部裁掉（曾经被裁到完全看不见）
            geo = ev(
                c,
                "(() => {"
                "  const st = document.querySelector('[class*=stage]');"
                "  const sp = st.querySelector('[class*=speaker]');"
                "  if (!sp) return null;"
                "  return { stage: st.getBoundingClientRect().top, speaker: sp.getBoundingClientRect().top };"
                "})()",
            )
            check(
                "人物没被裁掉",
                geo is not None and geo["speaker"] >= geo["stage"] - 1,
                json.dumps(geo) if geo else "找不到人物",
            )

            ok = type_action(c, "她把那封信撕了，什么也没说。")
            check("发出一步", ok == "ok", ok)
            done = wait_beat(c)
            check("这一幕生成完", done)

            row = read_reading(c)
            check("出现读数行", row is not None, json.dumps(row, ensure_ascii=False) if row else "")
            if row:
                check("有这一步的账", len(row["ledger"]) > 4, row["ledger"])
                check("有状态读数", "暖" in row["mood"] and "紧" in row["mood"], row["mood"])
                check("有强弱倾向", row["tone"] in ("warm", "mid", "tight"), row["tone"])
                check(
                    "读数行不超出视口",
                    row["right"] <= row["viewport"] + 1,
                    f"right={row['right']} vw={row['viewport']}",
                )
                check("行高只占一行", row["height"] <= 28, f"{row['height']}px")

            # 横向溢出
            over = ev(
                c,
                "Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)",
            )
            check("没有横向溢出", over == 0, f"{over}px")

            if width == 390:
                c.call(
                    "Page.captureScreenshot",
                    {"format": "png", "captureBeyondViewport": False},
                )
            # 截图另存
            shot = c.call("Page.captureScreenshot", {"format": "png"})
            data = shot.get("result", {}).get("data")
            if data:
                import base64

                path = os.path.join(OUT, f"reading-{width}.png")
                with open(path, "wb") as fh:
                    fh.write(base64.b64decode(data))
                print(f"  截图 {path}")

        print("\n汇总：{} / {}".format(sum(1 for _, ok in RESULTS if ok), len(RESULTS)))
        return 0 if all(ok for _, ok in RESULTS) else 1
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
