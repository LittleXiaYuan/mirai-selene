/**
 * 让世界画一张这一幕的插画。
 *
 * 它是「第二层」：程序化渲染器已经在实时出画面了，
 * 这张图晚十几秒到，淡入盖上去。到不了就一直是渲染器那层。
 * 所以这里允许慢、允许失败，不阻塞叙事。
 *
 * 用内存缓存：同一个场景描述只画一次，避免重复花钱。
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

const CACHE = new Map();
const MAX = 60;

// 图片落盘缓存：OSS 直链不允许跨域，浏览器里 <img> 加载不出来，
// 所以由服务端抓一次、存本地、用同源地址发出去。
const ART_DIR = process.env.MIRAI_ART_DIR || join(process.cwd(), "data", "art");
let artDirReady = false;

function ensureArtDir() {
  if (artDirReady) return;
  mkdirSync(ART_DIR, { recursive: true });
  artDirReady = true;
}

const ART_HASH = (key) => createHash("sha1").update(key).digest("hex").slice(0, 20);

function artPath(key, ext = "jpg") {
  return join(ART_DIR, `${ART_HASH(key)}.${ext}`);
}

function findArt(key) {
  for (const ext of ["png", "jpg", "webp"]) {
    const file = artPath(key, ext);
    if (existsSync(file)) return `/mirai-art/${basename(file)}`;
  }
  return null;
}

/** 把远端图抓下来存本地，返回同源路径。 */
export async function cacheArt(key, remoteUrl, timeoutMs = 45_000) {
  ensureArtDir();
  const file = artPath(key);
  if (existsSync(file)) return `/mirai-art/${basename(file)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(remoteUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`art fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error("art too small");
    writeFileSync(file, buf);
    return `/mirai-art/${basename(file)}`;
  } finally {
    clearTimeout(timer);
  }
}

const ART_MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export function serveArt(req, res, name) {
  ensureArtDir();
  const safe = name.replace(/[^a-z0-9.]/gi, "");
  const file = join(ART_DIR, safe);
  if (!existsSync(file)) {
    res.writeHead(404).end("not found");
    return true;
  }
  const ext = (safe.split(".").pop() || "jpg").toLowerCase();
  res.writeHead(200, {
    "Content-Type": ART_MIME[ext] || "image/jpeg",
    // 内容由 key 决定，不会变，可以长缓存
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(readFileSync(file));
  return true;
}

function cacheKey(p) {
  // 与舞台的缓存口径一致：一个地点在一种天气下只画一次。
  // 同一地点不同台词的构图差异交给前端淡入，不重复花钱。
  return [p.place, p.weather].join("|");
}

function stylePrompt(p) {
  return [
    "cinematic still, cinematic lighting, shallow depth of field, film grain, muted colors",
    "no text, no watermark, no people facing camera",
    p.scene ? p.scene : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function buildPrompt(p) {
  const where = p.place || "一间屋子";
  const when = p.time || "黄昏";
  const mood = p.mood || "安静";
  const weather = p.weather || "";
  const who = (p.characters ?? []).slice(0, 2).map((c) => `${c.name}（${c.role}）`).join("、");
  return [
    `${where}，${when}，${weather}，气氛${mood}。`,
    who ? `画面里可能出现：${who}。` : "",
    "中国当代城市或普通室内，真实质感，不要奇幻元素。",
    "cinematic still, 35mm, natural light, shallow depth of field, muted palette, film grain.",
    "no text, no watermark, no logos.",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function handleImage(req, res, { key, readBody }) {
  const send = (status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(body));
  };

  if (!key && !process.env.CREDIT_MEDIA_API_KEY) {
    send(200, { url: null, reason: "no-key" });
    return;
  }

  let body;
  try {
    body = await readBody(req, 200_000);
  } catch {
    send(400, { url: null, reason: "bad-body" });
    return;
  }

  const ALLOWED_RATIOS = new Set(["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16"]);
  const ratio = ALLOWED_RATIOS.has(String(body.aspectRatio)) ? String(body.aspectRatio) : "16:9";

  const payload = {
    place: String(body.place ?? "").slice(0, 24),
    time: String(body.time ?? "").slice(0, 8),
    mood: String(body.mood ?? "").slice(0, 8),
    weather: String(body.weather ?? "").slice(0, 8),
    worldName: String(body.worldName ?? "").slice(0, 40),
    characters: Array.isArray(body.characters) ? body.characters.slice(0, 2) : [],
    scene: String(body.scene ?? "").slice(0, 300),
  };

  const keyCache = cacheKey(payload);
  const hit = CACHE.get(keyCache);
  if (hit) {
    send(200, { url: hit, cached: true });
    return;
  }

  // 没进内存缓存但盘上有，也不用重画
  ensureArtDir();
  const onDisk = findArt(keyCache);
  if (onDisk) {
    CACHE.set(keyCache, onDisk);
    send(200, { url: onDisk, cached: true });
    return;
  }

  const prompt = payload.scene
    ? `${payload.scene}，${stylePrompt(payload)}`
    : buildPrompt(payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  const creditKey = process.env.CREDIT_MEDIA_API_KEY || "";
  const creditBase = (process.env.CREDIT_MEDIA_BASE_URL || "https://api.openai-next.com").replace(/\/+$/, "");
  const creditModel = process.env.CREDIT_IMAGE_MODEL || "gemini-3.1-flash-image";

  if (creditKey) {
    try {
      const upstream = await fetch(`${creditBase}/v1/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creditKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: creditModel, prompt: prompt.slice(0, 1200), n: 1 }),
        signal: controller.signal,
      });
      const data = await upstream.json().catch(() => ({}));
      const item = data?.data?.[0] ?? null;
      if (upstream.ok && item) {
        ensureArtDir();
        let local = null;
        if (item.b64_json) {
          const buf = Buffer.from(item.b64_json, "base64");
          if (buf.length > 1024) {
            const ext = buf[0] === 0x89 ? "png" : buf[0] === 0xff ? "jpg" : "png";
            const file = artPath(keyCache, ext);
            writeFileSync(file, buf);
            local = `/mirai-art/${basename(file)}`;
          }
        } else if (item.url) {
          local = await cacheArt(keyCache, item.url);
        }
        if (local) {
          if (CACHE.size >= MAX) {
            const oldest = CACHE.keys().next().value;
            if (oldest !== undefined) CACHE.delete(oldest);
          }
          CACHE.set(keyCache, local);
          send(200, { url: local, prompt, provider: `credit:${creditModel}` });
          return;
        }
      }
      // 额度/模型问题就往下走 MiniMax，不在这里报死
    } catch {
      // 超时或网络失败也继续回退
    }
  }

  try {
    const upstream = await fetch("https://api.minimax.chat/v1/image_generation", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "image-01",
        prompt: prompt.slice(0, 1200),
        aspect_ratio: ratio,
        n: 1,
        prompt_optimizer: true,
      }),
      signal: controller.signal,
    });
    const data = await upstream.json().catch(() => ({}));
    const url = data?.data?.image_urls?.[0] ?? null;

    if (!upstream.ok || !url) {
      send(200, {
        url: null,
        reason: data?.base_resp?.status_msg || `http-${upstream.status}`,
      });
      return;
    }

    // 抓到本地再发出去。
    // OSS 直链不允许跨域（带 Origin 头会 403），浏览器里 <img> 加载不出来，
    // 所以必须由服务端代理成同源地址。
    let local;
    try {
      local = await cacheArt(keyCache, url);
    } catch (error) {
      send(200, {
        url: null,
        reason: `art-cache: ${error instanceof Error ? error.message : "failed"}`,
      });
      return;
    }

    if (CACHE.size >= MAX) {
      const oldest = CACHE.keys().next().value;
      if (oldest !== undefined) CACHE.delete(oldest);
    }
    CACHE.set(keyCache, local);

    send(200, { url: local, prompt });
  } catch (error) {
    send(200, {
      url: null,
      reason: error instanceof Error ? error.message : "failed",
    });
  } finally {
    clearTimeout(timer);
  }
}
