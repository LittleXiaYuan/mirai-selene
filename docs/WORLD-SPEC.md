# World-Spec v1.0

> 渲染层不认识故事，只读这份 JSON。换世界 = 换 Spec，不重启进程。

## 1. 为什么是 Spec

| 旧做法 | 现在 |
|---|---|
| 每个世界改一套页面 / 文案 | 一个通用渲染器，读 `assets_manifest` 与 `logic_nodes` |
| 写完剧本再找人画图 | 资产工厂把「主题」拆成节点与 Prompt 任务单 |
| 换主题要重新部署 | `POST /mirai-api/spec/load`，客户端 1.5 秒内切世界 |
| 选择靠 LLM 现编 | 选项是状态机边，点一下就是树上的下一步 |

## 2. 结构

```jsonc
{
  "spec_version": "1.0",
  "id": "wednesday-before",
  "title": "周三之前",
  "subtitle": "医院走廊 · 上海 offer",
  "logline": "母亲的复查报告在周三出。上海的 offer 要你在周二答复。",
  "ui": { "palette": "warm", "accent": "rose" },

  "assets_manifest": {
    "cover": { "path": "/mirai/linxia.webp" },
    "backgrounds": {
      "corridor": { "path": "/mirai/01-cover.webp", "focus": "center" }
    },
    "portraits": {
      "linxia": {
        "base": "/mirai/linxia.webp",
        "emotions": {
          "neutral": "/mirai/linxia.webp",
          "warm": "/mirai/linxia-warm.webp",
          "cold": "/mirai/linxia-cold.webp",
          "tense": "/mirai/linxia-tense.webp",
          "broken": "/mirai/linxia-broken.webp"
        }
      }
    }
  },

  "cast": [
    { "id": "linxia", "name": "林夏", "role": "你", "traits": "怕的不是选错，是没得选", "portrait": "linxia" }
  ],

  "state_injection": {
    "prior_memories": [{ "key": "房租压力", "value": 6 }],
    "stance_bias": { "neutral": 0.4, "probe_blindspot": 0.3 },
    "temperature": 0.7
  },

  "entry": "corridor",
  "logic_nodes": [
    {
      "id": "corridor",
      "title": "医院走廊",
      "scene": {
        "background": "corridor",
        "place": "医院走廊",
        "time": "黄昏",
        "weather": "阴",
        "mood": "紧绷"
      },
      "speaker": "母亲",
      "text": "她把报告单折了两折，塞进包里，说「没什么大事」。",
      "stance_goal": "neutral",
      "observe": [{ "key": "怀疑", "value": 5 }],
      "choices": [
        { "label": "直接问她报告上写了什么", "to": "ask", "memory": { "key": "逼问", "value": 7 } }
      ]
    }
  ]
}
```

### 字段约束

| 字段 | 说明 |
|---|---|
| `assets_manifest.cover` | 标题页大图；缺省时回落到入口背景，再回落到第一位角色立绘 |
| `assets_manifest.portraits[].emotions` | 五档情绪切片：`neutral / warm / cold / tense / broken`；缺哪档就回落到 `base` |
| `logic_nodes[].stance_goal` | 六档之一：`empathetic / neutral / probe_blindspot / skeptical_push / counter_bluff / rupture` |
| `logic_nodes[].choices[].to` | 必须是另一个 `logic_node.id`；点选项直接走到那棵树节点，不再请 LLM 现编 |
| `state_injection.prior_memories` | 进入世界时先灌的记忆，参与后续合流与回滚 |
| `state_injection.A0 / B0` | 可选，PAI-SSM 初始自然参数；不填由桥初始化 |

校验分两层：前端 `src/world/spec.ts` 做完整校验（引用完整性、可达性、资源警告），服务端 `server/spec.mjs` 只挡结构错误。警告不会阻止载入，渲染器会用兜底色。

## 3. 渲染器怎么读

- `buildWorldFromSpec()` 把每个 `logic_node` 折成一段 `branch + observe`，写进已验证的 `WorldTree`；
  存档、回滚、`merge3`、导出全部沿用旧引擎，没有第二套运行时。
- 舞台按 `node.meta.specNode` 找当前 Spec 节点，取：
  - 背景：`assets_manifest.backgrounds[scene.background]`；
  - 立绘：`cast[speaker]` → `portraits[key].emotions[emotion]`，`emotion` 缺省时由 `stance` 映射；
  - 台词与选项：`speaker / text / choices`。
- 自由对话产生的新节点没有 `specNode` 时，继承路径上最近一幕的资产与场景。
- `stance` 优先级：PAI-SSM 返回的姿态 > `stance_goal` > 本地状态读数。

## 4. 热重载

```bash
# 发布一个新世界（版本号 +1）
curl -X POST http://127.0.0.1:8080/mirai-api/spec/load \
  -H 'Content-Type: application/json' \
  -d @world.json

# 查看当前版本
curl http://127.0.0.1:8080/mirai-api/spec/current
curl http://127.0.0.1:8080/mirai-api/spec/health

# 清空仓库
curl -X POST http://127.0.0.1:8080/mirai-api/spec/clear -d '{}'
```

客户端在 `MiraiApp` 顶层轮询 `/spec/current`（1.5 秒）。版本一变：

1. `useWorlds.loadSpec()` 折进新树，同 id 世界原地替换；
2. 当前视图切到舞台；
3. 标题幕布重新落下，上一场戏的流式文本、插画、抽屉全部清掉。

Spec 会持久化到 `app/data/current-spec.json`（可用 `MIRAI_SPEC_FILE` 改路径），重启服务后仍在。

## 5. 资产工厂

```bash
# 一个主题 → 10 个叙事节点 + Prompt 任务单
curl -X POST http://127.0.0.1:8080/mirai-api/assets/plan \
  -H 'Content-Type: application/json' \
  -d '{"theme":"合伙人雨夜散伙前的最后一轮谈判","title":"雨夜散伙"}'

# 已有 Spec → 只出任务单
curl -X POST http://127.0.0.1:8080/mirai-api/assets/plan \
  -H 'Content-Type: application/json' -d @spec.json

# 生成单张资产
curl -X POST http://127.0.0.1:8080/mirai-api/assets/generate \
  -H 'Content-Type: application/json' \
  -d '{"task": { "id": "bg-1", "kind": "background", "prompt": "…", "aspect": "16:9" }}'
```

### Visual Codebook

`server/assets/prompt-library.mjs` 固定了：渲染风格、单一主光位（左上 35° / 5200K）、低饱和主色不超过两种、1.6m 人眼高度 / 50mm 镜头、立绘 2:3 与背景 16:9。情绪只改神态与光，不改画风。

### Provider

| 环境变量 | 作用 |
|---|---|
| `ASSET_PROVIDER` | `minimax` / `sensenova` / `none`；缺省时有 `MINIMAX_API_KEY` 就选 minimax |
| `MINIMAX_API_KEY` / `MINIMAX_IMAGE_URL` / `MINIMAX_IMAGE_MODEL` | MiniMax `image-01` |
| `SENSENOVA_API_KEY` / `SENSENOVA_IMAGE_URL` / `SENSENOVA_MODEL` | 商汤日日新图像接口（不同账号的 body 形状可能不同，按实际网关调整 `factory.mjs` 的 `providerPlan`） |

没 key、余额不足或接口失败时，`/assets/generate` 返回 `{ ok:false, reason }`，任务单仍然完整可用。生成成功的图会被缓存到 `data/art/`，通过 `/mirai-art/<file>` 同源返回（避免 OSS 直链跨域）。

## 6. H5 游戏壳

同一份 Spec 可以生成一个独立的单文件 H5 视觉小说（标题 → 舞台 → 2×5 画廊），图片走 `assets_manifest`，姿态走 `/mirai-api/pai/step`：

```bash
# 当前已发布世界的壳子
open http://127.0.0.1:8080/game/current

# 任意 Spec 生成壳子（返回 text/html，可直接下载）
curl -X POST http://127.0.0.1:8080/mirai-api/game/shell   -H 'Content-Type: application/json' -d @spec.json -o world.html
```

- 壳子的演出：开场「点击开始」+ 花瓣、章节卡、双背景交叉淡入、浮动名字牌、逐字台词、选项；右下 `AUTO / LOG / SAVE / LOAD / 世界线 / TITLE`。
- 键盘：`Space / Enter` 推进，`Esc` 返回标题（LOG 打开时先关 LOG）。
- 存档：`localStorage`，键为 `mirai.selene.save.<spec.id>`，2×5 十个位置；「世界线」页直接列 Spec 的十幕。
- 壳子里的 `window.MIRAI_API_BASE` 可改 API 地址；默认 `/mirai-api`。
- 发布过的世界用 `/game/current`，API 同源可用；直接下载的 `.html` 是纯视觉原型，API 调用失败时自动退回静态演出。
- 生成器在 `app/server/shell.mjs`；主题只读 `spec.ui.palette`（cream / warm / noir / cold）。

## 7. 入口与市场

- **未登录入口**是示例世界页：本地世界 + 四份 World-Spec 示例，可走进、新建、载入、去市场。
- **登录**是安装的 Arc Pro 块 `login-immersive`（玻璃卡 + 暮色照片），表单已换成真实邮箱密码；登录后进世界管理台。
- **世界铸造台**是「新建世界」的一种：六问对话 + 语音，答完生成 Spec。
- **世界市场**（`/` → 世界市场）把 `.world` 当商品：精选世界可预览游戏壳、导入、走进；分叉破局的分润按世界文件里的血缘树结算。
- `demo/mirai-natural.html` 现在对应 `SPEC_NATURAL`（《放学后的窗边》），只是市场/模板里的一个世界。

## 8. 社会摄取与阵营 Agent

`POST /mirai-api/ingest/social` 把热帖变成快照与阵营 Agent，并产出一份可直接渲染的 Spec：

- `snapshot`：标题、正文、标签、高赞评论、极化指数、来源。
- `factions`：`public_claim`、`hidden_motive`、`initial_bias.{trust,friction,ruin_threshold}`、立绘键。
- `spec`：v1 渲染器可直接吃；额外带 `meta`、`factions`、`social_pulse`。
- `POST /mirai-api/agent/simulate`：多轮干预推演，返回 timeline / metrics / branches；当前 provider 为 `local-policy`，模型接入后替换 stance 与 ruin 计算。

## 9. 加一个世界的步骤

1. 写一份 Spec（或调 `/assets/plan` 生成骨架）。
2. 把 `assets_manifest` 指向真实切片；没有切片时先用现有图占位。
3. 发布：`POST /spec/load`，或把 JSON 粘进舞台抽屉的「世界」页签。
4. 想让所有人看到同一世界：发布到服务端；只在本地试：直接载入。

## 10. 已知边界

- 内置三份 Spec 的背景仍是仓库里的概念图，等资产工厂出片后替换路径即可；渲染器不用改。
- 图像 provider 当前账号余额不足，`/assets/generate` 会如实返回 `insufficient balance`；Prompt 与任务单可离线审阅。
- PAI-SSM 桥未启动时，舞台仍可走 Spec 状态机与本地确定性推演，只是没有张量级分位数与真实 `merge3` 误差。
