"""部署到阿里云服务器：YOUR_SERVER_IP。

架构：
    CDN (120.220.39.x, *.cloudtori.cn 通配证书终止 TLS)
      → 源站 :80 (Node，本脚本部署)

为什么不用 nginx：CDN 已经处理 TLS 和静态缓存，
源站只需要一个进程同时提供静态文件和 API。少一个组件少一个挂点。

用法：
    MIRAI_PASS=... python deploy/deploy.py
    MIRAI_PASS=... MINIMAX_KEY=... MIRAI_DOMAIN=mirai.cloudtori.cn python deploy/deploy.py
"""

import io
import os
import posixpath
import sys
import tarfile
import time

import paramiko

HOST = os.environ.get("MIRAI_HOST", "YOUR_SERVER_IP")
USER = os.environ.get("MIRAI_USER", "root")
PASS = os.environ.get("MIRAI_PASS", "")
MINIMAX_KEY = os.environ.get("MINIMAX_KEY", "")
DOMAIN = os.environ.get("MIRAI_DOMAIN", "mirai.cloudtori.cn")
PORT = os.environ.get("MIRAI_PORT", "80")

LOCAL = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app"))
REMOTE = "/opt/mirai"

UNIT = """[Unit]
Description=Mirai-Selene (static + API + LLM proxy)
After=network.target

[Service]
Type=simple
WorkingDirectory={remote}
EnvironmentFile={remote}/.env
ExecStart=/usr/bin/node {remote}/server/serve.mjs
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
# 安全加固：只给必要的能力
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
"""


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, 22, USER, PASS, timeout=25)
    return c


def sh(c, cmd, timeout=180, quiet=False):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    if not quiet:
        if out.strip():
            print(out.rstrip())
        if err.strip():
            print("[err]", err.rstrip()[:800])
    return code, out, err


def pack_dist():
    """把 dist 和 server 打成 tar（排除 node_modules / 源文件）。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        dist = os.path.join(LOCAL, "dist")
        for root, _dirs, files in os.walk(dist):
            for f in files:
                full = os.path.join(root, f)
                tar.add(full, arcname=posixpath.join("dist", os.path.relpath(full, dist)))
        server = os.path.join(LOCAL, "server")
        for root, _dirs, files in os.walk(server):
            for f in files:
                if not f.endswith(".mjs"):
                    continue
                full = os.path.join(root, f)
                tar.add(full, arcname=posixpath.join("server", os.path.relpath(full, server)))
        pkg = os.path.join(LOCAL, "package.json")
        if os.path.exists(pkg):
            tar.add(pkg, arcname="package.json")
    buf.seek(0)
    return buf


def main():
    if not PASS:
        print("MIRAI_PASS 未设置", file=sys.stderr)
        return 2

    dist_ok = os.path.isdir(os.path.join(LOCAL, "dist"))
    if not dist_ok:
        print("dist/ 不存在，先跑 npm run build", file=sys.stderr)
        return 2

    print(f"→ 连接 {USER}@{HOST}")
    c = connect()

    print("→ 准备目录")
    sh(c, f"mkdir -p {REMOTE}/data && useradd -r -s /usr/sbin/nologin mirai 2>/dev/null; true")

    print("→ 上传产物")
    buf = pack_dist()
    sftp = c.open_sftp()
    tmp = "/tmp/mirai-build.tar.gz"
    sftp.putfo(buf, tmp)
    size = sftp.stat(tmp).st_size
    print(f"  {size // 1024} KB")

    sh(c, f"""
set -e
rm -rf {REMOTE}/dist {REMOTE}/server
tar -xzf {tmp} -C {REMOTE}
chown -R mirai:mirai {REMOTE}
chmod 750 {REMOTE}/data
ls {REMOTE}
""")

    print("→ 写环境文件")
    env_lines = [
        f"PORT={PORT}",
        "HOST=0.0.0.0",
        f"MIRAI_DATA={REMOTE}/data/mirai.db",
        f"MINIMAX_API_KEY={MINIMAX_KEY}",
        "MINIMAX_MODEL=MiniMax-Text-01",
        # CDN 已终止 TLS；源站若也要 443（CDN 回源走 HTTPS），就填这两行
        f"MIRAI_TLS_CERT={REMOTE}/certs/mirai.fullchain.pem",
        f"MIRAI_TLS_KEY={REMOTE}/certs/mirai.key",
        "MIRAI_TLS_PORT=443",
    ]
    env_body = "\n".join(env_lines) + "\n"
    with sftp.file(f"{REMOTE}/.env", "w") as f:
        f.write(env_body)
    sftp.chmod(f"{REMOTE}/.env", 0o600)

    print("→ 写 systemd 服务")
    with sftp.file("/etc/systemd/system/mirai.service", "w") as f:
        f.write(UNIT.format(remote=REMOTE))
    sftp.close()

    print("→ 启动")
    sh(c, """
systemctl daemon-reload
systemctl enable mirai >/dev/null 2>&1
systemctl restart mirai
sleep 3
systemctl is-active mirai
""")

    print("→ 本机探测")
    time.sleep(1)
    sh(c, f"curl -s -m 8 -o /dev/null -w 'health:%{{http_code}} ' http://127.0.0.1:{PORT}/api/health; "
          f"curl -s -m 8 -o /dev/null -w 'app:%{{http_code}}\\n' http://127.0.0.1:{PORT}/app.html")

    print("→ 日志")
    sh(c, "journalctl -u mirai -n 12 --no-pager")

    c.close()

    print(f"\n部署完成。")
    print(f"  直连:  http://{HOST}/")
    print(f"  域名:  https://{DOMAIN}/  （需 CDN 源站指向 {HOST}:{PORT}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
