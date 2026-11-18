# NOTICE

本仓库是 Mirai-Selene 的**半开源**发布版：代码开放，权重与比赛物料单独授权。

## 包含

- `app/`：React 19 + Vite 前端、Node 服务端（认证、世界线、MCP、舆情摄取）
- `epistemic_model/`：PAI-SSM 自研状态推演模型的 PyTorch 实现与不变量测试
- `deploy/`：生产部署与浏览器端验收脚本
- `docs/`：设计、世界线引擎、部署与比赛材料
- `assets/`：README 使用的真实界面截图与实验图

## 不包含

- 模型权重（`*.pt`）：见 ModelScope `XiaYuanOvO/pai-ssm`
- 比赛 PPT / 宣传片 / 海报 / 分镜素材
- `components.json`（内含 Arc registry 的 license key）
- `.env`、数据库、运行日志

## 第三方

- 字体：Inter、Geist Sans，经 `@fontsource` 本地打包
- 组件：Arc UI（`app/src/components/arc/`），遵循其许可
- 图标：Lucide
- 动画：Motion

## 数据与声明

README 与文档中的指标来自仓库内可复现的单元测试、消融脚本与运行日志。
合成评测集上的数字不等于真实语料表现，引用时请保留限定条件。
