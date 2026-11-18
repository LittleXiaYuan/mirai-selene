"""在服务器上执行命令（运维用）。

用法：
  python deploy/run.py "systemctl status mirai"
  python deploy/run.py --file deploy/some.sh
凭据从环境变量 MIRAI_HOST / MIRAI_USER / MIRAI_PASS 读。
"""

import os
import sys

import paramiko


def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        os.environ.get("MIRAI_HOST", "YOUR_SERVER_IP"),
        22,
        os.environ.get("MIRAI_USER", "root"),
        os.environ.get("MIRAI_PASS", ""),
        timeout=25,
    )
    return client


def run(client, command, timeout=600):
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print("[stderr]", err.rstrip()[:1200])
    return code


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("用法: run.py <command> | --file <script>")
    if not os.environ.get("MIRAI_PASS"):
        raise SystemExit("MIRAI_PASS 未设置")
    c = connect()
    try:
        cmd = open(sys.argv[2], encoding="utf-8").read() if sys.argv[1] == "--file" else " ".join(sys.argv[1:])
        code = run(c, cmd)
    finally:
        c.close()
    sys.exit(0 if code == 0 else 1)
