"""最小 CDP 客户端：一个持久 WebSocket 连接。

为什么必须持久：Emulation.setDeviceMetricsOverride 是**会话级**状态，
每次调用新开连接的话，覆盖会在连接关闭时失效 —— 视口永远停在默认尺寸。
"""

import base64
import json
import os
import socket
import struct
import time
import urllib.request


class CDP:
    def __init__(self, ws_url, timeout=30):
        assert ws_url.startswith("ws://")
        rest = ws_url[5:]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port)), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\n"
            f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        self._id = 0
        self._buf = b""

    # ---- 底层帧 ----

    def _send(self, payload):
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
        self.sock.sendall(bytes(header) + masked)

    def _recv_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("ws closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _recv(self):
        while True:
            head = self._recv_exact(2)
            opcode = head[0] & 0x0F
            length = head[1] & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(8))[0]
            payload = self._recv_exact(length)
            if opcode == 0x1:
                return payload.decode("utf-8", "replace")
            if opcode == 0x8:
                raise ConnectionError("ws closed by peer")

    # ---- 命令 ----

    def call(self, method, params=None, timeout=30):
        self._id += 1
        mid = self._id
        self._send({"id": mid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self._recv()
            try:
                data = json.loads(raw)
            except Exception:
                continue
            if data.get("id") == mid:
                return data
        raise TimeoutError(method)

    def eval(self, expr, timeout=30):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True}, timeout=timeout)
        try:
            return r["result"]["result"].get("value")
        except Exception:
            return None

    def wait_ready(self, min_len=20, tries=40, interval=0.25):
        for _ in range(tries):
            n = self.eval("document.body ? document.body.innerText.length : 0")
            if isinstance(n, (int, float)) and n > min_len:
                return True
            time.sleep(interval)
        return False

    def screenshot(self, path, from_surface=True):
        r = self.call("Page.captureScreenshot", {"format": "png", "fromSurface": from_surface})
        data = r["result"]["data"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        return os.path.getsize(path)

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def connect(chrome_path, port, user_data_dir, width=390, height=844, extra_args=None):
    """启动 headless Chrome 并返回 (proc, CDP)。"""
    import subprocess

    args = [
        chrome_path,
        f"--remote-debugging-port={port}",
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--hide-scrollbars",
        "--user-data-dir=" + user_data_dir,
        f"--window-size={width},{height}",
        "about:blank",
    ] + (extra_args or [])
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for _ in range(40):
        try:
            targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=5).read())
            page = next((t for t in targets if t.get("type") == "page"), None)
            if page:
                return proc, CDP(page["webSocketDebuggerUrl"])
        except Exception:
            pass
        time.sleep(0.25)
    proc.terminate()
    raise RuntimeError("chrome 没有起来")


def open_page(cdp_client, url, width=390, height=844, dpr=2, wait=3.0):
    """导航 + 设移动视口。顺序很重要：先导航，再设覆盖。"""
    cdp_client.call("Page.enable")
    cdp_client.call("Emulation.setDeviceMetricsOverride", {
        "width": width, "height": height, "deviceScaleFactor": dpr, "mobile": True,
        "screenWidth": width, "screenHeight": height,
    })
    cdp_client.call("Page.navigate", {"url": url})
    time.sleep(wait)
    cdp_client.wait_ready()
    return cdp_client
