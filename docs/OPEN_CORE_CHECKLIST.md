# Open-Core 公开仓库打包清单（给负责整理 GitHub / 魔搭仓库的同学）

原则：**评委能一键跑通所有硬核验证（76/76 引擎单测 + 17/17 MCP 冒烟 + 演示前端），但核心商业资产、私有训练配方、完整权重和密钥绝不外泄。**

---

## 1. 直接放进公开仓库（Open-Core 公开部分）

- **根目录**：
  - `README.md`（直接使用本目录 `readme-kit/README.md`）
  - `docs/images/`（直接拷贝本目录 `readme-kit/docs/images/` 下 9 张高清配图、架构实验曲线与真机实拍）
- **核心引擎与测试（强烈建议保留，评委复现满分用）**：
  - `app/src/world/engine.ts`、`worldfile.ts`、`spec.ts`、`prediction.ts`、`prosody-audio.ts` 及对应 `*.test.ts`
  - `app/bench/bench.ts`、`bench.test.ts`
- **前端核心交互（开源一半：保留舞台/演示/基准验证，商业后台可按需裁剪）**：
  - `app/src/app/MiraiApp.tsx`、`landing-screen.tsx`、`stage-screen.tsx`、`demo-mode.tsx`、`about-view.tsx`、`compare-view.tsx`、`use-prosody.ts`、`voice-prosody-button.tsx`、`pai.ts`
- **后端核心 Agent & MCP 协议（开源一半：保留 MCP 12 工具与推理桥协议）**：
  - `app/server/mcp-core.mjs`、`mcp.mjs`、`mcp.smoke.mjs`、`pai.mjs`、`agent_sim.mjs`、`agent.smoke.mjs`
- **自研模型 PAI-SSM（仅开源接口与不变量验证，保护训练资产）**：
  - `epistemic_model/test_invariants.py`、`serve_bridge.py`（或仅保留接口定义与不变量单测）

---

## 2. 务必剔除，严禁推到公开仓库（闭源核心 + 敏感数据）

- **绝不能传的密钥与本地库**：
  - 所有 `.env` / `.env.*` / API Key / 令牌 / `app/data/mirai.db`（SQLite 用户数据）
- **商业闭源保留模块**：
  - `epistemic_model/train_l20.py`、私有数据合成/训练脚本与所有模型权重文件（`.pt` / `.safetensors` / `.ckpt`）
  - `deploy/`（线上服务器部署脚本、账号、IP、SSH 配置）
  - 根目录临时脚本（`fill_form.py`、`make_pptx*.py`、`make_poster*.py`、`upload_attach.py` 等比赛物料生成脚本）
  - 商业全量创作台/私有运营模块（如决定裁剪前端一半，可将 `world-studio.tsx` / `auth-screen.tsx` / `mail.mjs` 等私有商业后台保留在内部仓库）

---

## 3. 推送前 10 秒安全自检

```bash
# 确认没有把任何 Key / 密码 / 令牌误推上去
git grep -iE "sk-|api_key|secret|token|password" -- ':!*.md' ':!*.test.*'

# 确认公开仓库能直接跑通核心复现测试
cd app && npx vitest run && node server/mcp.smoke.mjs
```
