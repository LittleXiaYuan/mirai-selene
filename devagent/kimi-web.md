# 在云上跑 Kimi Code 的 Web UI

官方提供了 `kimi web`：一个进程同时提供 REST + WebSocket API 和 Web UI，
默认只监听 `127.0.0.1`，启动时打印 bearer token，UI 通过 URL `#token=` 自动登录。

## 服务器上怎么起

```bash
npm i -g @moonshot-ai/kimi-code      # 需要 Node >= 22.19
kimi login                           # 设备码登录：把打印的 URL 在手机上打开并授权
kimi web --host 127.0.0.1 --port 58627 \
  --allowed-host miraidev.cloudtori.cn --no-open --log-level info
```

systemd 单元见 `mirai-kimi-web.service`。登录态存在 `/root/.kimi-code/`。

## 怎么接到子域

`app/server/serve.mjs` 里按 Host 分流：`miraidev.*` → `127.0.0.1:58627`。
反向代理会原样转发 `Authorization`，所以 bearer token 校验仍然生效；
`--allowed-host` 让 Kimi 的 DNS-rebinding 检查接受这个 Host。

打开：

```
https://miraidev.cloudtori.cn/#token=<~/.kimi-code/server.token>
```

token 是持久的；要换就 `kimi web rotate-token`。

## 凭据边界

| 东西 | 位置 | 注意 |
|---|---|---|
| Kimi 登录态 | `/root/.kimi-code/` | 不要复制进仓库，不要贴到聊天里 |
| Web bearer token | `/root/.kimi-code/server.token` | 只出现在 URL fragment，不进日志 |
| 模型 API key（可选） | `config.toml` / 环境变量 | 用 OAuth 时不需要 |

## 和 devagent（aider）的关系

两套可以并存：

- `miraidev.cloudtori.cn` 指向 Kimi web（有会话、有工具调用、能看到 diff）
- 8090 的 aider agent 保留为备用后端，不对外暴露

切换只需改 `serve.mjs` 里 `MIRAI_AGENT_PORT` 的默认值并重启主站。
