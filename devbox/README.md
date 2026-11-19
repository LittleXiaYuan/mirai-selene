# devbox：服务器上的最简 coding agent

一条 Web 终端，跑在 `mirai.cloudtori.cn/dev/`，里面是 [aider](https://aider.chat) 与项目源码。
用在路上改代码：打开浏览器 → 输入密码 → `agent`。

## 打开

- 地址：`https://mirai.cloudtori.cn/dev/`
- 用户名：`dev`
- 密码：部署时生成的，只写在服务器 `/etc/systemd/system/mirai-dev-terminal.service`

改密码：

```bash
systemctl edit mirai-dev-terminal   # 改 -c dev:新密码
systemctl restart mirai-dev-terminal
```

## 里面有什么

| 路径 | 作用 |
|---|---|
| `/opt/mirai-dev/repo` | GitCode 上的 mirai-selene 源码副本（登录后进这个目录） |
| `/opt/mirai-dev/bin/agent` | `aider` 启动器，已接 OpenAI 兼容网关与 `gpt-4.1-mini` |
| `/opt/mirai-dev/venv` | Python 虚拟环境（aider 0.86） |

登录后的典型用法：

```bash
cd /opt/mirai-dev/repo
git pull
agent app/src/app/market-screen.tsx   # 指定要改的文件，然后直接说需求
```

aider 会自己读文件、给 diff、跑测试；确认后再 `git commit && git push`。
注意：容器里的仓库是 clone，**推送需要你自己的 GitCode 凭据**（首次 push 时填 token）。

## 它是怎么接进来的

```
浏览器 https://mirai.cloudtori.cn/dev/
   → 主站 serve.mjs 反代（含 WebSocket upgrade）
   → 127.0.0.1:7681 ttyd（Basic Auth）
   → bash → aider
```

不额外开端口，复用主站证书；`serve.mjs` 里 `/dev` 分支与 `attachDevUpgrade()` 是唯一的改动。

## 安全边界（重要）

- 这是一个 **有 root 权限的 shell**，只靠一层 Basic Auth。密码不要外传，用完可以 `systemctl stop mirai-dev-terminal` 关掉。
- 不要在终端里粘贴长期有效的密钥；aider 的 key 已经写在 `/opt/mirai-dev/bin/agent`，不要把它复制到仓库。
- 不要在这个 shell 里改 `/opt/mirai`（线上站）；改代码请改 `/opt/mirai-dev/repo`，然后走正常部署。

## 从零复现

```bash
sudo bash devbox/setup.sh          # 装 ttyd / venv / aider / systemd 服务
sudo bash devbox/setup.sh --proxy  # 顺带检查 serve.mjs 的 /dev 反代是否存在
```

`setup.sh` 需要两个环境变量：`DEV_PASSWORD`（终端密码）、`OPENAI_API_KEY`（网关 key）。
