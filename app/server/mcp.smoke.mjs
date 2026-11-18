/**
 * MCP 冒烟测试：不模拟，真的起一个 server 进程，按协议说话。
 *
 * 验四件事：
 * 1. 协议能通（initialize / tools/list）
 * 2. Agent 能完整走一遍：开世界 → 预演 → 分叉 → 走一步 → 合并 → 打分 → 出卡
 * 3. preview 是纯的（不往树里落节点）
 * 4. 合并幂等（合两次不翻倍）
 *
 * 用法：npm run test:mcp
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN = join(HERE, "gen", "world.mjs");
if (!existsSync(GEN)) {
  console.error("先跑 npm run build:mcp");
  process.exit(1);
}

const child = spawn(process.execPath, [join(HERE, "mcp.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
});

let seq = 0;
const waiting = new Map();
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let cut = buffer.indexOf("\n");
  while (cut !== -1) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    cut = buffer.indexOf("\n");
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const pending = waiting.get(msg.id);
    if (pending) {
      waiting.delete(msg.id);
      pending(msg);
    }
  }
});

function rpc(method, params) {
  seq += 1;
  const id = seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 15000);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  [PASS] ${label} ${detail}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${label} ${detail}`);
  }
}

async function call(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  const text = res.result?.content?.[0]?.text;
  if (res.result?.isError) throw new Error(`${name} 失败：${text}`);
  return JSON.parse(text);
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  check("学会握手", init.result?.serverInfo?.name === "mirai-selene", init.result?.serverInfo?.name);

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  const core = ["open_world", "preview", "step", "branch", "merge", "rollback", "evaluate", "card"];
  const factory = ["ingest_social", "forge_world", "plan_assets", "publish_spec"];
  check("走世界的八个工具都在", core.every((n) => names.includes(n)), names.join(","));
  check("造世界的四个工具都在", factory.every((n) => names.includes(n)), names.join(","));
  check("没有重名工具", new Set(names).size === names.length, `${names.length} 个`);

  const world = await call("open_world", {
    name: "周三之前",
    who: "林夏",
    goal: { key: "被理解", label: "她想被理解", target: 10 },
  });
  check("开出世界", Boolean(world.worldId) && Boolean(world.node), world.worldId);
  check("起点目标是 0", world.goal.progress === 0, world.goal.text);

  // preview 必须是纯的
  const before = await call("evaluate", { worldId: world.worldId, node: world.node });
  const prev = await call("preview", {
    worldId: world.worldId,
    node: world.node,
    candidates: [
      { key: "被理解", value: 6 },
      { key: "钱", value: 8 },
    ],
  });
  const afterPreview = await call("evaluate", { worldId: world.worldId, node: world.node });
  check("预演给出两个候选", prev.candidates.length === 2);
  check(
    "预演不改世界（节点数不变）",
    before.shape.nodes === afterPreview.shape.nodes,
    `${before.shape.nodes} → ${afterPreview.shape.nodes}`,
  );
  check("预演说清目标会怎么变", prev.candidates[0].goal.after >= prev.candidates[0].goal.before);

  // 两条线
  const laneA = await call("branch", { worldId: world.worldId, from: world.node, label: "问她妈" });
  const laneB = await call("branch", { worldId: world.worldId, from: world.node, label: "问姨妈" });

  const stepA = await call("step", {
    worldId: world.worldId,
    node: laneA.node,
    label: "她妈说没事",
    memories: [{ key: "她妈的病", value: 3 }],
  });
  check("走一步有账", stepA.ledger.length > 0, stepA.ledger);

  const stepB = await call("step", {
    worldId: world.worldId,
    node: laneB.node,
    label: "姨妈说疼得没睡",
    memories: [{ key: "她妈的病", value: 8 }],
  });

  const merged = await call("merge", {
    worldId: world.worldId,
    left: stepA.node,
    right: stepB.node,
    label: "两条说法合起来",
  });
  check("合并出节点", Boolean(merged.node), merged.node);
  const evidence = merged.evidence.keys.find((k) => k.key === "她妈的病");
  check("合并后这条记忆记了两次", evidence?.count === 2, JSON.stringify(evidence));

  // 幂等：同一对再合一次，统计量不翻倍（引擎的契约是统计幂等，不是节点复用）
  const again = await call("merge", {
    worldId: world.worldId,
    left: stepA.node,
    right: stepB.node,
  });
  const evidence2 = again.evidence.keys.find((k) => k.key === "她妈的病");
  check(
    "重复合并不翻倍",
    evidence2?.count === 2 && evidence2?.mean === evidence?.mean,
    JSON.stringify(evidence2),
  );

  const score = await call("evaluate", { worldId: world.worldId, node: merged.node });
  check("打分给出目标与形状", score.goal !== undefined && score.shape.merges >= 1, JSON.stringify(score.shape));

  // 回滚：走错能退
  const back = await call("rollback", { worldId: world.worldId, from: merged.node, to: world.node });
  check("回滚到起点", back.node !== merged.node && back.goal.progress === 0, back.label);

  const card = await call("card", { worldId: world.worldId, node: merged.node });
  check("导出预测卡", card.markdown.includes("# 周三之前 · 预测卡"), card.markdown.slice(0, 24));

  // 错误路径：工具要能报错而不是崩
  const bad = await rpc("tools/call", { name: "step", arguments: { worldId: "不存在", node: "x", memories: [] } });
  check("坏调用返回错误", bad.result?.isError === true, bad.result?.content?.[0]?.text?.slice(0, 40));
} catch (error) {
  console.error("异常：", error.message);
  failed += 1;
} finally {
  child.stdin.end();
  setTimeout(() => {
    child.kill();
    console.log(`\n汇总：${passed} / ${passed + failed}`);
    process.exit(failed ? 1 : 0);
  }, 200);
}
