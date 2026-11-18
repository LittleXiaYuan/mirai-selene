/**
 * 认证：scrypt 密码哈希 + 随机 session token。
 *
 * 选择 scrypt 而不是 bcrypt：node:crypto 内置，零依赖，参数可控。
 * token 存库而不是签名 JWT：这样才能主动踢人下线（改密码后旧会话失效）。
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

// N=16384, r=8, p=1 —— OWASP 推荐的下限，单次约 50-80ms
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 天

export const SESSION_COOKIE = "mirai_sid";

export async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const key = await scrypt(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return { hash: key.toString("hex"), salt };
}

export async function verifyPassword(password, salt, expectedHex) {
  try {
    const { hash } = await hashPassword(password, salt);
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(expectedHex, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export function newToken() {
  return randomBytes(32).toString("base64url");
}

export const sessionTtl = SESSION_TTL_MS;

/* ---------------- cookie ---------------- */

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function sessionCookie(token, { secure }) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  // 生产走 HTTPS 时必须加 Secure；本地 http 调试不加，否则浏览器不保存
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* ---------------- 校验 ---------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateRegister({ email, name, password }) {
  const errors = [];
  if (!email || !EMAIL_RE.test(email)) errors.push("邮箱格式不对");
  if (!name || name.trim().length < 1 || name.trim().length > 24) errors.push("名字要 1–24 个字");
  if (!password || password.length < 8) errors.push("密码至少 8 位");
  if (password && password.length > 200) errors.push("密码太长");
  return errors;
}

/** 简单的内存限流：按 IP + 动作计数，防暴力破解。 */
const buckets = new Map();

export function rateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  entry.count += 1;
  if (entry.count > limit) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: limit - entry.count };
}

/** 定期清理，防止 Map 无限增长 */
export function sweepRateLimits() {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (now > v.resetAt) buckets.delete(k);
  }
}
