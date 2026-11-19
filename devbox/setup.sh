#!/usr/bin/env bash
# 在 Ubuntu 22.04 上装一个最简 coding agent：ttyd + aider，挂在主站 /dev 下。
# 用法：
#   DEV_PASSWORD='...' OPENAI_API_KEY='sk-...' bash devbox/setup.sh
set -euo pipefail

DEV_ROOT="${DEV_ROOT:-/opt/mirai-dev}"
DEV_PORT="${DEV_PORT:-7681}"
REPO_URL="${REPO_URL:-https://gitcode.com/XiaYuanOwO/mirai-selene.git}"
MODEL="${MODEL:-openai/gpt-4.1-mini}"
API_BASE="${API_BASE:-https://api.openai-next.com/v1}"
DEV_PASSWORD="${DEV_PASSWORD:-}"
OPENAI_API_KEY="${OPENAI_API_KEY:-}"

if [[ -z "$DEV_PASSWORD" || -z "$OPENAI_API_KEY" ]]; then
  echo "需要 DEV_PASSWORD 与 OPENAI_API_KEY 两个环境变量" >&2
  exit 1
fi

echo "→ 依赖"
apt-get update -qq
apt-get install -y ttyd python3.12-venv git curl

echo "→ 代码与虚拟环境"
mkdir -p "$DEV_ROOT/bin"
[[ -d "$DEV_ROOT/repo/.git" ]] || git clone --depth 1 "$REPO_URL" "$DEV_ROOT/repo"
[[ -x "$DEV_ROOT/venv/bin/aider" ]] || python3 -m venv "$DEV_ROOT/venv"
"$DEV_ROOT/venv/bin/pip" install -q --upgrade pip
"$DEV_ROOT/venv/bin/pip" install -q aider-chat

echo "→ agent 启动器"
cat > "$DEV_ROOT/bin/agent" <<EOF
#!/bin/sh
exec "$DEV_ROOT/venv/bin/aider" \\
  --model "$MODEL" \\
  --openai-api-base "$API_BASE" \\
  --openai-api-key "$OPENAI_API_KEY" \\
  "\$@"
EOF
chmod +x "$DEV_ROOT/bin/agent"

echo "→ systemd 服务"
cat > /etc/systemd/system/mirai-dev-terminal.service <<EOF
[Unit]
Description=Mirai dev terminal (ttyd + aider)
After=network.target

[Service]
ExecStart=/usr/bin/ttyd -p $DEV_PORT -i 127.0.0.1 -b /dev -c dev:$DEV_PASSWORD -W bash -lc "cd $DEV_ROOT/repo && export PATH=$DEV_ROOT/bin:\$PATH && exec bash -l"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now mirai-dev-terminal

echo "→ 检查反代 /dev"
if grep -q "proxyDev" /opt/mirai/server/serve.mjs 2>/dev/null; then
  echo "  serve.mjs 已有 /dev 反代"
else
  echo "  ⚠ /opt/mirai/server/serve.mjs 里没有 /dev 反代：需要先部署带 proxyDev 的版本" >&2
fi

echo "完成：https://mirai.cloudtori.cn/dev/  （用户名 dev）"
