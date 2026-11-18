/**
 * Mirai-Selene 生产服务器 —— 静态托管 + 用户系统 + LLM 代理一体。
 *
 * 为什么不用 `vite preview`：它不代理 /mirai-api，部署后预测和对话会全部 404。
 * 为什么不用 nginx + 独立代理：评委会点开的是一条链接，越少进程越不容易挂。
 *
 * 用法：
 *   MINIMAX_API_KEY=... node server/serve.mjs
 *   PORT=8080 MIRAI_DATA=./data/mirai.db node server/serve.mjs
 *   无 key 也能起，前端会落到本地确定性分支（功能不消失，只是不通 LLM）。
 */

import http from "node:http";
import https from "node:https";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb,
  purgeExpiredPasswordResets,
  purgeExpiredSessions,
} from "./db.mjs";
import { currentUser, handleApiRoute, json as jsonOut } from "./api.mjs";
import { rateLimit, sweepRateLimits } from "./auth.mjs";
import { handleAct } from "./act.mjs";
import { handleImage, serveArt } from "./image.mjs";
import { handleJudge } from "./judge.mjs";
import { paiHealth, paiMerge3, paiStep } from "./pai.mjs";
import { clearSpec, currentSpec, loadSpec, specHealth } from "./spec.mjs";
import { assetProvider, generateAsset, planWorld } from "./assets/factory.mjs";
import { planAssetTasks } from "./assets/prompt-library.mjs";
import { dispatch as dispatchMcp, setSpecPublisher } from "./mcp-core.mjs";
import { forgeTurn, startForge } from "./forge.mjs";
import { renderShell } from "./shell.mjs";
import { ingestSocial, socialCases } from "./social_ingest.mjs";
import { simulateAgents } from "./agent_sim.mjs";
import { getRun, listRuns, pruneAgentData, saveRun } from "./agent_store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "dist");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const KEY = process.env.MINIMAX_API_KEY || "";
const BASE = process.env.MINIMAX_BASE_URL || "https://api.minimax.chat/v1/chat/completions";
const MODEL = process.env.MINIMAX_MODEL || "MiniMax-Text-01";
const DB_PATH = process.env.MIRAI_DATA || resolve(__dirname, "..", "data", "mirai.db");

const db = openDb(DB_PATH);

// 可选 TLS：CDN 回源如果走 HTTPS，源站必须有证书，否则 ESA 会报 connection_refused。
// 证书由 certbot 签，路径写进 .env；没有就只跑 HTTP。
const TLS_CERT = process.env.MIRAI_TLS_CERT || "";
const TLS_KEY = process.env.MIRAI_TLS_KEY || "";
const TLS_PORT = Number(process.env.MIRAI_TLS_PORT || 443);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const FALLBACK_BRANCHES = [
  { label: "上海线", route: "shanghai", outcome: "她去了上海，获得了更大的舞台，但和母亲的距离变远。", confidence: 0.62, assumption: "她更在意成长，而不是稳定。" },
  { label: "考研线", route: "kaoyan", outcome: "她留下来读研，路径更稳，但会反复怀疑自己是不是在躲。", confidence: 0.48, assumption: "导师的支持能抵消她对“逃避”的恐惧。" },
  { label: "青岛线", route: "qingdao", outcome: "她留在青岛，关系更近，但“如果当时”会长期回响。", confidence: 0.55, assumption: "她愿意用可能性换取确定性。" },
];

const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // 防止有人拿这个端点灌大包
    if (size > 1_000_000) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

/**
 * 远程 MCP 入口：小浣熊（以及任何 Streamable HTTP 客户端）从这里挂载世界引擎。
 *
 * 工具与 stdio 版共用 mcp-core.mjs，所以 Agent 在网页里调的和本地 CLI 调的是同一套动作空间。
 * 配置 MCP_TOKEN 时要求 `Authorization: Bearer <token>`，避免公网地址被陌生人走世界。
 */
const MCP_TOKEN = process.env.MCP_TOKEN || "";
// 让 MCP 的 forge_world / ingest_social / publish_spec 与舞台共享同一份 spec 状态
setSpecPublisher(loadSpec);

async function handleMcpHttp(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  );
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (MCP_TOKEN && req.headers.authorization !== `Bearer ${MCP_TOKEN}`) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  if (req.method === "GET") {
    // Streamable HTTP 的 SSE 通道。我们不发服务端主动消息，只保持连接与心跳。
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": mirai-selene mcp\n\n");
    const timer = setInterval(() => res.write(": ping\n\n"), 25_000);
    timer.unref?.();
    req.on("close", () => clearInterval(timer));
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "POST only" });
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  const batch = Array.isArray(body) ? body : [body];
  const out = [];
  for (const message of batch) {
    const answer = await dispatchMcp(message);
    if (answer) out.push(answer);
  }
  if (!out.length) {
    res.writeHead(202).end();
    return;
  }
  json(res, 200, Array.isArray(body) ? out : out[0]);
}

/**
 * PAI-SSM 桥的三条只读/推演路由。
 * 桥没起来时 pai.mjs 会回 `{ ok:false, degraded:true }`，前端据此退回本地确定性分支。
 */
async function handlePai(req, res, route) {
  if (route === "health") {
    json(res, 200, await paiHealth());
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "POST only" });
    return;
  }
  const body = await readBody(req);
  json(res, 200, route === "step" ? await paiStep(body) : await paiMerge3(body));
}

function ownerOf(req, db) {
  const auth = currentUser(db, req);
  return auth?.user?.id ? `u:${auth.user.id}` : `ip:${req.socket.remoteAddress || "unknown"}`;
}

async function handleSocialRoute(req, res, pathname, db, ownerKey) {
  if (pathname !== "/api/mirai/ingest/cases" && !pathname.includes("/runs")) {
    const ip = req.socket.remoteAddress || "unknown";
    const limit = rateLimit(`${pathname}:${ip}`, {
      limit: pathname.includes("simulate") ? 40 : 15,
      windowMs: 60_000,
    });
    if (!limit.ok) {
      json(res, 429, { ok: false, error: `请求太频繁，${limit.retryAfter} 秒后再试` });
      return;
    }
  }
  if (pathname === "/api/mirai/agent/runs" && req.method === "GET") {
    json(res, 200, { ok: true, runs: listRuns(db, ownerKey) });
    return;
  }
  if (pathname.startsWith("/api/mirai/agent/runs/") && req.method === "GET") {
    const run = getRun(db, pathname.slice("/api/mirai/agent/runs/".length), ownerKey);
    json(res, run ? 200 : 404, run ? { ok: true, run } : { ok: false, error: "没有这次作业" });
    return;
  }
  if (pathname === "/api/mirai/ingest/cases" && req.method === "GET") {
    json(res, 200, { ok: true, cases: socialCases() });
    return;
  }
  if (pathname === "/api/mirai/ingest/social" && req.method === "POST") {
    const body = await readBody(req);
    const result = await ingestSocial(body);
    if (result.ok) {
      const runId = `ingest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      saveRun(db, {
        id: runId,
        ownerKey,
        kind: "ingest",
        title: result.snapshot?.title ?? "社会摄取",
        input: body,
        output: result,
      });
      result.run_id = runId;
    }
    json(res, result.ok ? 200 : 400, result);
    return;
  }
  if (pathname === "/api/mirai/agent/simulate" && req.method === "POST") {
    const body = await readBody(req);
    const result = await simulateAgents(body);
    if (result.ok) {
      const runId = `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      saveRun(db, {
        id: runId,
        ownerKey,
        kind: "simulate",
        title: String(result.intervention ?? "多 Agent 推演").slice(0, 60),
        input: body,
        output: result,
      });
      result.run_id = runId;
    }
    json(res, 200, result);
    return;
  }
  json(res, 404, { ok: false, error: "unknown social route" });
}

async function handleForge(req, res, route, db, ownerKey) {
  if (route === "start" && req.method === "POST") {
    json(res, 200, startForge(db));
    return;
  }
  if (route === "turn" && req.method === "POST") {
    const body = await readBody(req);
    const result = await forgeTurn(body, db);
    if (result.done && result.spec) {
      saveRun(db, {
        id: `forge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        ownerKey,
        kind: "forge",
        title: result.spec.title,
        input: body,
        output: result,
      });
    }
    json(res, result.ok ? 200 : 400, result);
    return;
  }
  json(res, 404, { ok: false, error: "unknown forge route" });
}

async function handleGame(req, res) {
  let spec = null;
  if (req.method === "GET") {
    spec = currentSpec().spec;
  } else if (req.method === "POST") {
    const body = await readBody(req);
    spec = body?.spec ?? null;
  }
  if (!spec) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("no spec");
    return;
  }
  const html = renderShell(spec, { apiBase: "/mirai-api" });
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(html);
}

/**
 * World-Spec 热重载与资产工厂。
 * 这两个接口是「叙事操作系统」的控制面：换世界不需要重启进程。
 */
async function handleSpecRoute(req, res, route) {
  if (route === "spec/current" && req.method === "GET") {
    json(res, 200, { ok: true, ...currentSpec() });
    return;
  }
  if (route === "spec/health") {
    json(res, 200, specHealth());
    return;
  }
  if (route === "spec/load" && req.method === "POST") {
    const body = await readBody(req);
    const result = loadSpec(body?.spec ?? body);
    json(res, result.ok ? 200 : 400, result);
    return;
  }
  if (route === "spec/clear" && req.method === "POST") {
    json(res, 200, clearSpec());
    return;
  }
  if (route === "assets/plan" && req.method === "POST") {
    const body = await readBody(req);
    if (body?.spec) {
      json(res, 200, { ok: true, spec: body.spec, tasks: planAssetTasks(body.spec), provider: assetProvider() });
      return;
    }
    json(res, 200, { ok: true, provider: assetProvider(), ...planWorld(body ?? {}) });
    return;
  }
  if (route === "assets/generate" && req.method === "POST") {
    const body = await readBody(req);
    json(res, 200, await generateAsset(body?.task));
    return;
  }
  json(res, 404, { ok: false, error: "unknown spec route" });
}

async function chat(messages, { temperature = 0.6, max_tokens = 700 } = {}) {
  if (!KEY) throw new Error("MINIMAX_API_KEY is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(BASE, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`MiniMax HTTP ${response.status}`);
    if (data.base_resp?.status_code) {
      throw new Error(`MiniMax ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
    }
    const content = data.choices?.[0]?.message?.content ?? "";
    return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  } finally {
    clearTimeout(timer);
  }
}

function parseObject(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function parseArray(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("no JSON array");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* ---------------- API ---------------- */

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/mirai/health") {
    json(res, 200, { ok: true, model: MODEL, key: Boolean(KEY) });
    return true;
  }

  if (req.method !== "POST") return false;

  try {
    if (pathname === "/api/mirai/chat") {
      const body = await readBody(req);
      const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
      if (!messages.length) {
        json(res, 400, { error: "messages is empty" });
        return true;
      }
      const content = await chat(messages, { temperature: 0.7, max_tokens: 500 });
      json(res, 200, { content });
      return true;
    }

    if (pathname === "/api/mirai/predict") {
      const body = await readBody(req);
      const world = body.world ?? {};
      const intervention = String(body.intervention ?? "").slice(0, 200);
      const cast = (world.characters ?? [])
        .slice(0, 8)
        .map((c) => `${c.name}（${c.role}）：${c.traits}`)
        .join("；");
      const specs = [
        { route: "shanghai", label: "上海线", action: "去上海工作" },
        { route: "kaoyan", label: "考研线", action: "留校读研" },
        { route: "qingdao", label: "青岛线", action: "回青岛或留在青岛" },
      ];
      // 三条线并行，比串行快三倍 —— 评委不会等 9 秒
      const branches = await Promise.all(
        specs.map(async (spec) => {
          const fallback = FALLBACK_BRANCHES.find((i) => i.route === spec.route) ?? FALLBACK_BRANCHES[0];
          try {
            const text = await chat(
              [
                { role: "system", content: "你是 Mirai-Selene 的世界模型推演引擎。只输出一个严格 JSON 对象，不写解释。" },
                {
                  role: "user",
                  content: [
                    `世界：${world.name ?? "未命名"}。`,
                    `梗概：${world.summary ?? ""}`,
                    `角色：${cast}`,
                    `干预：${intervention}`,
                    `请只写「${spec.label}」：林夏${spec.action}之后的世界。`,
                    `严格输出 {"label":"${spec.label}","route":"${spec.route}","outcome":"一句话结局","confidence":0.6,"assumption":"关键假设"}。`,
                    "不要输出 markdown，不要解释。",
                  ].join("\n"),
                },
              ],
              { temperature: 0.5, max_tokens: 320 },
            );
            const parsed = parseObject(text);
            return {
              label: spec.label,
              route: spec.route,
              outcome: String(parsed.outcome ?? fallback.outcome).slice(0, 160),
              confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || fallback.confidence)),
              assumption: String(parsed.assumption ?? fallback.assumption).slice(0, 120),
            };
          } catch {
            return fallback;
          }
        }),
      );
      json(res, 200, { branches });
      return true;
    }

    if (pathname === "/api/mirai/extract") {
      const body = await readBody(req);
      const text = String(body.text ?? "").slice(0, 4000);
      let characters;
      try {
        const output = await chat(
          [
            { role: "system", content: "你是 Mirai-Selene 的世界导入器。你只输出严格 JSON。" },
            {
              role: "user",
              content: [
                "从下面的文字里抽取角色。严格输出 JSON 数组，最多 6 个，每项包含 name、role、traits（一句话）。",
                "不要输出 markdown，不要解释，只输出 JSON。",
                `文字：\n${text}`,
              ].join("\n"),
            },
          ],
          { temperature: 0.3, max_tokens: 700 },
        );
        characters = parseArray(output)
          .slice(0, 6)
          .map((item) => ({
            name: String(item.name ?? "角色").slice(0, 20),
            role: String(item.role ?? "角色").slice(0, 30),
            traits: String(item.traits ?? "").slice(0, 80),
          }));
        if (!characters.length) throw new Error("empty");
      } catch {
        characters = text
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 6)
          .map((line, index) => {
            const parts = line.replace(/^[-*]\s*/, "").split(/[：:，,]/).map((p) => p.trim()).filter(Boolean);
            return {
              name: parts[0] || `角色 ${index + 1}`,
              role: parts[1] || "角色",
              traits: parts.slice(2).join("，") || "待补充",
            };
          });
      }
      json(res, 200, { characters });
      return true;
    }
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }

  return false;
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res, pathname) {
  if (!existsSync(ROOT)) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("dist/ 不存在。先跑 `npm run build`。");
    return;
  }

  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";

  // 目录穿越防护：normalize 后必须仍在 ROOT 内
  const target = normalize(join(ROOT, rel));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let file = target;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");

  // 无扩展名的路径尝试补 .html（/mirai-studio → mirai-studio.html）
  if (!existsSync(file) && !extname(file)) {
    const withHtml = `${file}.html`;
    if (existsSync(withHtml)) file = withHtml;
  }

  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>404</title>
<body style="font-family:system-ui;background:#07090f;color:#e8ecff;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-weight:600">404</h1>
<p style="color:#8b93b8">没有这个页面。回 <a href="/" style="color:#a8c4ff">首页</a>。</p></div></body>`);
    return;
  }

  const ext = extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const isHashed = /\/assets\/[^/]+-[A-Za-z0-9_-]{8}\./.test(file.replace(/\\/g, "/"));
  const size = statSync(file).size;
  const cache = isHashed ? "public, max-age=31536000, immutable" : "no-cache";

  // Range 支持：大视频没有它就不能拖进度条，Safari 甚至可能拒绝播放。
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const [startRaw, endRaw] = range.replace(/^bytes=/, "").split("-");
    let start = Number(startRaw);
    let end = endRaw ? Number(endRaw) : size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= size) end = size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": cache,
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    "Cache-Control": cache,
  });
  createReadStream(file).pipe(res);
}

/* ---------------- 启动 ---------------- */

/**
 * 跨域白名单：魔搭创空间（Studio）以 Bearer Token 调本机 API。
 *
 * 为什么不用 `*`：带 Authorization 的请求在 `*` 下会被浏览器拒绝；
 * 而且 token 认证天然免疫 CSRF，不需要放开任意来源。
 * 可用 MIRAI_CORS_ORIGINS 覆盖（逗号分隔）。
 */
const CORS_ORIGINS = new Set(
  (
    process.env.MIRAI_CORS_ORIGINS ??
    [
      "https://xiayuanovo-mirai-selene.ms.show",
      "https://modelscope.cn",
      "https://www.modelscope.cn",
    ].join(",")
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !CORS_ORIGINS.has(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const handler = async (req, res) => {
  const pathname = (req.url || "/").split("?")[0];
  const hasBearer = (req.headers.authorization || "").startsWith("Bearer ");

  if (pathname.startsWith("/api/") || pathname.startsWith("/mirai-api/") || pathname.startsWith("/mcp")) {
    applyCors(req, res);
  }

  // 同源策略：写操作只接受同源请求，挡掉 CSRF。
  // Bearer token 不是浏览器自动携带的凭据，不存在 CSRF 面，直接放行。
  if (
    !hasBearer &&
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    pathname.startsWith("/api/")
  ) {
    const origin = req.headers.origin;
    if (origin && !CORS_ORIGINS.has(origin)) {
      const host = req.headers.host ?? "";
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = "";
      }
      if (originHost !== host) {
        jsonOut(res, 403, { error: "跨站请求被拒绝" });
        return;
      }
    }
  }

  if (req.method === "OPTIONS") {
    const headers = {
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Max-Age": "86400",
    };
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.has(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // 自有域名下的短链入口：二维码印自己的域名，一跳进魔搭引擎 Demo。
  if (pathname === "/studio" || pathname === "/demo") {
    res.writeHead(302, {
      Location:
        process.env.MIRAI_STUDIO_URL || "https://xiayuanovo-mirai-selene.ms.show/",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (pathname === "/health" || pathname === "/api/health") {
    jsonOut(res, 200, { ok: true, model: MODEL, key: Boolean(KEY) });
    return;
  }

  // 远程 MCP：小浣熊用 Streamable HTTP 连进来，路径固定为 /mcp
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
    await handleMcpHttp(req, res);
    return;
  }

  // LLM 代理要放在通用 /api/ 之前，否则会被当成用户接口
  if (pathname.startsWith("/api/mirai/")) {
    if (pathname === "/api/mirai/act" && req.method === "POST") {
      await handleAct(req, res, { key: KEY, base: BASE, model: MODEL, readBody });
      return;
    }
    if (pathname === "/api/mirai/image" && req.method === "POST") {
      await handleImage(req, res, { key: KEY, readBody });
      return;
    }
    if (pathname === "/api/mirai/judge" && req.method === "POST") {
      await handleJudge(req, res, { key: KEY, base: BASE, model: MODEL, readBody });
      return;
    }
    if (pathname.startsWith("/api/mirai/pai/")) {
      await handlePai(req, res, pathname.slice("/api/mirai/pai/".length));
      return;
    }
    if (pathname.startsWith("/api/mirai/spec/") || pathname.startsWith("/api/mirai/assets/")) {
      await handleSpecRoute(req, res, pathname.slice("/api/mirai/".length));
      return;
    }
    if (pathname.startsWith("/api/mirai/forge/")) {
      await handleForge(req, res, pathname.slice("/api/mirai/forge/".length), db, ownerOf(req, db));
      return;
    }
    if (pathname.startsWith("/api/mirai/ingest/") || pathname.startsWith("/api/mirai/agent/")) {
      await handleSocialRoute(req, res, pathname, db, ownerOf(req, db));
      return;
    }
    if (pathname === "/api/mirai/game/shell") {
      await handleGame(req, res);
      return;
    }
    const handled = await handleApi(req, res, pathname);
    if (!handled) json(res, 404, { error: "unknown api route" });
    return;
  }

  // 用户系统与世界数据
  if (pathname.startsWith("/api/")) {
    try {
      const handled = await handleApiRoute({ db, req, res, pathname });
      if (!handled) jsonOut(res, 404, { error: "没有这个接口" });
    } catch (error) {
      const status = error?.status ?? 500;
      // 不把内部堆栈回给客户端
      jsonOut(res, status, { error: status === 500 ? "服务器出错了" : error.message });
      if (status === 500) console.error("[api]", error);
    }
    return;
  }

  // 前端写的是 /mirai-api/*（dev 时由 Vite 代理转发）。
  // 生产环境没有 Vite，这里必须自己接住，否则预测和对话会 404。
  if (pathname.startsWith("/mirai-api/")) {
    const normalized = pathname.replace(/^\/mirai-api\//, "/api/mirai/");
    if (normalized === "/api/mirai/act" && req.method === "POST") {
      await handleAct(req, res, { key: KEY, base: BASE, model: MODEL, readBody });
      return;
    }
    if (normalized === "/api/mirai/image" && req.method === "POST") {
      await handleImage(req, res, { key: KEY, readBody });
      return;
    }
    if (normalized === "/api/mirai/judge" && req.method === "POST") {
      await handleJudge(req, res, { key: KEY, base: BASE, model: MODEL, readBody });
      return;
    }
    if (normalized.startsWith("/api/mirai/pai/")) {
      await handlePai(req, res, normalized.slice("/api/mirai/pai/".length));
      return;
    }
    if (normalized.startsWith("/api/mirai/spec/") || normalized.startsWith("/api/mirai/assets/")) {
      await handleSpecRoute(req, res, normalized.slice("/api/mirai/".length));
      return;
    }
    if (normalized.startsWith("/api/mirai/forge/")) {
      await handleForge(req, res, normalized.slice("/api/mirai/forge/".length), db, ownerOf(req, db));
      return;
    }
    if (normalized.startsWith("/api/mirai/ingest/") || normalized.startsWith("/api/mirai/agent/")) {
      await handleSocialRoute(req, res, normalized, db, ownerOf(req, db));
      return;
    }
    if (normalized === "/api/mirai/game/shell") {
      await handleGame(req, res);
      return;
    }
    const handled = await handleApi(req, res, normalized);
    if (!handled) json(res, 404, { error: "unknown api route" });
    return;
  }

  // 当前世界的 H5 游戏壳：同一份图片与 API，不用构建
  if (pathname === "/game/current") {
    await handleGame(req, res);
    return;
  }

  // 生成的插画：同源发出（OSS 直链不允许跨域，img 加载不出来）
  if (pathname.startsWith("/mirai-art/")) {
    serveArt(req, res, pathname.slice("/mirai-art/".length));
    return;
  }

  serveStatic(req, res, pathname);
};

const server = http.createServer(handler);

// 每小时清一次过期会话、限流桶与过期作业
setInterval(() => {
  try {
    purgeExpiredSessions(db);
    purgeExpiredPasswordResets(db);
    sweepRateLimits();
    pruneAgentData(db);
  } catch (error) {
    console.error("[cleanup]", error);
  }
}, 60 * 60 * 1000).unref();
pruneAgentData(db);

server.listen(PORT, HOST, () => {
  console.log(`Mirai-Selene on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`  dist: ${ROOT}`);
  console.log(`  db:   ${DB_PATH}`);
  console.log(`  LLM:  ${KEY ? `${MODEL} (key set)` : "未配置 key（前端会落到本地分支）"}`);
});

// 有证书时同时监听 443 —— CDN 回源走 HTTPS 的情况必须这样，否则 ESA 报 connection_refused
if (TLS_CERT && TLS_KEY && existsSync(TLS_CERT) && existsSync(TLS_KEY)) {
  const tlsServer = https.createServer(
    { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) },
    handler,
  );
  tlsServer.listen(TLS_PORT, HOST, () => {
    console.log(`  TLS:  https://${HOST === "0.0.0.0" ? "localhost" : HOST}:${TLS_PORT}`);
  });
} else if (TLS_CERT || TLS_KEY) {
  console.warn("  TLS:  证书路径无效，只跑 HTTP");
}
