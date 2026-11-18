/**
 * Mirai-Selene MCP server —— 让 Agent 自己走世界，而不是人来点按钮。
 *
 * 这是赛道规则里点名的那一格：「工具调用（含 MCP / API）」「输入—规划—工具调用—结果交付」。
 * 所以这里的工具不是给前端用的封装，而是 Agent 的**动作空间**：
 *
 *   open_world → preview（这一步大概值多少）→ branch → step → merge → rollback → card
 *
 * 每个返回值都是**算出来的**（账、读数、目标进度），不是模型口述的。
 * 传输无关：这个文件只定义工具与分派；stdio 包装在 mcp.mjs，HTTP 包装在 serve.mjs 的 /mcp。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  WorldTree,
  applyObservation,
  buildPredictionCard,
  diffState,
  emptyState,
  projectChoices,
  readDelta,
  readMood,
  slotMean,
  uidForKey,
} from "./gen/world.mjs";
import { planWorld } from "./assets/factory.mjs";
import { planAssetTasks } from "./assets/prompt-library.mjs";
import { ingestSocial } from "./social_ingest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(join(HERE, "..", "package.json"), "utf8"),
).version ?? "0.0.0";

/* ------------------------------------------------------------------ */
/* 世界仓库                                                            */
/* ------------------------------------------------------------------ */

/** worldId → { tree, name, who, goal } */
const worlds = new Map();

function requireWorld(args) {
  const world = worlds.get(args.worldId);
  if (!world) throw new Error(`找不到世界 ${args.worldId}，先调 open_world`);
  return world;
}

function requireNode(tree, id) {
  const node = tree.node(id);
  if (!node) throw new Error(`找不到节点 ${id}`);
  return node;
}

/** 目标进度：她最想要的那件事，现在推进到哪。算出来的，不是估计。 */
function goalFromState(world, state) {
  const { key, target, label } = world.goal;
  const slot = Object.values(state.numeric).find((s) => s.key === key);
  const value = slot ? slotMean(slot) : 0;
  const progress = target > 0 ? Math.min(1, value / target) : 0;
  return {
    key,
    label,
    target,
    value: Math.round(value * 10) / 10,
    progress: Math.round(progress * 100) / 100,
    text: `${label}：${Math.round(progress * 100)}%（${Math.round(value * 10) / 10} / ${target}）`,
  };
}

function goalOf(world, node) {
  return goalFromState(world, node.state);
}

function readoutOf(node) {
  const mood = readMood(node.state);
  return {
    warmth: mood.warmth,
    pressure: mood.pressure,
    balance: mood.balance,
    dominant: mood.dominant,
    line: mood.line,
  };
}

function evidenceOf(node) {
  return Object.values(node.state.numeric)
    .sort((a, b) => slotMean(b) - slotMean(a))
    .map((s) => ({ key: s.key, count: s.count, mean: Math.round(slotMean(s) * 10) / 10 }));
}

function shapeOf(tree) {
  const nodes = Object.values(tree.toData().nodes);
  return {
    nodes: nodes.length,
    branches: nodes.filter((n) => n.kind === "branch").length,
    merges: nodes.filter((n) => n.kind === "merge").length,
    rollbacks: nodes.filter((n) => n.kind === "rollback").length,
  };
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

function openWorld(args) {
  const tree = WorldTree.create(args.name ?? "未命名世界");
  const worldId = `w_${randomUUID().slice(0, 8)}`;
  const world = {
    tree,
    name: args.name ?? "未命名世界",
    who: args.who ?? "她",
    goal: {
      key: args.goal?.key ?? "被理解",
      label: args.goal?.label ?? args.goal?.key ?? "被理解",
      target: Number(args.goal?.target ?? 10),
    },
  };
  worlds.set(worldId, world);
  const root = requireNode(tree, tree.toData().rootId);
  return {
    worldId,
    node: root.id,
    name: world.name,
    who: world.who,
    goal: goalOf(world, root),
    readout: readoutOf(root),
    hint: "下一步：preview（看某个动作大概值多少）→ branch/step（真走一步）",
  };
}

/** 走一步之前先算：这些候选动作各自会把什么推到哪。Agent 靠它做规划。 */
function preview(args) {
  const world = requireWorld(args);
  const node = requireNode(world.tree, args.node);
  const candidates = Array.isArray(args.candidates) ? args.candidates : [];
  if (!candidates.length) throw new Error("candidates 不能为空");

  const projections = projectChoices(
    node.state,
    candidates.map((c, i) => ({
      id: String(i),
      uid: uidForKey(node.state, c.key),
      key: c.key,
      value: Number(c.value ?? 5),
    })),
  );

  const before = goalOf(world, node);

  return {
    node: node.id,
    candidates: candidates.map((c, i) => {
      const p = projections[String(i)];
      const value = Number(c.value ?? 5);
      // 纯计算：不往树里落节点（preview 不能改世界）
      const projected = applyObservation(node.state, {
        uid: uidForKey(node.state, c.key),
        key: c.key,
        value,
      });
      const after = goalFromState(world, projected);
      return {
        index: i,
        key: c.key,
        value,
        memory: { now: p.now, after: p.after, isNew: p.isNew, direction: p.direction },
        goal: { before: before.progress, after: after.progress },
        read: readDelta(diffState(node.state, projected)),
      };
    }),
  };
}

/** 真走一步：把动作落成观测，返回这一步的账。 */
function step(args) {
  const world = requireWorld(args);
  const parent = requireNode(world.tree, args.node);
  const memories = Array.isArray(args.memories) ? args.memories : [];
  if (!memories.length) throw new Error("memories 不能为空（至少一条观测）");

  let current = parent;
  const applied = [];
  for (const m of memories) {
    const uid = uidForKey(current.state, m.key);
    current = world.tree.observe(
      current.id,
      { uid, key: m.key, value: Number(m.value), weight: m.weight ?? undefined },
      args.label ?? `这一步：${m.key}`,
    );
    applied.push({ key: m.key, value: Number(m.value) });
  }

  return {
    node: current.id,
    applied,
    ledger: readDelta(diffState(parent.state, current.state)),
    readout: readoutOf(current),
    goal: goalOf(world, current),
  };
}

function makeBranch(args) {
  const world = requireWorld(args);
  requireNode(world.tree, args.from);
  const node = world.tree.branch(args.from, args.label ?? "另一条路");
  return { node: node.id, label: node.label, readout: readoutOf(node), goal: goalOf(world, node) };
}

function mergeLanes(args) {
  const world = requireWorld(args);
  const left = requireNode(world.tree, args.left);
  const right = requireNode(world.tree, args.right);
  const node = world.tree.merge(args.left, args.right, args.label ?? "两条路合起来");

  const before = readMood(left.state);
  const after = readMood(node.state);
  return {
    node: node.id,
    ledger: readDelta(diffState(left.state, node.state)),
    readout: readoutOf(node),
    goal: goalOf(world, node),
    // 合力：合并之后，观测次数一定不减 —— 这是可验证的
    evidence: {
      keys: evidenceOf(node).slice(0, 8),
      note: "合并按观测次数加权，重复合并不会翻倍",
    },
    shift: {
      warmth: Math.round((after.warmth - before.warmth) * 10) / 10,
      pressure: Math.round((after.pressure - before.pressure) * 10) / 10,
    },
  };
}

/** 走错了退回来。规则里要的「失败可提示/重试」，这就是那一格。 */
function rollback(args) {
  const world = requireWorld(args);
  requireNode(world.tree, args.to);
  const node = world.tree.rollback(args.from, args.to);
  return { node: node.id, label: node.label, readout: readoutOf(node), goal: goalOf(world, node) };
}

function evaluate(args) {
  const world = requireWorld(args);
  const node = requireNode(world.tree, args.node);
  const path = world.tree.pathTo(node.id);
  return {
    node: node.id,
    steps: path.filter((n) => n.kind !== "root").length,
    goal: goalOf(world, node),
    readout: readoutOf(node),
    dominant: readMood(node.state).dominant,
    evidence: evidenceOf(node).slice(0, 10),
    shape: shapeOf(world.tree),
    path: path.map((n) => ({ id: n.id, label: n.label, kind: n.kind })),
  };
}

function card(args) {
  const world = requireWorld(args);
  const node = requireNode(world.tree, args.node);
  const path = world.tree.pathTo(node.id);
  const shape = shapeOf(world.tree);
  const markdown = buildPredictionCard({
    worldName: world.name,
    who: world.who,
    path,
    state: node.state,
    branches: shape.branches,
    merges: shape.merges,
    tombstones: Object.keys(node.state.tombstones).length,
    license: { label: "署名后可商用", terms: "可以商用，也可以二次创作。使用时请标明原作者与世界名称。" },
    at: new Date().toLocaleString("zh-CN", { hour12: false }),
  });
  return { node: node.id, markdown };
}

/* ------------------------------------------------------------------ */
/* 工具表                                                              */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: "open_world",
    description: "开一个可以走的世界。返回 worldId 与起点，之后所有调用都用它。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "世界名字" },
        who: { type: "string", description: "主角名字" },
        goal: {
          type: "object",
          description: "她最想要的那件事，用来结算。",
          properties: {
            key: { type: "string", description: "目标对应的记忆名，比如「被理解」" },
            label: { type: "string", description: "给人看的说法" },
            target: { type: "number", description: "多少算达成，默认 10" },
          },
        },
      },
    },
  },
  {
    name: "preview",
    description:
      "走之前先算：每个候选动作会把哪条记忆推到哪里、目标进度变成多少。Agent 用它决定走哪条，不用猜。",
    inputSchema: {
      type: "object",
      properties: {
        worldId: { type: "string" },
        node: { type: "string", description: "从哪个节点出发" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "number" } },
            required: ["key"],
          },
        },
      },
      required: ["worldId", "node", "candidates"],
    },
  },
  {
    name: "step",
    description: "真走一步：把动作落成观测，返回这一步的账（哪条记忆被推到多少）。",
    inputSchema: {
      type: "object",
      properties: {
        worldId: { type: "string" },
        node: { type: "string" },
        label: { type: "string", description: "这一步怎么称呼" },
        memories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "number" },
              weight: { type: "number" },
            },
            required: ["key", "value"],
          },
        },
      },
      required: ["worldId", "node", "memories"],
    },
  },
  {
    name: "branch",
    description: "从某个节点分出一条世界线，用来比较不同选择。",
    inputSchema: {
      type: "object",
      properties: { worldId: { type: "string" }, from: { type: "string" }, label: { type: "string" } },
      required: ["worldId", "from"],
    },
  },
  {
    name: "merge",
    description: "把两条世界线合起来。按观测次数加权，顺序无关，重复合并不翻倍。",
    inputSchema: {
      type: "object",
      properties: {
        worldId: { type: "string" },
        left: { type: "string" },
        right: { type: "string" },
        label: { type: "string" },
      },
      required: ["worldId", "left", "right"],
    },
  },
  {
    name: "rollback",
    description: "退回之前某个节点，历史不删除。走错了就用它。",
    inputSchema: {
      type: "object",
      properties: { worldId: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
      required: ["worldId", "from", "to"],
    },
  },
  {
    name: "evaluate",
    description: "给当前这条线打分：目标进度、读数、证据（每条记忆几次观测）、世界线的形状。",
    inputSchema: {
      type: "object",
      properties: { worldId: { type: "string" }, node: { type: "string" } },
      required: ["worldId", "node"],
    },
  },
  {
    name: "card",
    description: "把这条线导成一份 Markdown 预测卡（走过的路、每一步的账、读数、边界与授权）。",
    inputSchema: {
      type: "object",
      properties: { worldId: { type: "string" }, node: { type: "string" } },
      required: ["worldId", "node"],
    },
  },
  {
    name: "ingest_social",
    description:
      "把一条小红书/抖音链接或一段现实处境拆成世界：快照、3-5 个阵营 Agent、以及一份 World-Spec。生成后会推送到 Mirai-Selene 舞台并热重载，用户可以直接走进去。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "热帖链接（抓不到会回退内置快照）" },
        text: { type: "string", description: "或者直接粘贴正文/评论" },
        player_faction: { type: "string", description: "想让用户扮演哪个阵营 id（可选）" },
        publish: { type: "boolean", description: "是否推送到舞台，默认 true" },
      },
    },
  },
  {
    name: "forge_world",
    description:
      "从一句处境造一个可走的世界（地点、时间、天气、十幕逻辑节点、选项与记忆键），并推送到 Mirai-Selene 舞台热重载。适合用户说「帮我造一个世界」时调用。",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "一句处境，例如「合伙人在散伙前夜改了密钥」" },
        title: { type: "string", description: "世界标题，不给就从处境截取" },
        stakes: { type: "string", description: "必须谈成什么" },
        worst: { type: "string", description: "最坏结局" },
        tone: { type: "string", description: "冷峻 / 温柔 / 荒诞 / 克制" },
        publish: { type: "boolean", description: "是否推送到舞台，默认 true" },
      },
      required: ["theme"],
    },
  },
  {
    name: "plan_assets",
    description:
      "按视觉 Codebook 给一份 World-Spec 出资产任务单：每个场景一张背景、每个角色五种情绪立绘，含对齐的 prompt、比例与尺寸。",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", description: "没有 spec 时，用一句处境现造一份再出任务单" },
        spec: { type: "object", description: "已有的 World-Spec" },
      },
    },
  },
  {
    name: "publish_spec",
    description: "把一份已有的 World-Spec 推到 Mirai-Selene 舞台并热重载（无需重启服务）。",
    inputSchema: {
      type: "object",
      properties: { spec: { type: "object", description: "World-Spec v1" } },
      required: ["spec"],
    },
  },
];

/* ------------------------------------------------------------------ */
/* 造世界：把 Agent 的意图折成可热重载的 Spec                          */
/* ------------------------------------------------------------------ */

let specPublisher = null;

/** serve.mjs 启动时注入 loadSpec，让 MCP 和舞台共享同一份 spec 状态。 */
export function setSpecPublisher(fn) {
  specPublisher = fn;
}

async function publishSpec(spec) {
  if (!spec) throw new Error("没有可发布的 Spec");
  if (specPublisher) {
    const out = specPublisher(spec);
    if (!out?.ok) {
      throw new Error(`推送失败：${(out?.errors ?? []).join("；") || "Spec 校验不通过"}`);
    }
    return { ...out, via: "in-process" };
  }
  const base = (process.env.MIRAI_BASE || "http://127.0.0.1:8080").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/mirai/spec/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) throw new Error(`推送失败：${data?.error || `HTTP ${res.status}`}`);
  return { ...data, via: "http" };
}

async function forgeWorld(args) {
  const planned = planWorld({
    theme: args.theme,
    title: args.title,
    stakes: args.stakes,
    worst: args.worst,
    tone: args.tone,
  });
  const spec = planned.spec;
  const published = args.publish === false ? null : await publishSpec(spec);
  return {
    spec_id: spec.id,
    title: spec.title,
    nodes: spec.logic_nodes?.length ?? 0,
    cast: (spec.cast ?? []).map((person) => person.name),
    asset_tasks: planned.tasks?.length ?? 0,
    published,
    next: "用户可以在 Mirai-Selene 舞台直接走进去；要立绘与背景时调 plan_assets",
  };
}

async function ingestSocialTool(args) {
  const result = await ingestSocial({
    url: args.url ?? "",
    text: args.text ?? "",
    player_faction: args.player_faction ?? "",
  });
  if (!result?.ok) throw new Error(result?.error || "没有拆出可用的世界");
  const published = args.publish === false ? null : await publishSpec(result.spec);
  return {
    title: result.snapshot?.title,
    source_type: result.snapshot?.source_type,
    fallback: result.fallback,
    faction_source: result.faction_source,
    factions: result.factions.map((faction) => ({
      id: faction.id,
      name: faction.name,
      public_claim: faction.public_claim,
      hidden_motive: faction.hidden_motive,
    })),
    spec_id: result.spec?.id,
    nodes: result.spec?.logic_nodes?.length ?? 0,
    published,
  };
}

function planAssetsTool(args) {
  if (args?.spec) {
    return { spec_id: args.spec.id, tasks: planAssetTasks(args.spec) };
  }
  const planned = planWorld({ theme: args?.theme });
  return { spec: planned.spec, tasks: planned.tasks };
}

async function publishSpecTool(args) {
  return publishSpec(args?.spec);
}

const HANDLERS = {
  open_world: openWorld,
  preview,
  step,
  branch: makeBranch,
  merge: mergeLanes,
  rollback,
  evaluate,
  card,
  ingest_social: ingestSocialTool,
  forge_world: forgeWorld,
  plan_assets: planAssetsTool,
  publish_spec: publishSpecTool,
};

/* ------------------------------------------------------------------ */
/* JSON-RPC 分派（传输无关）                                           */
/* ------------------------------------------------------------------ */

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

function result(id, payload) {
  return { jsonrpc: "2.0", id, result: payload };
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function toolCatalog() {
  return TOOLS;
}

/**
 * 处理一条 JSON-RPC 消息。
 * 返回 null 表示这是一条通知（HTTP 侧回 202，stdio 侧不写）。
 */
export async function dispatch(message) {
  const { id, method, params } = message ?? {};

  if (method === "initialize") {
    const asked = String(params?.protocolVersion ?? "");
    return result(id, {
      protocolVersion: PROTOCOL_VERSIONS.has(asked) ? asked : "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "mirai-selene", version: VERSION },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return null;
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const runner = HANDLERS[name];
    if (!runner) return error(id, -32601, `没有这个工具：${name}`);
    try {
      const out = await runner(params?.arguments ?? {});
      return result(id, {
        content: [{ type: "text", text: JSON.stringify(out) }],
        isError: false,
      });
    } catch (err) {
      return result(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: err instanceof Error ? err.message : "调用失败" }),
          },
        ],
        isError: true,
      });
    }
  }
  return id === undefined ? null : error(id, -32601, `没有这个方法：${method}`);
}
