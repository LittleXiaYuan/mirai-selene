/**
 * World File —— 世界线的可移植容器。
 *
 * 格式目标是「能带走、能校验、能再载入」：
 *   · export 产出确定性 JSON（键序固定），同样的世界永远得到同样的字节；
 *   · inspect 不需要 UI，纯数据就能判定一致性与完整性；
 *   · load 严格校验后再接受，坏文件不会静默变成半个世界。
 */

import {
  hashState,
  inspectTree,
  type InspectReport,
  type WorldNode,
  type WorldTreeData,
} from "./engine";

export const WORLD_FILE_VERSION = 1;
export const WORLD_FILE_MAGIC = "mirai-selene/world";

/**
 * 授权条款。
 *
 * 为什么放在文件里：世界被导出之后就不归服务器管了，
 * 授权必须跟着文件走，否则「谁可以用、怎么分成」只能靠口头约定。
 * 文本是给人读的，不是机器强制的许可证 —— 诚实标注这一点。
 */
export interface WorldLicense {
  /** 版权方。默认是创作者本人。 */
  holder: string;
  /** 三种预设，见 LICENSE_PRESETS。 */
  mode: "personal" | "attribution" | "revenue";
  /** 人类可读的条款原文。 */
  terms: string;
}

export const LICENSE_PRESETS: Record<WorldLicense["mode"], { label: string; terms: string }> = {
  personal: {
    label: "个人使用",
    terms: "可以自己玩、自己改，也可以给别人看。不能拿去卖。",
  },
  attribution: {
    label: "署名后可商用",
    terms: "可以商用，也可以二次创作。使用时请标明原作者与世界名称。",
  },
  revenue: {
    label: "分成",
    terms: "可以商用。对外产生的收入按双方约定的比例分成，具体比例需在文件外单独签署。",
  },
};

export interface WorldFileMeta {
  name: string;
  author?: string;
  summary?: string;
  exportedAt: string;
  license?: WorldLicense;
}

export interface WorldFile {
  magic: string;
  version: number;
  meta: WorldFileMeta;
  tree: WorldTreeData;
  checksum: string;
}

export class WorldFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldFileError";
  }
}

/** 键序固定的 JSON —— 导出可复现，校验可逐字节比对。 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 树的整体校验值。
 *
 * 早先的实现把每个节点的完整 state 也序列化进去，5000 节点要 3 秒多。
 * 但 stateHash 本身就是该状态的摘要 —— 重复哈希一遍是浪费。
 *
 * 现在只串结构与 stateHash，**而载入时会用 hashState(node.state) 重算一遍**，
 * 对不上就拒绝。所以「篡改状态同时保留旧 stateHash」依然会被抓住，
 * 只是把重算从导出挪到了载入。
 */
function treeChecksum(tree: WorldTreeData): string {
  const nodes = Object.values(tree.nodes).sort((a, b) => a.seq - b.seq);
  let h = 0x811c9dc5;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(tree.rootId);
  mix(String(nodes.length));
  for (const n of nodes) {
    mix(n.id);
    mix(n.parentId ?? "-");
    mix(n.kind);
    mix(String(n.seq));
    mix(n.stateHash);
    // 合并来源也参与，否则改 mergedFrom 不会被发现
    mix(n.mergedFrom.join(","));
  }
  return h.toString(16).padStart(8, "0");
}

export function exportWorldFile(
  tree: WorldTreeData,
  meta: Omit<WorldFileMeta, "exportedAt"> & { exportedAt?: string },
): WorldFile {
  const report = inspectTree(tree);
  if (!report.ok) {
    const first = report.issues.find((issue) => issue.level === "error");
    throw new WorldFileError(`世界数据不一致，拒绝导出：${first?.message ?? "未知错误"}`);
  }
  return {
    magic: WORLD_FILE_MAGIC,
    version: WORLD_FILE_VERSION,
    meta: {
      name: meta.name,
      author: meta.author,
      summary: meta.summary,
      exportedAt: meta.exportedAt ?? new Date().toISOString(),
      // 没指定就默认「署名后可商用」：最容易被接受，也保护了作者署名
      license:
        meta.license ??
        ({
          holder: meta.author ?? "未署名",
          mode: "attribution",
          terms: LICENSE_PRESETS.attribution.terms,
        } satisfies WorldLicense),
    },
    tree,
    checksum: treeChecksum(tree),
  };
}

export function serializeWorldFile(file: WorldFile): string {
  return `${JSON.stringify(JSON.parse(stableStringify(file)), null, 2)}\n`;
}

export interface InspectWorldFileReport extends InspectReport {
  fileOk: boolean;
  name: string;
  version: number;
  checksumOk: boolean;
  leafCount: number;
  deepest: number;
  message: string;
}

export function inspectWorldFile(file: WorldFile): InspectWorldFileReport {
  const tree = inspectTree(file.tree);
  const checksumOk = treeChecksum(file.tree) === file.checksum;

  // checksum 只覆盖结构，所以这里逐个节点重算状态摘要。
  // 两者合起来才是完整校验：改结构 → checksum 失配；改状态 → 这里失配。
  const tampered: string[] = [];
  for (const node of Object.values(file.tree.nodes)) {
    if (hashState(node.state) !== node.stateHash) {
      tampered.push(node.id);
      tree.issues.push({
        level: "error",
        nodeId: node.id,
        message: `节点 ${node.id} 的状态与其摘要不符，文件被改动过`,
      });
    }
  }
  tree.ok = tree.ok && tampered.length === 0;
  const nodes = Object.values(file.tree.nodes);
  const parents = new Set(nodes.map((n) => n.parentId).filter(Boolean) as string[]);
  const leafCount = nodes.filter((n) => !parents.has(n.id)).length;

  const depth = (node: WorldNode): number => {
    let count = 0;
    let cursor: WorldNode | undefined = node;
    const guard = new Set<string>();
    while (cursor?.parentId) {
      if (guard.has(cursor.id)) break;
      guard.add(cursor.id);
      count += 1;
      cursor = file.tree.nodes[cursor.parentId];
    }
    return count;
  };
  const deepest = nodes.reduce((max, node) => Math.max(max, depth(node)), 0);

  const problems: string[] = [];
  if (file.magic !== WORLD_FILE_MAGIC) problems.push(`magic 不符（${file.magic}）`);
  if (file.version !== WORLD_FILE_VERSION) problems.push(`版本不支持（${file.version}）`);
  if (!checksumOk) problems.push("checksum 不匹配，文件可能被改动或损坏");
  for (const issue of tree.issues) {
    if (issue.level === "error") problems.push(issue.message);
  }

  const fileOk = problems.length === 0;
  return {
    ...tree,
    fileOk,
    name: file.meta.name,
    version: file.version,
    checksumOk,
    leafCount,
    deepest,
    message: fileOk
      ? `世界完整：${tree.nodeCount} 个节点，${leafCount} 条世界线，最深 ${deepest} 层，checksum 一致`
      : problems.join("；"),
  };
}

export function parseWorldFile(raw: string): WorldFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorldFileError("不是合法的 JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new WorldFileError("文件内容不是对象");

  const file = parsed as Partial<WorldFile>;
  if (file.magic !== WORLD_FILE_MAGIC) {
    throw new WorldFileError(`不是 Mirai-Selene 世界文件（magic = ${String(file.magic)}）`);
  }
  if (file.version !== WORLD_FILE_VERSION) {
    throw new WorldFileError(`世界文件版本 ${String(file.version)} 不受支持`);
  }
  if (!file.tree || !file.tree.nodes || typeof file.tree.nodes !== "object") {
    throw new WorldFileError("缺少世界线数据");
  }
  if (!file.checksum || treeChecksum(file.tree) !== file.checksum) {
    throw new WorldFileError("checksum 校验失败，文件可能被改动或损坏");
  }

  const report = inspectTree(file.tree);
  if (!report.ok) {
    const first = report.issues.find((issue) => issue.level === "error");
    throw new WorldFileError(`世界数据不一致：${first?.message ?? "未知错误"}`);
  }

  // checksum 现在只覆盖 stateHash，所以这里必须逐个重算，
  // 否则「改状态、留旧 hash」就能绕过。
  for (const node of Object.values(file.tree.nodes)) {
    if (hashState(node.state) !== node.stateHash) {
      throw new WorldFileError(`节点 ${node.id} 的状态与其摘要不符，文件被改动过`);
    }
  }

  return file as WorldFile;
}

/** 往返一致性：导出再导入，结构必须完全一致。 */
export function roundTrip(file: WorldFile): { ok: boolean; detail: string } {
  const text = serializeWorldFile(file);
  let back: WorldFile;
  try {
    back = parseWorldFile(text);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "解析失败" };
  }
  const a = Object.values(file.tree.nodes)
    .sort((x, y) => x.seq - y.seq)
    .map((n) => `${n.id}:${n.stateHash}`)
    .join("|");
  const b = Object.values(back.tree.nodes)
    .sort((x, y) => x.seq - y.seq)
    .map((n) => `${n.id}:${n.stateHash}`)
    .join("|");
  if (a !== b) return { ok: false, detail: "往返后节点或状态哈希不一致" };
  if (file.tree.rootId !== back.tree.rootId) return { ok: false, detail: "往返后根节点变了" };
  for (const node of Object.values(back.tree.nodes)) {
    if (node.stateHash !== hashState(node.state)) {
      return { ok: false, detail: `往返后节点 ${node.id} 状态哈希失配` };
    }
  }
  return { ok: true, detail: `往返无损：${back.tree.nodes ? Object.keys(back.tree.nodes).length : 0} 个节点一致` };
}
