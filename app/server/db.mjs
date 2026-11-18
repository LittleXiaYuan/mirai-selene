/**
 * 数据层：SQLite（Node 22 内置 node:sqlite），零外部依赖。
 *
 * 表设计刻意最小化：
 *   users     —— 账号与密码哈希
 *   sessions  —— 登录态（token 存库，可主动失效）
 *   worlds    —— 世界数据（tree 存 JSON，与前端 World File 同构）
 *
 * 为什么不把 tree 拆表：世界树是一个整体，拆开反而要在服务端重建合并语义，
 * 而合并语义已经在前端引擎里验证过 26 个测试。服务端只负责存和取。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id         TEXT PRIMARY KEY,
  owner_key  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_owner ON agent_runs(owner_key, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_sessions (
  id         TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * worlds 的主键是 (user_id, id)，不是 id 单独一个。
 *
 * 世界 id 由客户端生成，两个用户完全可能撞同一个 id。
 * 单列主键会让后写入的人拿到 500（UNIQUE constraint），
 * 这是他无法理解、也无法修复的错误。
 */
const WORLDS_V2 = `
CREATE TABLE IF NOT EXISTS worlds_v2 (
  id         TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  hook       TEXT NOT NULL DEFAULT '',
  characters TEXT NOT NULL DEFAULT '[]',
  tree       TEXT NOT NULL,
  cursor     TEXT NOT NULL,
  is_public  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_worlds_user_v2 ON worlds_v2(user_id);
CREATE INDEX IF NOT EXISTS idx_worlds_public_v2 ON worlds_v2(is_public);
`;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrateWorlds(db);
  return db;
}

function migrateWorlds(db) {
  const version = Number(db.prepare("PRAGMA user_version").get().user_version ?? 0);

  if (version >= 2) {
    db.exec(WORLDS_V2);
    return;
  }

  // 旧表可能是 id 单列主键，迁移到 (user_id, id)
  const hasOld = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worlds'")
    .get();

  db.exec(WORLDS_V2);

  if (hasOld) {
    // 旧数据里可能已经有 id 冲突，用 INSERT OR IGNORE 保证迁移不失败
    db.exec(`
      INSERT OR IGNORE INTO worlds_v2
        (id, user_id, name, hook, characters, tree, cursor, is_public, created_at, updated_at)
      SELECT id, user_id, name, hook, characters, tree, cursor, is_public, created_at, updated_at
      FROM worlds;
      DROP TABLE worlds;
    `);
  }

  db.exec("PRAGMA user_version = 2");
}

/* ---------------- users ---------------- */

export function createUser(db, { id, email, name, passwordHash, salt }) {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, email.toLowerCase(), name, passwordHash, salt, now);
  return { id, email: email.toLowerCase(), name, createdAt: now };
}

export function findUserByEmail(db, email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
}

export function findUserById(db, id) {
  return db.prepare("SELECT id, email, name, created_at FROM users WHERE id = ?").get(id);
}

/** 只改展示名。邮箱是登录标识，不在这里动。 */
export function updateUserName(db, id, name) {
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id);
  return findUserById(db, id);
}

/* ---------------- sessions ---------------- */

export function createSession(db, { token, userId, ttlMs }) {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(token, userId, now.toISOString(), expires.toISOString());
  return expires;
}

export function findSession(db, token) {
  const row = db
    .prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?")
    .get(token, new Date().toISOString());
  return row ?? null;
}

export function deleteSession(db, token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function purgeExpiredSessions(db) {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
}

/** 改密码/重置密码后，让该用户所有设备的会话失效。 */
export function deleteSessionsForUser(db, userId) {
  const res = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return Number(res.changes ?? 0);
}

export function updateUserPassword(db, id, passwordHash, salt) {
  db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").run(
    passwordHash,
    salt,
    id,
  );
  return findUserById(db, id);
}

/* ---------------- 密码重置令牌 ---------------- */

export function createPasswordReset(db, { token, userId, ttlMs }) {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  db.prepare(
    "INSERT INTO password_resets (token, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)",
  ).run(token, userId, now.toISOString(), expires.toISOString());
  return expires.toISOString();
}

export function findPasswordReset(db, token) {
  return (
    db
      .prepare(
        "SELECT * FROM password_resets WHERE token = ? AND used_at IS NULL AND expires_at > ?",
      )
      .get(token, new Date().toISOString()) ?? null
  );
}

export function consumePasswordReset(db, token) {
  const res = db
    .prepare("UPDATE password_resets SET used_at = ? WHERE token = ? AND used_at IS NULL")
    .run(new Date().toISOString(), token);
  return Number(res.changes ?? 0) > 0;
}

export function purgeExpiredPasswordResets(db) {
  db.prepare("DELETE FROM password_resets WHERE expires_at <= ?").run(new Date().toISOString());
}

/* ---------------- worlds ---------------- */

export function listWorlds(db, userId) {
  return db
    .prepare(
      "SELECT id, name, hook, characters, tree, cursor, is_public, created_at, updated_at FROM worlds_v2 WHERE user_id = ? ORDER BY updated_at DESC",
    )
    .all(userId)
    .map(rowToWorld);
}

export function getWorld(db, id, userId) {
  const row = db
    .prepare("SELECT * FROM worlds_v2 WHERE id = ? AND user_id = ?")
    .get(id, userId);
  return row ? rowToWorld(row) : null;
}

export function getPublicWorld(db, id) {
  const row = db.prepare("SELECT * FROM worlds_v2 WHERE id = ? AND is_public = 1 LIMIT 1").get(id);
  return row ? rowToWorld(row) : null;
}

export function upsertWorld(db, userId, world) {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id, created_at FROM worlds_v2 WHERE id = ? AND user_id = ?")
    .get(world.id, userId);

  const characters = JSON.stringify(world.characters ?? []);
  const tree = JSON.stringify(world.tree);
  const isPublic = world.isPublic ? 1 : 0;

  if (existing) {
    db.prepare(
      `UPDATE worlds_v2 SET name = ?, hook = ?, characters = ?, tree = ?, cursor = ?, is_public = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(world.name, world.hook ?? "", characters, tree, world.cursor, isPublic, now, world.id, userId);
    return { ...world, isPublic: Boolean(isPublic), createdAt: existing.created_at, updatedAt: now };
  }

  db.prepare(
    `INSERT INTO worlds_v2 (id, user_id, name, hook, characters, tree, cursor, is_public, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(world.id, userId, world.name, world.hook ?? "", characters, tree, world.cursor, isPublic, now, now);
  return { ...world, isPublic: Boolean(isPublic), createdAt: now, updatedAt: now };
}

export function deleteWorld(db, id, userId) {
  const res = db.prepare("DELETE FROM worlds_v2 WHERE id = ? AND user_id = ?").run(id, userId);
  return res.changes > 0;
}

export function countWorlds(db, userId) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM worlds_v2 WHERE user_id = ?").get(userId);
  return Number(row.n);
}

function rowToWorld(row) {
  return {
    id: row.id,
    name: row.name,
    hook: row.hook,
    characters: safeParse(row.characters, []),
    tree: safeParse(row.tree, null),
    cursor: row.cursor,
    isPublic: Boolean(row.is_public),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
