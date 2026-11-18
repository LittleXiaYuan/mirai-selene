/**
 * 世界线版本树 —— branch / merge3 / rollback / audit。
 *
 * 状态模型刻意对齐 YunmengLM 的 BMA 语义：
 *   · 数值槽（numeric slot）存充分统计量 count / valueSum / weightSum，读出时取均值；
 *   · 三路合并 t_out = t_a + t_b − t_base，逐字段算，所以合并是精确的、可交换的；
 *   · 标量槽（scalar slot）不参与数值合并，两枝各自改过就拒绝合并并说明原因；
 *   · 墓碑（tombstone）不可逆：删除永远赢，防止回滚把已删记忆复活。
 *
 * 幂等性不靠计数器去重，而靠祖先判定：把同一枝重复合并进来时，
 * 它已经是合并节点的祖先，直接快进返回，状态不会翻倍。
 */

export type SlotKey = string;

export interface NumericSlot {
  uid: string;
  key: SlotKey;
  count: number;
  valueSum: number;
  weightSum: number;
}

export interface ScalarSlot {
  uid: string;
  key: SlotKey;
  text: string;
}

export interface WorldState {
  numeric: Record<string, NumericSlot>;
  scalars: Record<string, ScalarSlot>;
  tombstones: Record<string, string>;
}

export type NodeKind = "root" | "observe" | "set" | "branch" | "merge" | "rollback";

export interface WorldNode {
  id: string;
  parentId: string | null;
  label: string;
  kind: NodeKind;
  state: WorldState;
  stateHash: string;
  createdAt: string;
  seq: number;
  /** 已被本节点吸收的其它节点 id —— 幂等合并的判据，比祖先链更严格。 */
  mergedFrom: string[];
  /**
   * 呈现信息：这一幕发生在哪、什么时间、什么氛围、模型给的叙事。
   * 它不进 state，因为分支合并时不该因为"场景不同"而冲突 ——
   * 场景是这一次演出的样子，不是世界的事实。
   */
  meta?: Record<string, string>;
}

export type AuditAction =
  | "init"
  | "observe"
  | "set"
  | "branch"
  | "merge"
  | "rollback"
  | "forget"
  | "import";

export interface AuditEntry {
  seq: number;
  at: string;
  action: AuditAction;
  nodeId: string;
  detail: string;
  stateHash: string;
}

export interface MergeConflict {
  reason: "scalar-diverged" | "no-common-ancestor" | "negative-count" | "unknown";
  message: string;
  keys: SlotKey[];
}

export class MergeError extends Error {
  conflict: MergeConflict;

  constructor(conflict: MergeConflict) {
    super(conflict.message);
    this.name = "MergeError";
    this.conflict = conflict;
  }
}

/* ------------------------------------------------------------------ */
/* 状态工具                                                            */
/* ------------------------------------------------------------------ */

export function emptyState(): WorldState {
  return { numeric: {}, scalars: {}, tombstones: {} };
}

/** 稳定的键序序列化 —— 同样的状态必须得到同样的字符串，否则哈希不可比。 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}

/** FNV-1a 32 位。只用于比对，不用于安全用途。 */
export function hashString(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 状态哈希。
 *
 * 早先的实现是 hashString(canonical(state)) —— 先递归排序键、拼出一个几 KB 的
 * 字符串，再逐字符哈希。基准里 5000 个节点要 4 秒，几乎全耗在这里。
 *
 * 现在直接遍历已知的三张表、键排序一次、边遍历边哈希，
 * 不产生中间字符串。语义完全一致（同样的状态得到同样的值），只是快。
 */
export function hashState(state: WorldState): string {
  let h = 0x811c9dc5;

  const mix = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // 字段之间插一个分隔符，避免 "ab"+"c" 与 "a"+"bc" 撞车
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193) >>> 0;
  };

  const mixNum = (n: number) => {
    // 数量级不大的整数，转字符串比拆 bit 更省事且稳定
    mix(String(n));
  };

  const numericKeys = Object.keys(state.numeric).sort();
  mix(`n${numericKeys.length}`);
  for (const uid of numericKeys) {
    const slot = state.numeric[uid];
    mix(uid);
    mix(slot.key);
    mixNum(slot.count);
    mixNum(slot.valueSum);
    mixNum(slot.weightSum);
  }

  const scalarKeys = Object.keys(state.scalars).sort();
  mix(`s${scalarKeys.length}`);
  for (const uid of scalarKeys) {
    const slot = state.scalars[uid];
    mix(uid);
    mix(slot.key);
    mix(slot.text);
  }

  const tombKeys = Object.keys(state.tombstones).sort();
  mix(`t${tombKeys.length}`);
  for (const uid of tombKeys) {
    mix(uid);
    mix(state.tombstones[uid]);
  }

  return h.toString(16).padStart(8, "0");
}

export function cloneState(state: WorldState): WorldState {
  return {
    numeric: Object.fromEntries(Object.entries(state.numeric).map(([k, v]) => [k, { ...v }])),
    scalars: Object.fromEntries(Object.entries(state.scalars).map(([k, v]) => [k, { ...v }])),
    tombstones: { ...state.tombstones },
  };
}

/** 钟点 → 时段名。画面与状态行共用同一套口径。 */
export function timeOfDay(hour: number): string {
  const h = ((Math.round(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 9) return "清晨";
  if (h >= 9 && h < 15) return "正午";
  if (h >= 15 && h < 20) return "黄昏";
  return "深夜";
}

export function slotMean(slot: NumericSlot): number {
  return slot.count === 0 ? 0 : slot.valueSum / slot.count;
}

/* ------------------------------------------------------------------ */
/* 状态上的原子操作                                                     */
/* ------------------------------------------------------------------ */

export interface Observation {
  uid: string;
  key: SlotKey;
  value: number;
  weight?: number;
}

export function applyObservation(state: WorldState, obs: Observation): WorldState {
  const next = cloneState(state);
  if (next.tombstones[obs.uid]) return next;
  const weight = obs.weight ?? 1;
  const existing = next.numeric[obs.uid];
  next.numeric[obs.uid] = existing
    ? {
        ...existing,
        count: existing.count + 1,
        valueSum: existing.valueSum + obs.value,
        weightSum: existing.weightSum + weight,
      }
    : { uid: obs.uid, key: obs.key, count: 1, valueSum: obs.value, weightSum: weight };
  return next;
}

export function applyScalar(state: WorldState, uid: string, key: SlotKey, text: string): WorldState {
  const next = cloneState(state);
  if (next.tombstones[uid]) return next;
  next.scalars[uid] = { uid, key, text };
  return next;
}

export function applyTombstone(state: WorldState, uid: string, reason: string): WorldState {
  const next = cloneState(state);
  delete next.numeric[uid];
  delete next.scalars[uid];
  next.tombstones[uid] = reason;
  return next;
}

/* ------------------------------------------------------------------ */
/* 三路合并                                                            */
/* ------------------------------------------------------------------ */

/**
 * 三路合并两个世界状态。
 *
 * 数值槽：t_out = t_a + t_b − t_base（逐字段）。这是充分统计量的线性组合，
 *         所以合并结果与合并顺序无关 —— 先合 a 再合 b，和反过来一样。
 * 标量槽：base 没变的一侧直接采用另一侧；两侧都改且不同则拒绝。
 * 墓碑：  取并集，删除永远赢。
 */
export function mergeStates(
  a: WorldState,
  b: WorldState,
  base: WorldState = emptyState(),
): WorldState {
  const out = emptyState();
  const conflicts: SlotKey[] = [];

  const numericUids = new Set([
    ...Object.keys(a.numeric),
    ...Object.keys(b.numeric),
    ...Object.keys(base.numeric),
  ]);

  for (const uid of numericUids) {
    if (a.tombstones[uid] || b.tombstones[uid] || base.tombstones[uid]) continue;
    const av = a.numeric[uid];
    const bv = b.numeric[uid];
    const bvBase = base.numeric[uid];
    const template = av ?? bv ?? bvBase;
    if (!template) continue;

    const count = (av?.count ?? 0) + (bv?.count ?? 0) - (bvBase?.count ?? 0);
    const valueSum = (av?.valueSum ?? 0) + (bv?.valueSum ?? 0) - (bvBase?.valueSum ?? 0);
    const weightSum = (av?.weightSum ?? 0) + (bv?.weightSum ?? 0) - (bvBase?.weightSum ?? 0);

    // base 不是共同祖先时，减法会得到负数 —— 这比静默产出错值要好。
    if (count < 0 || weightSum < 0) {
      throw new MergeError({
        reason: "negative-count",
        message: `槽 ${template.key} 的充分统计量在减去 base 后为负，说明 base 不是共同祖先`,
        keys: [template.key],
      });
    }
    if (count === 0) continue;
    out.numeric[uid] = { uid, key: template.key, count, valueSum, weightSum };
  }

  const scalarUids = new Set([
    ...Object.keys(a.scalars),
    ...Object.keys(b.scalars),
    ...Object.keys(base.scalars),
  ]);

  for (const uid of scalarUids) {
    if (a.tombstones[uid] || b.tombstones[uid] || base.tombstones[uid]) continue;
    const av = a.scalars[uid];
    const bv = b.scalars[uid];
    const bvBase = base.scalars[uid];
    const template = av ?? bv ?? bvBase;
    if (!template) continue;

    const aChanged = (av?.text ?? null) !== (bvBase?.text ?? null);
    const bChanged = (bv?.text ?? null) !== (bvBase?.text ?? null);

    if (aChanged && bChanged && (av?.text ?? null) !== (bv?.text ?? null)) {
      conflicts.push(template.key);
      continue;
    }
    const winner = aChanged ? av : bv ?? av;
    if (winner) out.scalars[uid] = { ...winner };
  }

  if (conflicts.length) {
    throw new MergeError({
      reason: "scalar-diverged",
      message: `两条世界线都改过这些字段且取值不同，拒绝静默择一：${conflicts.join("、")}`,
      keys: conflicts,
    });
  }

  out.tombstones = { ...a.tombstones, ...b.tombstones, ...base.tombstones };
  return out;
}

/* ------------------------------------------------------------------ */
/* 反事实预测                                                          */
/* ------------------------------------------------------------------ */

export interface Projection {
  key: string;
  /** 现在这条记忆的读数（没有就是 0）。 */
  now: number;
  /** 如果再做一次这个动作，读数会变成多少。 */
  after: number;
  /** 现在的观测次数。 */
  count: number;
  /** 这次动作之后的方向。 */
  direction: "up" | "down" | "flat";
  /** 这次动作会新开一条记忆吗。 */
  isNew: boolean;
}

/**
 * 「如果我再做这一步，世界会怎么变」。
 *
 * 这是用世界模型做预测的最小单位：不靠语言模型猜，直接算。
 * 因为状态是充分统计量（count / valueSum），加一次观测的结果是确定的 ——
 * 所以这个预测是**精确的**，不是估计。
 *
 * 这正是视频世界模型给不了的：它能生成下一帧，但说不出"这一步会把她的
 * 什么东西推高多少"，因为它没有可加的状态。
 */
export function projectObservation(
  state: WorldState,
  obs: Observation,
): Projection {
  const existing = state.numeric[obs.uid];
  const before = existing ? slotMean(existing) : 0;
  const after = applyObservation(state, obs);
  const slot = after.numeric[obs.uid];
  const nextValue = slot ? slotMean(slot) : before;
  const delta = nextValue - before;

  return {
    key: obs.key,
    now: Math.round(before * 10) / 10,
    after: Math.round(nextValue * 10) / 10,
    count: existing?.count ?? 0,
    direction: Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down",
    isNew: !existing,
  };
}

/**
 * 一次算多个候选动作，用于「选之前先看影响」。
 *
 * uid 由调用方给：同一个 key 可能对应多条记忆，
 * 用 `key` 自己造 uid 会算到一条并不存在的记忆上（这个坑被测试抓过）。
 */
export function projectChoices(
  state: WorldState,
  choices: { id: string; uid: string; key: string; value: number }[],
): Record<string, Projection> {
  const out: Record<string, Projection> = {};
  for (const c of choices) {
    out[c.id] = projectObservation(state, { uid: c.uid, key: c.key, value: c.value });
  }
  return out;
}

/** 按 key 找已有记忆的 uid；没有就造一个稳定的。 */
export function uidForKey(state: WorldState, key: string): string {
  for (const [uid, slot] of Object.entries(state.numeric)) {
    if (slot.key === key) return uid;
  }
  return `m-${key}`;
}

/* ------------------------------------------------------------------ */
/* 状态读数                                                            */
/* ------------------------------------------------------------------ */

const PRESSURE_WORDS = /压力|紧|焦|怕|冷|疏|怀疑|累|堵|撑不住|慌|房租|风险|冲突|后悔|失去/;
const WARMTH_WORDS = /安心|温|信任|家|喜欢|平静|靠|暖|踏实|被理解|联系|支持|陪伴|满足/;

export interface MoodReading {
  /** 压着的部分：负性记忆的加权和。 */
  pressure: number;
  /** 撑住的部分：正性记忆的加权和。 */
  warmth: number;
  /** 正负之差。正数说明她比进来时稳。 */
  balance: number;
  /** 最强的那条记忆。 */
  dominant: { key: string; value: number } | null;
  /** 一句话，按数据生成，不靠模型。 */
  line: string;
}

/**
 * 把状态读成一个可比较的数。
 *
 * 为什么这件事重要：预测工具的产物必须是**可比较的**。
 * 「她更紧绷了」这种感觉没法比较，但 pressure - warmth 可以 ——
 * 而且它完全由状态决定，同一状态永远同一个数，能复现。
 *
 * 这是视频世界模型给不了的：它没有可以读的状态。
 */
export function readMood(state: WorldState): MoodReading {
  let pressure = 0;
  let warmth = 0;
  let dominant: { key: string; value: number } | null = null;

  for (const slot of Object.values(state.numeric)) {
    const value = slotMean(slot);
    if (dominant === null || value > dominant.value) {
      dominant = { key: slot.key, value: Math.round(value * 10) / 10 };
    }
    if (PRESSURE_WORDS.test(slot.key)) pressure += value;
    else if (WARMTH_WORDS.test(slot.key)) warmth += value;
    else {
      // 不认识的词按一半计入两边，避免中性记忆被丢掉
      pressure += value * 0.5;
      warmth += value * 0.5;
    }
  }

  const balance = Math.round((warmth - pressure) * 10) / 10;
  const p = Math.round(pressure * 10) / 10;
  const w = Math.round(warmth * 10) / 10;

  let line: string;
  if (!dominant) line = "还没有留下什么，世界是干净的。";
  else if (balance > 3) line = `她比刚进来时稳。撑住她的更多，占上风的是「${dominant.key}」。`;
  else if (balance < -3) line = `她绷得比一开始紧。压着她的更多，最重的是「${dominant.key}」。`;
  else line = `她在中间摇摆，两边都不算压倒。最在意的是「${dominant.key}」。`;

  return { pressure: p, warmth: w, balance, dominant, line };
}

/** 三档口径：偏稳 / 摇摆 / 绷紧。舞台和对照页共用一套阈值，不各写一遍。 */
export function balanceTone(balance: number): "warm" | "mid" | "tight" {
  if (balance > 3) return "warm";
  if (balance < -3) return "tight";
  return "mid";
}

export function balanceWord(balance: number): string {
  const tone = balanceTone(balance);
  return tone === "warm" ? "偏稳" : tone === "tight" ? "绷紧" : "摇摆";
}

export interface StateDelta {
  key: string;
  /** 这一步之前的读数（没有就是 0）。 */
  before: number;
  /** 这一步之后的读数。 */
  after: number;
  /** 变化量，正数是推高了。 */
  delta: number;
  /** 这一步之后的观测次数。等于 1 说明是这一步新留下的。 */
  count: number;
}

/**
 * 这一步把她的状态改了多少。
 *
 * 和预测用的是同一个前提：状态是充分统计量，前后两个状态都完整存在，
 * 所以这里的差是**算出来的**，不是模型口述的。
 * 界面敢把它写出来，是因为它每一步都能被同一份状态复现。
 */
export function diffState(from: WorldState, to: WorldState): StateDelta[] {
  const out: StateDelta[] = [];
  const round = (n: number) => Math.round(n * 10) / 10;

  for (const [uid, slot] of Object.entries(to.numeric)) {
    const prev = from.numeric[uid];
    // 次数没变说明这一步没碰过它，不必出现在账上
    if (prev && prev.count === slot.count) continue;
    const before = prev ? slotMean(prev) : 0;
    const after = slotMean(slot);
    out.push({
      key: slot.key,
      before: round(before),
      after: round(after),
      delta: round(after - before),
      count: slot.count,
    });
  }

  // 被整理掉（回滚 / 遗忘）的记忆同样是这一步的结果
  for (const [uid, slot] of Object.entries(from.numeric)) {
    if (to.numeric[uid]) continue;
    const before = slotMean(slot);
    out.push({
      key: slot.key,
      before: round(before),
      after: 0,
      delta: -round(before),
      count: 0,
    });
  }

  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/** 把一步的账写成一句话。没有变化就返回空串，界面据此不显示。 */
export function readDelta(deltas: StateDelta[]): string {
  if (!deltas.length) return "";
  const top = deltas[0];
  const rest = deltas.length - 1;

  let head: string;
  if (top.count === 0) head = `「${top.key}」被整理掉了`;
  else if (top.count === 1) head = `这一步第一次留下「${top.key}」，强度 ${top.after}`;
  else if (top.delta > 0) head = `「${top.key}」从 ${top.before} 推到 ${top.after}`;
  else if (top.delta < 0) head = `「${top.key}」从 ${top.before} 落到 ${top.after}`;
  else head = `「${top.key}」还是 ${top.after}，这一次没改动它`;

  return rest > 0 ? `${head}，另外${rest}项也动了。` : `${head}。`;
}

/* ------------------------------------------------------------------ */
/* 版本树                                                              */
/* ------------------------------------------------------------------ */

export interface WorldTreeData {
  nodes: Record<string, WorldNode>;
  rootId: string;
  audit: AuditEntry[];
  seq: number;
}

const nowIso = () => new Date().toISOString();

export class WorldTree {
  private data: WorldTreeData;

  constructor(data?: WorldTreeData) {
    this.data = data ?? {
      nodes: {},
      rootId: "",
      audit: [],
      seq: 0,
    };
  }

  static create(label = "原点", state: WorldState = emptyState()): WorldTree {
    const tree = new WorldTree();
    tree.init(label, state);
    return tree;
  }

  static fromData(data: WorldTreeData): WorldTree {
    return new WorldTree(data);
  }

  private init(label: string, state: WorldState): WorldNode {
    const node = this.pushNode(null, label, "root", state);
    this.data.rootId = node.id;
    this.log("init", node.id, `创建世界「${label}」`);
    return node;
  }

  toData(): WorldTreeData {
    return {
      nodes: Object.fromEntries(
        Object.entries(this.data.nodes).map(([k, v]) => [k, { ...v, state: cloneState(v.state) }]),
      ),
      rootId: this.data.rootId,
      audit: this.data.audit.map((entry) => ({ ...entry })),
      seq: this.data.seq,
    };
  }

  private nextSeq(): number {
    this.data.seq += 1;
    return this.data.seq;
  }

  private pushNode(
    parentId: string | null,
    label: string,
    kind: NodeKind,
    state: WorldState,
    mergedFrom: string[] = [],
    meta?: Record<string, string>,
  ): WorldNode {
    const seq = this.nextSeq();
    const node: WorldNode = {
      id: `n${seq}-${hashState(state).slice(0, 4)}`,
      parentId,
      label,
      kind,
      state: cloneState(state),
      stateHash: hashState(state),
      createdAt: nowIso(),
      seq,
      mergedFrom: [...mergedFrom],
      ...(meta ? { meta: { ...meta } } : {}),
    };
    this.data.nodes[node.id] = node;
    return node;
  }

  private log(action: AuditAction, nodeId: string, detail: string): void {
    const node = this.data.nodes[nodeId];
    this.data.audit.push({
      seq: this.data.audit.length + 1,
      at: nowIso(),
      action,
      nodeId,
      detail,
      stateHash: node?.stateHash ?? "",
    });
  }

  get root(): WorldNode {
    return this.data.nodes[this.data.rootId];
  }

  get nodes(): WorldNode[] {
    return Object.values(this.data.nodes).sort((x, y) => x.seq - y.seq);
  }

  get audit(): AuditEntry[] {
    return this.data.audit.map((entry) => ({ ...entry }));
  }

  node(id: string): WorldNode | undefined {
    return this.data.nodes[id];
  }

  children(id: string): WorldNode[] {
    return this.nodes.filter((node) => node.parentId === id);
  }

  /** 从根到该节点的路径，根在前。 */
  pathTo(id: string): WorldNode[] {
    const path: WorldNode[] = [];
    let cursor = this.data.nodes[id];
    const guard = new Set<string>();
    while (cursor) {
      if (guard.has(cursor.id)) break;
      guard.add(cursor.id);
      path.unshift(cursor);
      cursor = cursor.parentId ? this.data.nodes[cursor.parentId] : (undefined as unknown as WorldNode);
    }
    return path;
  }

  isAncestor(candidateId: string, descendantId: string): boolean {
    if (candidateId === descendantId) return true;
    let cursor = this.data.nodes[descendantId];
    const guard = new Set<string>();
    while (cursor?.parentId) {
      if (guard.has(cursor.id)) return false;
      guard.add(cursor.id);
      if (cursor.parentId === candidateId) return true;
      cursor = this.data.nodes[cursor.parentId];
    }
    return false;
  }

  /** 最近公共祖先 —— 三路合并的 base 必须取它，否则减法会算错。 */
  lca(leftId: string, rightId: string): WorldNode | undefined {
    const leftPath = this.pathTo(leftId).map((node) => node.id);
    const rightSet = new Set(this.pathTo(rightId).map((node) => node.id));
    for (let i = leftPath.length - 1; i >= 0; i -= 1) {
      if (rightSet.has(leftPath[i])) return this.data.nodes[leftPath[i]];
    }
    return undefined;
  }

  /** 在当前节点上记录一次观测，返回新节点。 */
  observe(
    parentId: string,
    obs: Observation,
    label?: string,
    meta?: Record<string, string>,
  ): WorldNode {
    const parent = this.require(parentId);
    const state = applyObservation(parent.state, obs);
    const node = this.pushNode(
      parent.id,
      label ?? `观测 ${obs.key} = ${obs.value}`,
      "observe",
      state,
      [],
      meta,
    );
    this.log("observe", node.id, `${obs.key} 记一次 ${obs.value}（权重 ${obs.weight ?? 1}）`);
    return node;
  }

  setScalar(parentId: string, uid: string, key: SlotKey, text: string, label?: string): WorldNode {
    const parent = this.require(parentId);
    const state = applyScalar(parent.state, uid, key, text);
    const node = this.pushNode(parent.id, label ?? `设定 ${key} = ${text}`, "set", state);
    this.log("set", node.id, `${key} 设为「${text}」`);
    return node;
  }

  forget(parentId: string, uid: string, reason: string): WorldNode {
    const parent = this.require(parentId);
    const state = applyTombstone(parent.state, uid, reason);
    const node = this.pushNode(parent.id, `遗忘 ${uid}`, "observe", state);
    this.log("forget", node.id, `墓碑：${uid}（${reason}）`);
    return node;
  }

  /** 开一条新世界线：语义上是一次分叉，状态从 parent 复制。 */
  branch(parentId: string, label: string): WorldNode {
    const parent = this.require(parentId);
    const node = this.pushNode(parent.id, label, "branch", parent.state);
    this.log("branch", node.id, `从「${parent.label}」分出世界线「${label}」`);
    return node;
  }

  /**
   * 合并两条世界线。
   *
   * base 取二者的 LCA。幂等性不靠「一方是另一方祖先」判断 ——
   * 合并节点并不在对方的祖先链上，那个判断会漏掉重复合并。
   * 改为显式记录 mergedFrom：已经吸收过对方就直接返回，统计量不翻倍。
   */
  merge(leftId: string, rightId: string, label?: string): WorldNode {
    const left = this.require(leftId);
    const right = this.require(rightId);

    if (left.id === right.id) return left;

    // 已经吸收过对方 → 快进，不重复计入。
    // 注意：不能用 isAncestor 判断，因为 branch 节点是父状态的副本，
    // 把它当作「已包含」会漏掉真正的合并。
    if (left.mergedFrom.includes(right.id)) return left;
    if (right.mergedFrom.includes(left.id)) return right;

    const base = this.lca(left.id, right.id);
    if (!base) {
      throw new MergeError({
        reason: "no-common-ancestor",
        message: "两条世界线没有公共祖先，无法三路合并",
        keys: [],
      });
    }

    const merged = mergeStates(left.state, right.state, base.state);
    const absorbed = new Set([...left.mergedFrom, ...right.mergedFrom, left.id, right.id]);
    const node = this.pushNode(
      left.id,
      label ?? `合并 ${left.label} + ${right.label}`,
      "merge",
      merged,
      [...absorbed],
    );
    this.log(
      "merge",
      node.id,
      `合并「${left.label}」与「${right.label}」，base =「${base.label}」`,
    );
    return node;
  }

  /** 给节点补上呈现信息（不产生新节点，只标注这一次演出的样子）。 */
  annotate(id: string, meta: Record<string, string>): void {
    const node = this.data.nodes[id];
    if (!node) return;
    node.meta = { ...(node.meta ?? {}), ...meta };
  }

  /** 回滚：把 target 的状态搬到当前线的末端，历史不丢，只追加。 */
  rollback(fromId: string, targetId: string): WorldNode {
    const from = this.require(fromId);
    const target = this.require(targetId);
    const node = this.pushNode(
      from.id,
      `回滚到「${target.label}」`,
      "rollback",
      target.state,
    );
    this.log("rollback", node.id, `从「${from.label}」回滚到「${target.label}」`);
    return node;
  }

  private require(id: string): WorldNode {
    const node = this.data.nodes[id];
    if (!node) throw new Error(`节点不存在：${id}`);
    return node;
  }
}

/* ------------------------------------------------------------------ */
/* 合并预演                                                            */
/* ------------------------------------------------------------------ */

export interface MergePreviewSlot {
  uid: string;
  key: string;
  /** 两侧各自的充分统计量。 */
  a: { count: number; valueSum: number; weightSum: number } | null;
  b: { count: number; valueSum: number; weightSum: number } | null;
  base: { count: number; valueSum: number; weightSum: number } | null;
  /** 合并后的结果。冲突时为 null。 */
  out: { count: number; valueSum: number; weightSum: number } | null;
  /** a 的均值与 b 的均值，给人看。 */
  meanA: number | null;
  meanB: number | null;
  meanOut: number | null;
  kind: "add" | "new-a" | "new-b" | "conflict" | "forgotten";
}

export interface MergePreviewScalar {
  uid: string;
  key: string;
  a: string | null;
  b: string | null;
  base: string | null;
  out: string | null;
  kind: "take-a" | "take-b" | "same" | "conflict";
}

export interface MergePreview {
  ok: boolean;
  baseLabel: string;
  baseId: string;
  leftLabel: string;
  rightLabel: string;
  nodes: number;
  slots: MergePreviewSlot[];
  scalars: MergePreviewScalar[];
  conflicts: { key: string; message: string }[];
  /** 给人读的一句话。 */
  summary: string;
}

const mean = (s: { count: number; valueSum: number } | null) =>
  !s || s.count === 0 ? null : s.valueSum / s.count;

/**
 * 合并前先算一遍会发生什么，但不改任何东西。
 *
 * 为什么要单独一个函数：mergeStates 出错时只抛一个异常，
 * 用户看不到「哪几条记忆会相加、哪一条冲突」。而合并这件事
 * 一旦静默丢了内容就回不来了，所以必须能先看。
 */
export function previewMerge(
  data: WorldTreeData,
  leftId: string,
  rightId: string,
): MergePreview | null {
  const tree = WorldTree.fromData(data);
  const left = tree.node(leftId);
  const right = tree.node(rightId);
  if (!left || !right) return null;

  const base = tree.lca(leftId, rightId);
  const baseState = base?.state ?? emptyState();

  const slots: MergePreviewSlot[] = [];
  const scalars: MergePreviewScalar[] = [];
  const conflicts: { key: string; message: string }[] = [];

  const allUids = new Set([
    ...Object.keys(left.state.numeric),
    ...Object.keys(right.state.numeric),
    ...Object.keys(baseState.numeric),
  ]);

  for (const uid of [...allUids].sort()) {
    const a = left.state.numeric[uid] ?? null;
    const b = right.state.numeric[uid] ?? null;
    const bse = baseState.numeric[uid] ?? null;
    const template = a ?? b ?? bse;
    if (!template) continue;

    if (left.state.tombstones[uid] || right.state.tombstones[uid]) {
      slots.push({
        uid, key: template.key, a, b, base: bse, out: null,
        meanA: mean(a), meanB: mean(b), meanOut: null, kind: "forgotten",
      });
      continue;
    }

    const count = (a?.count ?? 0) + (b?.count ?? 0) - (bse?.count ?? 0);
    const valueSum = (a?.valueSum ?? 0) + (b?.valueSum ?? 0) - (bse?.valueSum ?? 0);
    const weightSum = (a?.weightSum ?? 0) + (b?.weightSum ?? 0) - (bse?.weightSum ?? 0);

    if (count < 0 || weightSum < 0) {
      slots.push({
        uid, key: template.key, a, b, base: bse, out: null,
        meanA: mean(a), meanB: mean(b), meanOut: null, kind: "conflict",
      });
      conflicts.push({
        key: template.key,
        message: `「${template.key}」的计数在减去共同起点后为负，说明共同起点取错了`,
      });
      continue;
    }

    const out = count === 0 ? null : { count, valueSum, weightSum };
    const kind: MergePreviewSlot["kind"] =
      !a ? "new-b" : !b ? "new-a" : "add";
    slots.push({
      uid, key: template.key, a, b, base: bse, out,
      meanA: mean(a), meanB: mean(b), meanOut: mean(out), kind,
    });
  }

  const allScalarUids = new Set([
    ...Object.keys(left.state.scalars),
    ...Object.keys(right.state.scalars),
    ...Object.keys(baseState.scalars),
  ]);

  for (const uid of [...allScalarUids].sort()) {
    const a = left.state.scalars[uid] ?? null;
    const b = right.state.scalars[uid] ?? null;
    const bse = baseState.scalars[uid] ?? null;
    const template = a ?? b ?? bse;
    if (!template) continue;
    if (left.state.tombstones[uid] || right.state.tombstones[uid]) continue;

    const aChanged = (a?.text ?? null) !== (bse?.text ?? null);
    const bChanged = (b?.text ?? null) !== (bse?.text ?? null);
    let kind: MergePreviewScalar["kind"];
    let out: string | null;

    if (aChanged && bChanged && (a?.text ?? null) !== (b?.text ?? null)) {
      kind = "conflict";
      out = null;
      conflicts.push({
        key: template.key,
        message: `两条线都把「${template.key}」改成了不同内容：「${a?.text}」对「${b?.text}」`,
      });
    } else if (aChanged) {
      kind = "take-a";
      out = a?.text ?? null;
    } else if (bChanged) {
      kind = "take-b";
      out = b?.text ?? null;
    } else {
      kind = "same";
      out = a?.text ?? b?.text ?? null;
    }

    scalars.push({
      uid, key: template.key,
      a: a?.text ?? null, b: b?.text ?? null, base: bse?.text ?? null,
      out, kind,
    });
  }

  const merged = slots.filter((s) => s.out);
  const added = merged.filter((s) => s.kind === "add" || s.kind === "new-a" || s.kind === "new-b");

  const summary = conflicts.length
    ? `接不上：有 ${conflicts.length} 处内容冲突，需要先决定听谁的`
    : added.length
      ? `接得上：${added.length} 条记忆会合并，${scalars.filter((s) => s.kind).length} 个设定会保留`
      : "接得上：两条线没有互相覆盖的内容";

  return {
    ok: conflicts.length === 0,
    baseLabel: base?.label ?? "（没有共同起点）",
    baseId: base?.id ?? "",
    leftLabel: left.label,
    rightLabel: right.label,
    nodes: Object.keys(data.nodes).length,
    slots,
    scalars,
    conflicts,
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* 一致性检查                                                          */
/* ------------------------------------------------------------------ */

export interface InspectIssue {
  level: "error" | "warn";
  nodeId: string;
  message: string;
}

export interface InspectReport {
  ok: boolean;
  nodeCount: number;
  auditCount: number;
  branches: number;
  merges: number;
  rollbacks: number;
  tombstones: number;
  issues: InspectIssue[];
}

export function inspectTree(data: WorldTreeData): InspectReport {
  const issues: InspectIssue[] = [];
  const nodes = Object.values(data.nodes);

  if (!data.rootId || !data.nodes[data.rootId]) {
    issues.push({ level: "error", nodeId: "", message: "根节点缺失" });
  }

  for (const node of nodes) {
    if (node.stateHash !== hashState(node.state)) {
      issues.push({
        level: "error",
        nodeId: node.id,
        message: `状态哈希不匹配：记录 ${node.stateHash}，实际 ${hashState(node.state)}`,
      });
    }
    if (node.parentId && !data.nodes[node.parentId]) {
      issues.push({ level: "error", nodeId: node.id, message: `父节点 ${node.parentId} 不存在` });
    }
    if (node.kind === "merge" && node.parentId) {
      const parent = data.nodes[node.parentId];
      // 合并节点必须满足：状态 = 父状态与其兄弟枝的三路合并。
      // 这里只做可判定的弱校验 —— 若父节点也是合并节点，跳过。
      if (parent && parent.kind !== "merge" && node.stateHash === parent.stateHash) {
        issues.push({
          level: "warn",
          nodeId: node.id,
          message: "合并节点的状态与父节点完全相同，可能是空合并",
        });
      }
    }
  }

  // 环检测
  for (const node of nodes) {
    const seen = new Set<string>();
    let cursor: WorldNode | undefined = node;
    while (cursor?.parentId) {
      if (seen.has(cursor.id)) {
        issues.push({ level: "error", nodeId: node.id, message: "父链成环" });
        break;
      }
      seen.add(cursor.id);
      cursor = data.nodes[cursor.parentId];
    }
  }

  return {
    ok: issues.every((issue) => issue.level !== "error"),
    nodeCount: nodes.length,
    auditCount: data.audit.length,
    branches: nodes.filter((n) => n.kind === "branch").length,
    merges: nodes.filter((n) => n.kind === "merge").length,
    rollbacks: nodes.filter((n) => n.kind === "rollback").length,
    tombstones: nodes.reduce((sum, n) => sum + Object.keys(n.state.tombstones).length, 0),
    issues,
  };
}
