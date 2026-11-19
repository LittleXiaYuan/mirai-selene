/**
 * Mirai Dev Agent：浏览器里的 coding agent（aider 驱动）。
 *
 * 为什么不用 shell：开放的终端等于把 root 交出去；这里只暴露两件事——
 * 一句话任务、以及「改了哪些文件」的 diff。命令由 aider 在仓库里执行，
 * 不提供任意 shell 入口。
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.DEV_REPO || "/opt/mirai-dev/repo";
const PASS = process.env.AGENT_PASSWORD || "";
const AIDER = process.env.AIDER_BIN || "/opt/mirai-dev/venv/bin/aider";
const MODEL = process.env.AGENT_MODEL || "openai/gpt-4.1-mini";
const API_BASE = process.env.AGENT_API_BASE || "https://api.openai-next.com/v1";
const API_KEY = process.env.AGENT_API_KEY || "";
const PORT = Number(process.env.AGENT_PORT || 8090);

const jobs = new Map();
let seq = 0;

function eq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function authed(req) {
  if (!PASS) return false;
  const match = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!match) return false;
  const [user, pass] = Buffer.from(match[1], "base64").toString("utf8").split(":");
  return user === "dev" && eq(pass, PASS);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!Buffer.concat(chunks).length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function git(args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: REPO });
    let out = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (out += data));
    child.on("close", () => resolve(out.trim()));
  });
}

async function state() {
  const [branch, status, diff, last] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["status", "--short"]),
    git(["diff", "--stat"]),
    git(["log", "-1", "--pretty=%h %s"]),
  ]);
  return {
    repo: REPO,
    branch,
    model: MODEL,
    changed: status ? status.split("\n").slice(0, 40) : [],
    diffstat: diff,
    last,
  };
}

function startJob(message) {
  const id = `j${++seq}`;
  const job = { id, status: "running", output: "", started: Date.now() };
  jobs.set(id, job);
  if (jobs.size > 40) {
    const oldest = [...jobs.keys()].find((key) => jobs.get(key)?.status !== "running");
    if (oldest) jobs.delete(oldest);
  }

  const child = spawn(
    AIDER,
    [
      "--model", MODEL,
      "--openai-api-base", API_BASE,
      "--openai-api-key", API_KEY,
      "--yes-always",
      "--no-auto-commits",
      "--no-pretty",
      "--no-stream",
      "--map-tokens", "0",
      "--read", "AGENTS.md",
      "--message", message,
    ],
    { cwd: REPO, env: process.env },
  );

  const push = (text) => {
    job.output = (job.output + text).slice(-60_000);
  };
  child.stdout.on("data", (data) => push(data.toString("utf8")));
  child.stderr.on("data", (data) => push(data.toString("utf8")));
  child.on("error", (error) => {
    job.status = "failed";
    push(`\n[agent] ${error.message}`);
  });
  child.on("close", (code) => {
    job.status = code === 0 ? "done" : "failed";
    job.code = code;
    job.ms = Date.now() - job.started;
  });

  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // 已退出
    }
    if (job.status === "running") {
      job.status = "timeout";
      push("\n[agent] 超过 5 分钟，已停止。");
    }
  }, 5 * 60 * 1000);
  timer.unref();

  return job;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;

  if (path === "/health") {
    json(res, 200, { ok: true, model: MODEL, repo: REPO });
    return;
  }

  if (!authed(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="mirai-agent"' });
    res.end("auth required");
    return;
  }

  if (path === "/" || path === "/index.html") {
    const html = readFileSync(join(HERE, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
    return;
  }

  if (path === "/api/state" && req.method === "GET") {
    json(res, 200, await state());
    return;
  }

  if (path === "/api/chat" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      json(res, 400, { error: "bad json" });
      return;
    }
    const message = String(body.message || "").trim().slice(0, 4000);
    if (!message) {
      json(res, 400, { error: "说一句要改什么" });
      return;
    }
    const job = startJob(message);
    json(res, 202, { id: job.id });
    return;
  }

  const match = /^\/api\/job\/(\w+)$/.exec(path);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) {
      json(res, 404, { error: "没有这个任务" });
      return;
    }
    json(res, 200, { id: job.id, status: job.status, output: job.output, code: job.code, ms: job.ms });
    return;
  }

  if (path === "/api/undo" && req.method === "POST") {
    await git(["checkout", "--", "."]);
    json(res, 200, { ok: true, state: await state() });
    return;
  }

  if (path === "/api/commit" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      body = {};
    }
    const message = String(body.message || "dev agent: update").slice(0, 200);
    await git(["add", "-A"]);
    const out = await git(["commit", "-m", message]);
    json(res, 200, { ok: true, out, state: await state() });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dev agent on http://127.0.0.1:${PORT} · repo=${REPO} · model=${MODEL}`);
});
