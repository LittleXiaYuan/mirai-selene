/**
 * 无头入口：把世界引擎打成可以在 Node 里直接跑的包。
 *
 * 为什么需要它：MCP server 要能被任何 Agent 调用（本地 stdio），
 * 但引擎是给浏览器用的 TS。与其复制一份逻辑，不如把同一份代码打出来 ——
 * 这样「界面上算的」和「Agent 调的」永远是同一个实现，不可能对不上。
 *
 * 构建：npm run build:mcp
 */
export * from "./engine";
export { buildPredictionCard } from "./prediction";
export type { PredictionInput } from "./prediction";
