/**
 * 服务端的世界仓库：热重载的唯一入口。
 *
 * 一份 Spec 就是一个世界；POST 新 Spec 会把版本号 +1，
 * 前端轮询 /mirai-api/spec/current 看到版本变化就地切世界，不用重启进程。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.MIRAI_SPEC_FILE || resolve(__dirname, "..", "data", "current-spec.json");

const STANCES = new Set([
  "empathetic",
  "neutral",
  "probe_blindspot",
  "skeptical_push",
  "counter_bluff",
  "rupture",
]);

let state = { version: 0, spec: null, updatedAt: 0 };

function persist() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state), "utf8");
  } catch {
    // 只读环境也能跑，热重载在内存里仍然有效
  }
}

function restore() {
  try {
    if (!existsSync(FILE)) return;
    const saved = JSON.parse(readFileSync(FILE, "utf8"));
    if (saved?.spec) state = { version: Number(saved.version || 1), spec: saved.spec, updatedAt: Number(saved.updatedAt || 0) };
  } catch {
    state = { version: 0, spec: null, updatedAt: 0 };
  }
}
restore();

export function currentSpec() {
  return { ...state };
}

export function specHealth() {
  return {
    ok: true,
    version: state.version,
    world: state.spec?.title ?? null,
    spec_id: state.spec?.id ?? null,
    updated_at: state.updatedAt,
  };
}

/** 轻量校验：这里只挡结构错误，语义校验在前端 `spec.ts` 里做得更细。 */
export function validateSpecLite(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["Spec 必须是一个对象"] };
  }
  if (input.spec_version !== "1.0") errors.push('spec_version 必须是 "1.0"');
  for (const key of ["id", "title", "entry"]) {
    if (typeof input[key] !== "string" || !input[key].trim()) errors.push(`缺少 ${key}`);
  }
  if (!input.assets_manifest || typeof input.assets_manifest !== "object") {
    errors.push("缺少 assets_manifest");
  }
  if (!Array.isArray(input.logic_nodes) || !input.logic_nodes.length) {
    errors.push("logic_nodes 至少需要一个节点");
  } else {
    const ids = new Set();
    for (const [index, node] of input.logic_nodes.entries()) {
      if (!node || typeof node.id !== "string") {
        errors.push(`logic_nodes[${index}] 缺少 id`);
        continue;
      }
      if (ids.has(node.id)) errors.push(`logic_nodes id 重复：${node.id}`);
      ids.add(node.id);
      if (!STANCES.has(node.stance_goal)) errors.push(`logic_nodes[${node.id}].stance_goal 非法`);
      if (Array.isArray(node.choices)) {
        for (const choice of node.choices) {
          if (!choice || typeof choice.to !== "string") errors.push(`logic_nodes[${node.id}] 有选项缺少 to`);
        }
      }
    }
    if (typeof input.entry === "string" && !ids.has(input.entry)) {
      errors.push(`entry「${input.entry}」不存在`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function loadSpec(input) {
  const check = validateSpecLite(input);
  if (!check.ok) return { ok: false, errors: check.errors };
  state = { version: state.version + 1, spec: input, updatedAt: Date.now() };
  persist();
  return { ok: true, version: state.version, world: input.title, spec_id: input.id };
}

export function clearSpec() {
  state = { version: state.version + 1, spec: null, updatedAt: Date.now() };
  persist();
  return { ok: true, version: state.version };
}
