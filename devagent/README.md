# devagent：浏览器里的 coding agent

`https://miraidev.cloudtori.cn/` —— 一个只做代码改动的 agent，不提供 shell。
背后是 [aider](https://aider.chat)，工作目录是服务器上的仓库副本 `/opt/mirai-dev/repo`。

## 它是什么

- 你写一句话（「把市场卡片的购买按钮改成整张卡都能点」），它读仓库、改文件、给出 diff
- 每一步都能看到输出；改完不会自动提交，你确认后再点「提交」
- 「撤销未提交」会 `git checkout -- .`，回到干净状态
- 没有终端输入口，不能执行任意命令；aider 只做编辑与（必要时）跑测试

## 访问控制

- 用户名 `dev`，密码在 `/etc/systemd/system/mirai-dev-agent.service`
- 浏览器会弹 Basic Auth；走 HTTPS，复用 CDN 证书
- 子域 `miraidev.*` 在 `serve.mjs` 里整站反代到 `127.0.0.1:8090`，业务域名上不留任何入口

## 本地开发环境同步到了云上

| 内容 | 位置 |
|---|---|
| 19 个技能（Arc UI、impeccable、frontend-design…） | `repo/.agents/skills/`、`repo/.claude/skills/` |
| MCP 配置（heroui、arc，含 token） | `/opt/mirai-dev/home/.mcp.json`，权限 600，不进仓库 |
| Arc 组件配置 | `repo/app/components.json` |
| 仓库约定 | `repo/AGENTS.md`（agent 每次都会先读它） |

aider 本身不消费 MCP；这些配置留给以后换 Claude Code / Kimi Code 一类 CLI 时直接复用。

## 换模型

编辑 unit 里的 `AGENT_MODEL` / `AGENT_API_BASE` / `AGENT_API_KEY`，然后：

```bash
systemctl daemon-reload && systemctl restart mirai-dev-agent
```

## 从零装一台

```bash
DEV_REPO=/opt/mirai-dev/repo \
AGENT_PASSWORD='...' AGENT_API_KEY='sk-...' \
bash devagent/setup.sh
```

前置：Node 22、`git`、`python3.12-venv`、仓库已 clone。
