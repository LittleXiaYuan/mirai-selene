#!/usr/bin/env bash
# 在一台已经有仓库副本的机器上装 devagent（aider + 极简 Web UI）。
# 用法：
#   DEV_REPO=/opt/mirai-dev/repo AGENT_PASSWORD='...' AGENT_API_KEY='sk-...' bash devagent/setup.sh
set -euo pipefail

DEV_ROOT="${DEV_ROOT:-/opt/mirai-dev}"
DEV_REPO="${DEV_REPO:-$DEV_ROOT/repo}"
AGENT_PASSWORD="${AGENT_PASSWORD:-}"
AGENT_API_KEY="${AGENT_API_KEY:-}"
AGENT_MODEL="${AGENT_MODEL:-openai/gpt-4.1-mini}"
AGENT_API_BASE="${AGENT_API_BASE:-https://api.openai-next.com/v1}"
AGENT_PORT="${AGENT_PORT:-8090}"

if [[ -z "$AGENT_PASSWORD" || -z "$AGENT_API_KEY" ]]; then
  echo "需要 AGENT_PASSWORD 与 AGENT_API_KEY" >&2
  exit 1
fi

echo "→ 依赖"
apt-get update -qq
apt-get install -y python3.12-venv git

echo "→ aider"
[[ -x "$DEV_ROOT/venv/bin/aider" ]] || python3 -m venv "$DEV_ROOT/venv"
"$DEV_ROOT/venv/bin/pip" install -q --upgrade pip
"$DEV_ROOT/venv/bin/pip" install -q aider-chat

echo "→ agent 文件"
mkdir -p "$DEV_ROOT/agent"
cp "$(dirname "$0")/server.mjs" "$DEV_ROOT/agent/server.mjs"
cp "$(dirname "$0")/index.html" "$DEV_ROOT/agent/index.html"

echo "→ systemd"
cat > /etc/systemd/system/mirai-dev-agent.service <<EOF
[Unit]
Description=Mirai dev agent (aider web)
After=network.target

[Service]
Environment=DEV_REPO=$DEV_REPO
Environment=AGENT_PASSWORD=$AGENT_PASSWORD
Environment=AGENT_API_KEY=$AGENT_API_KEY
Environment=AGENT_API_BASE=$AGENT_API_BASE
Environment=AGENT_MODEL=$AGENT_MODEL
Environment=AIDER_BIN=$DEV_ROOT/venv/bin/aider
Environment=AGENT_PORT=$AGENT_PORT
ExecStart=/usr/bin/node $DEV_ROOT/agent/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now mirai-dev-agent

echo "→ 检查站点反代"
if grep -q "miraidev" /opt/mirai/server/serve.mjs 2>/dev/null; then
  echo "  主站已按 Host 转发 miraidev.* → 127.0.0.1:$AGENT_PORT"
else
  echo "  ⚠ /opt/mirai/server/serve.mjs 里没有 miraidev Host 分支" >&2
fi

echo "完成：https://miraidev.cloudtori.cn/ （用户名 dev）"
