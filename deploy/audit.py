"""量化界面审计：通过 Chrome DevTools Protocol 在真实页面里测量。

检查项（对应 Impeccable craft floor）：
  · 文字对比度（正文 4.5:1，大字 3:1）
  · 字号下限（<12px 报警）
  · 触摸目标（移动端 ≥44×44）
  · 横向溢出
  · 输入框字号（iOS 需要 ≥16px）

用法：python deploy/audit.py [url]
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9333
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5274/app.html"

MEASURE = r"""
(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
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

  const out = { contrast: [], tiny: [], smallTargets: [], inputs: [], overflow: null, counts: {} };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.textContent || "").trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const r = ratio(fg, bg);
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (r < need) {
      out.contrast.push({ text: text.slice(0, 26), ratio: Math.round(r * 100) / 100, need, size });
    }
  }

  document.querySelectorAll("body *").forEach((el) => {
    const t = (el.textContent || "").trim();
    if (!t || el.children.length) return;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (size && size < 12) out.tiny.push({ text: t.slice(0, 22), size });
  });

  document.querySelectorAll("button, a, input, textarea, select, [role=button], [role=tab], [role=treeitem]").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (r.height < 44 || r.width < 44) {
      out.smallTargets.push({
        tag: el.tagName,
        text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 20),
        w: Math.round(r.width), h: Math.round(r.height),
      });
    }
  });

  out.overflow = {
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  };

  document.querySelectorAll("input, textarea, select").forEach((el) => {
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 16) out.inputs.push({ tag: el.tagName, ph: el.getAttribute("placeholder") || "", size });
  });

  out.counts = {
    texts: seen.size,
    buttons: document.querySelectorAll("button, a, [role=button]").length,
  };

  const uniq = (arr, key) => {
    const m = new Map();
    for (const x of arr) if (!m.has(x[key])) m.set(x[key], x);
    return [...m.values()];
  };
  out.contrast = uniq(out.contrast, "text").slice(0, 10);
  out.tiny = uniq(out.tiny, "text").slice(0, 8);
  out.smallTargets = uniq(out.smallTargets, "text").slice(0, 10);
  out.inputs = uniq(out.inputs, "ph").slice(0, 5);

  return JSON.stringify(out);
})()
"""


def cdp(ws_url, method, params=None, session=None):
    """最小 CDP 客户端：只用 websocket 发一条命令读一条结果。"""
    import socket
    import base64
    import struct

    # 解析 ws://host:port/path
    assert ws_url.startswith("ws://")
    rest = ws_url[5:]
    hostport, _, path = rest.partition("/")
    host, _, port = hostport.partition(":")
    sock = socket.create_connection((host, int(port)), timeout=30)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\n"
        f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += sock.recv(4096)

    def send(payload):
        data = json.dumps(payload).encode()
        header = bytearray([0x81])
        length = len(data)
        mask = os.urandom(4)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        sock.sendall(bytes(header) + masked)

    def recv():
        while True:
            head = sock.recv(2)
            if len(head) < 2:
                return None
            b1, b2 = head[0], head[1]
            opcode = b1 & 0x0F
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack(">H", sock.recv(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", sock.recv(8))[0]
            payload = b""
            while len(payload) < length:
                chunk = sock.recv(length - len(payload))
                if not chunk:
                    return None
                payload += chunk
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")
            if opcode == 0x8:
                return None

    msg = {"id": 1, "method": method}
    if params:
        msg["params"] = params
    send(msg)
    sock.settimeout(30)
    for _ in range(60):
        raw = recv()
        if raw is None:
            break
        try:
            data = json.loads(raw)
        except Exception:
            continue
        if data.get("id") == 1:
            sock.close()
            return data
    sock.close()
    return None


def main():
    if not os.path.exists(CHROME):
        print("chrome not found", file=sys.stderr)
        return 2

    proc = subprocess.Popen(
        [
            CHROME,
            f"--remote-debugging-port={PORT}",
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--user-data-dir=" + os.path.join(os.environ.get("TEMP", "/tmp"), "mirai-audit-profile"),
            "--window-size=390,844",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        time.sleep(4)
        targets = json.loads(
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=10).read().decode()
        )
        page = next((t for t in targets if t.get("type") == "page"), None)
        if not page:
            print("no page target")
            return 3

        ws = page["webSocketDebuggerUrl"]
        cdp(ws, "Page.enable")
        cdp(ws, "Page.navigate", {"url": URL})

        # 等 React 渲染
        for _ in range(20):
            res = cdp(ws, "Runtime.evaluate", {"expression": "document.body.innerText.length", "returnByValue": True})
            try:
                n = res["result"]["result"]["value"]
            except Exception:
                n = 0
            if n and n > 20:
                break
            time.sleep(0.5)

        res = cdp(ws, "Runtime.evaluate", {"expression": MEASURE, "returnByValue": True, "awaitPromise": False})
        raw = res["result"]["result"]["value"]
        data = json.loads(raw)

        print("=" * 52)
        print("界面量化审计 ·", URL)
        print("=" * 52)

        c = data["counts"]
        print(f"\n扫描到 {c['texts']} 段文字、{c['buttons']} 个可交互元素\n")

        print(f"--- 对比度 ---")
        if data["contrast"]:
            print(f"  {len(data['contrast'])} 处不达标：")
            for x in data["contrast"]:
                print(f"    {x['ratio']:>5.2f}:1 (需 {x['need']}) {x['size']:.0f}px  「{x['text']}」")
        else:
            print("  全部达标")

        print(f"\n--- 字号 < 12px ---")
        if data["tiny"]:
            for x in data["tiny"]:
                print(f"    {x['size']}px  「{x['text']}」")
        else:
            print("  没有")

        print(f"\n--- 触摸目标 < 44px ---")
        if data["smallTargets"]:
            for x in data["smallTargets"]:
                print(f"    {x['w']}×{x['h']}  {x['tag']}  「{x['text']}」")
        else:
            print("  全部达标")

        print(f"\n--- 输入框字号 < 16px（iOS 会放大）---")
        if data["inputs"]:
            for x in data["inputs"]:
                print(f"    {x['size']}px  {x['tag']}  「{x['ph']}」")
        else:
            print("  没有")

        o = data["overflow"]
        print(f"\n--- 横向溢出 ---")
        print(f"  scrollWidth {o['scrollW']} vs clientWidth {o['clientW']}  "
              + ("OK" if o["scrollW"] <= o["clientW"] + 1 else "溢出！"))

        print()
        return 0
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
