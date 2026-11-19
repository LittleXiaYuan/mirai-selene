/**
 * API 路由：认证 + 世界数据。
 *
 * 设计原则：
 *   · 未登录也能用 —— 评委打开就能走示例世界，不强制注册；
 *   · 登录后世界存服务端，多设备可见；
 *   · 所有写操作都校验归属，别人的世界改不到。
 */

import {
  clearCookie,
  hashPassword,
  newId,
  newToken,
  parseCookies,
  rateLimit,
  sessionCookie,
  sessionTtl,
  validateRegister,
  verifyPassword,
  SESSION_COOKIE,
} from "./auth.mjs";
import {
  countWorlds,
  createPasswordReset,
  createSession,
  createUser,
  consumePasswordReset,
  deleteSession,
  deleteSessionsForUser,
  deleteWorld,
  findPasswordReset,
  findSession,
  findUserByEmail,
  findUserById,
  getWallet,
  grantCredits,
  getWorld,
  listOrders,
  listWorlds,
  purchaseListing,
  statsSnapshot,
  updateUserName,
  updateUserPassword,
  upsertWorld,
} from "./db.mjs";
import { appUrl, mailConfigured, sendMail } from "./mail.mjs";
import { findListing, MARKET_LISTINGS } from "./market.mjs";

const MAX_WORLDS_PER_USER = 200;

export function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

export async function readJson(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("invalid json"), { status: 400 });
  }
}

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** 判断是否该给 cookie 加 Secure —— 由反向代理传来的协议头决定。 */
export function isSecure(req) {
  return (
    req.headers["x-forwarded-proto"] === "https" ||
    process.env.MIRAI_SECURE_COOKIE === "1"
  );
}

export function currentUser(db, req) {
  // 双通道认证：浏览器主站走 HttpOnly Cookie；魔搭 Studio 等跨站客户端走
  // Bearer token（Cookie 在第三方上下文里会被 SameSite/浏览器策略拦掉）。
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const cookies = parseCookies(req.headers.cookie);
  const token = bearer || cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = findSession(db, token);
  if (!session) return null;
  const user = findUserById(db, session.user_id);
  return user ? { user, token } : null;
}

/**
 * 处理 /api/*。
 * 返回 true 表示已处理，false 表示不是 API 路由。
 */
export async function handleApiRoute({ db, req, res, pathname }) {
  /* ---------------- 认证 ---------------- */

  if (pathname === "/api/auth/register" && req.method === "POST") {
    const ip = clientIp(req);
    const rl = rateLimit(`register:${ip}`, { limit: 8, windowMs: 60_000 });
    if (!rl.ok) return json(res, 429, { error: `请求太频繁，${rl.retryAfter} 秒后再试` }), true;

    const body = await readJson(req);
    const email = String(body.email ?? "").trim();
    const name = String(body.name ?? "").trim();
    const password = String(body.password ?? "");

    const errors = validateRegister({ email, name, password });
    if (errors.length) return json(res, 400, { error: errors.join("；") }), true;

    if (findUserByEmail(db, email)) {
      return json(res, 409, { error: "这个邮箱已经注册过了" }), true;
    }

    const { hash, salt } = await hashPassword(password);
    const user = createUser(db, { id: newId("u"), email, name, passwordHash: hash, salt });
    // 新账号给 300 体验额度：买得动两份付费世界，走完一次真的扣款与订单。
    grantCredits(db, user.id, 300, "signup");
    const token = newToken();
    createSession(db, { token, userId: user.id, ttlMs: sessionTtl });

    return (
      json(
        res,
        201,
        {
          user: { id: user.id, email: user.email, name: user.name },
          worlds: [],
          // 跨站客户端（魔搭 Studio 等）用这个 token，浏览器主站仍以 Cookie 为准。
          token,
        },
        { "Set-Cookie": sessionCookie(token, { secure: isSecure(req) }) },
      ),
      true
    );
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const ip = clientIp(req);
    const rl = rateLimit(`login:${ip}`, { limit: 12, windowMs: 60_000 });
    if (!rl.ok) return json(res, 429, { error: `尝试太频繁，${rl.retryAfter} 秒后再试` }), true;

    const body = await readJson(req);
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");

    const row = findUserByEmail(db, email);
    // 无论邮箱存不存在，都走一次哈希，避免通过响应时间探测账号
    const ok = row
      ? await verifyPassword(password, row.salt, row.password_hash)
      : await verifyPassword(password, "x".repeat(32), "0".repeat(128));

    if (!row || !ok) {
      return json(res, 401, { error: "邮箱或密码不对" }), true;
    }

    const token = newToken();
    createSession(db, { token, userId: row.id, ttlMs: sessionTtl });
    return (
      json(
        res,
        200,
        {
          user: { id: row.id, email: row.email, name: row.name },
          worlds: listWorlds(db, row.id),
          token,
        },
        { "Set-Cookie": sessionCookie(token, { secure: isSecure(req) }) },
      ),
      true
    );
  }

  /**
   * 邮箱链接登录（演示版）。
   *
   * Arc login-immersive 的流程是「发链接 → 打开邮箱 → 登录」。本地没有邮件服务，
   * 所以这里把「链接已点开」直接落成一次会话；生产环境应改为一次性 token + 真实邮件。
   * 设 MIRAI_MAGIC_LOGIN=0 可以关掉。
   */
  if (pathname === "/api/auth/magic" && req.method === "POST") {
    if (process.env.MIRAI_MAGIC_LOGIN !== "1") {
      return json(res, 404, { error: "邮箱链接登录没有开启" }), true;
    }
    const ip = clientIp(req);
    const rl = rateLimit(`magic:${ip}`, { limit: 10, windowMs: 60_000 });
    if (!rl.ok) return json(res, 429, { error: `请求太频繁，${rl.retryAfter} 秒后再试` }), true;

    const body = await readJson(req);
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return json(res, 400, { error: "邮箱格式不对" }), true;
    }

    let row = findUserByEmail(db, email);
    if (!row) {
      const random = newToken() + newToken();
      const { hash, salt } = await hashPassword(random);
      row = createUser(db, {
        id: newId("u"),
        email,
        name: email.split("@")[0].slice(0, 32),
        passwordHash: hash,
        salt,
      });
    }

    const token = newToken();
    createSession(db, { token, userId: row.id, ttlMs: sessionTtl });
    return (
      json(
        res,
        200,
        {
          user: { id: row.id, email: row.email, name: row.name },
          worlds: listWorlds(db, row.id),
          token,
        },
        { "Set-Cookie": sessionCookie(token, { secure: isSecure(req) }) },
      ),
      true
    );
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const header = req.headers.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const cookies = parseCookies(req.headers.cookie);
    // Cookie 与 Bearer 可能同时存在；两个都失效，避免跨端残留会话。
    for (const token of [bearer, cookies[SESSION_COOKIE]]) {
      if (token) deleteSession(db, token);
    }
    return (
      json(res, 200, { ok: true }, { "Set-Cookie": clearCookie() }),
      true
    );
  }

  if (pathname === "/api/auth/me" && req.method === "GET") {
    const auth = currentUser(db, req);
    if (!auth) return json(res, 200, { user: null, worlds: [] }), true;
    return (
      json(res, 200, {
        user: {
          id: auth.user.id,
          email: auth.user.email,
          name: auth.user.name,
          createdAt: auth.user.created_at,
        },
        // 档案与数据都按 user_id 隔离：这里返回的只是这个人自己的世界。
        worlds: listWorlds(db, auth.user.id),
        worldCount: countWorlds(db, auth.user.id),
      }),
      true
    );
  }

  if (pathname === "/api/auth/profile" && req.method === "PATCH") {
    const auth = currentUser(db, req);
    if (!auth) return json(res, 401, { error: "请先登录" }), true;
    const rl = rateLimit(`profile:${auth.user.id}`, { limit: 10, windowMs: 60_000 });
    if (!rl.ok) return json(res, 429, { error: `改得太频繁，${rl.retryAfter} 秒后再试` }), true;

    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 24) {
      return json(res, 400, { error: "名字要 1–24 个字" }), true;
    }
    const updated = updateUserName(db, auth.user.id, name);
    return (
      json(res, 200, {
        user: {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          createdAt: updated.created_at,
        },
      }),
      true
    );
  }

  if (pathname === "/api/auth/password" && req.method === "PATCH") {
    const auth = currentUser(db, req);
    if (!auth) return json(res, 401, { error: "请先登录" }), true;
    const rl = rateLimit(`password:${auth.user.id}`, { limit: 6, windowMs: 60_000 });
    if (!rl.ok) return json(res, 429, { error: `改得太频繁，${rl.retryAfter} 秒后再试` }), true;

    const body = await readJson(req);
    const current = String(body.current ?? "");
    const next = String(body.password ?? body.next ?? "");
    if (next.length < 8 || next.length > 200) {
      return json(res, 400, { error: "新密码要 8–200 位" }), true;
    }

    const row = findUserByEmail(db, auth.user.email);
    const ok = row ? await verifyPassword(current, row.salt, row.password_hash) : false;
    if (!ok) return json(res, 401, { error: "当前密码不对" }), true;

    const { hash, salt } = await hashPassword(next);
    updateUserPassword(db, auth.user.id, hash, salt);
    // 改密后其他设备全部下线，只保留本次会话。
    deleteSessionsForUser(db, auth.user.id);
    const token = newToken();
    createSession(db, { token, userId: auth.user.id, ttlMs: sessionTtl });
    return (
      json(
        res,
        200,
        { ok: true, token },
        { "Set-Cookie": sessionCookie(token, { secure: isSecure(req) }) },
      ),
      true
    );
  }

  if (pathname === "/api/auth/forgot" && req.method === "POST") {
    const ip = clientIp(req);
    const rl = rateLimit(`forgot:${ip}`, { limit: 6, windowMs: 60_000 });
    if (!rl.ok) return json(res, 429, { error: `请求太频繁，${rl.retryAfter} 秒后再试` }), true;

    const body = await readJson(req);
    const email = String(body.email ?? "").trim().toLowerCase();
    const row = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? findUserByEmail(db, email) : null;

    // 无论邮箱是否存在都回同样的结果，避免用来探测账号。
    if (row && mailConfigured()) {
      const token = newToken();
      createPasswordReset(db, { token, userId: row.id, ttlMs: 30 * 60 * 1000 });
      const link = `${appUrl()}/?reset=${encodeURIComponent(token)}`;
      void sendMail({
        to: row.email,
        subject: "Mirai-Selene · 重置密码",
        text: [
          "有人请求重置这个邮箱在 Mirai-Selene 的密码。",
          "",
          `30 分钟内有效：${link}`,
          "",
          "如果这不是你发起的，忽略这封邮件即可，密码不会改变。",
        ].join("\n"),
      });
    }

    return json(res, 200, { ok: true, mailConfigured: mailConfigured() }), true;
  }

  if (pathname === "/api/auth/reset" && req.method === "POST") {
    const ip = clientIp(req);
    const rl = rateLimit(`reset:${ip}`, { limit: 10, windowMs: 60_000 });
    if (!rl.ok) return json(res, 429, { error: `请求太频繁，${rl.retryAfter} 秒后再试` }), true;

    const body = await readJson(req);
    const token = String(body.token ?? "").trim();
    const password = String(body.password ?? "");
    if (password.length < 8 || password.length > 200) {
      return json(res, 400, { error: "新密码要 8–200 位" }), true;
    }
    const record = findPasswordReset(db, token);
    if (!record) return json(res, 400, { error: "链接无效或已过期" }), true;

    const { hash, salt } = await hashPassword(password);
    updateUserPassword(db, record.user_id, hash, salt);
    consumePasswordReset(db, token);
    deleteSessionsForUser(db, record.user_id);
    return json(res, 200, { ok: true }), true;
  }

  if (pathname === "/api/auth/email/status" && req.method === "GET") {
    return json(res, 200, { configured: mailConfigured(), appUrl: appUrl() }), true;
  }

  /* ---------------- 魔搭中转探针 ---------------- */

  if (pathname === "/api/relay/health" && req.method === "GET") {
    const token = process.env.MODELSCOPE_API_TOKEN || "";
    const base = process.env.MIRAI_RELAY_URL || "https://studio-xiayuanovo-mirai-selene.api-inference.modelscope.net";
    if (!token) return json(res, 200, { ok: false, reason: "relay-token-missing" }), true;
    try {
      const upstream = await fetch(`${base.replace(/\/+$/, "")}/relay/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(6000),
      });
      const data = await upstream.json().catch(() => ({}));
      return json(res, 200, {
        ok: upstream.ok && data.ok !== false,
        modelAttached: Boolean(data.model_attached),
        host: new URL(base).host,
        writes: Number(data.writes ?? 0),
      }), true;
    } catch {
      return json(res, 200, { ok: false, reason: "relay-unreachable" }), true;
    }
  }

  /* ---------------- 公开统计 ---------------- */

  if (pathname === "/api/stats" && req.method === "GET") {
    return json(res, 200, statsSnapshot(db)), true;
  }

  /* ---------------- 钱包与世界市场 ---------------- */

  if (pathname === "/api/wallet" && req.method === "GET") {
    const auth = currentUser(db, req);
    if (!auth) return json(res, 401, { error: "请先登录" }), true;
    return json(res, 200, {
      balance: getWallet(db, auth.user.id).balance,
      orders: listOrders(db, auth.user.id),
    }), true;
  }

  if (pathname === "/api/market" && req.method === "GET") {
    const auth = currentUser(db, req);
    const orders = auth ? listOrders(db, auth.user.id) : [];
    const owned = new Set(orders.map((order) => order.listingId));
    return json(res, 200, {
      signedIn: Boolean(auth),
      balance: auth ? getWallet(db, auth.user.id).balance : null,
      listings: MARKET_LISTINGS.map((listing) => ({ ...listing, owned: owned.has(listing.id) })),
    }), true;
  }

  if (pathname === "/api/market/purchase" && req.method === "POST") {
    const auth = currentUser(db, req);
    if (!auth) return json(res, 401, { error: "请先登录再购买" }), true;
    const body = await readJson(req, 10_000);
    const listing = findListing(String(body.id ?? ""));
    if (!listing) return json(res, 404, { error: "没有这份世界" }), true;
    const result = purchaseListing(db, auth.user.id, listing);
    if (!result.ok) return json(res, 402, result), true;
    return json(res, 200, { ...result, listing }), true;
  }

  /* ---------------- 世界 ---------------- */

  if (pathname === "/api/worlds") {
    const auth = currentUser(db, req);
    if (!auth) return json(res, 401, { error: "请先登录" }), true;

    if (req.method === "GET") {
      return json(res, 200, { worlds: listWorlds(db, auth.user.id) }), true;
    }

    if (req.method === "POST") {
      if (countWorlds(db, auth.user.id) >= MAX_WORLDS_PER_USER) {
        return json(res, 400, { error: `最多 ${MAX_WORLDS_PER_USER} 个世界` }), true;
      }
      const body = await readJson(req);
      const bad = validateWorld(body);
      if (bad) return json(res, 400, { error: bad }), true;
      const saved = upsertWorld(db, auth.user.id, {
        id: body.id || newId("w"),
        name: body.name,
        hook: body.hook ?? "",
        characters: body.characters ?? [],
        tree: body.tree,
        cursor: body.cursor,
        isPublic: Boolean(body.isPublic),
      });
      return json(res, 201, { world: saved }), true;
    }
  }

  const worldMatch = pathname.match(/^\/api\/worlds\/([\w-]+)$/);
  if (worldMatch) {
    const auth = currentUser(db, req);
    if (!auth) return json(res, 401, { error: "请先登录" }), true;
    const id = worldMatch[1];

    if (req.method === "GET") {
      const world = getWorld(db, id, auth.user.id);
      return world ? (json(res, 200, { world }), true) : (json(res, 404, { error: "没有这个世界" }), true);
    }

    if (req.method === "PUT") {
      const body = await readJson(req);
      if (body.tree === undefined) return json(res, 400, { error: "缺少世界数据" }), true;
      const bad = validateWorld({ ...body, id });
      if (bad) return json(res, 400, { error: bad }), true;
      const saved = upsertWorld(db, auth.user.id, {
        id,
        name: body.name,
        hook: body.hook ?? "",
        characters: body.characters ?? [],
        tree: body.tree,
        cursor: body.cursor,
        isPublic: Boolean(body.isPublic),
      });
      return json(res, 200, { world: saved }), true;
    }

    if (req.method === "DELETE") {
      const ok = deleteWorld(db, id, auth.user.id);
      return ok ? (json(res, 200, { ok: true }), true) : (json(res, 404, { error: "没有这个世界" }), true);
    }
  }

  /* ---------------- 公开世界（分享给评委） ---------------- */

  const publicMatch = pathname.match(/^\/api\/public\/([\w-]+)$/);
  if (publicMatch && req.method === "GET") {
    // 需要 getPublicWorld，这里延迟引用避免循环
    const { getPublicWorld } = await import("./db.mjs");
    const world = getPublicWorld(db, publicMatch[1]);
    return world
      ? (json(res, 200, { world }), true)
      : (json(res, 404, { error: "这个世界没有公开" }), true);
  }

  return false;
}

function validateWorld(body) {
  if (!body || typeof body !== "object") return "世界数据格式不对";
  if (!body.name || String(body.name).length > 60) return "世界名要 1–60 个字";
  if (!body.tree || typeof body.tree !== "object") return "缺少世界线数据";
  if (!body.tree.nodes || typeof body.tree.nodes !== "object") return "世界线数据不完整";
  if (!body.cursor) return "缺少当前节点";
  const nodeCount = Object.keys(body.tree.nodes).length;
  if (nodeCount > 5000) return "世界太大（节点超过 5000）";
  return null;
}
