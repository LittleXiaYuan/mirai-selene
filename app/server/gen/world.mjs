// src/world/engine.ts
var MergeError = class extends Error {
  conflict;
  constructor(conflict) {
    super(conflict.message);
    this.name = "MergeError";
    this.conflict = conflict;
  }
};
function emptyState() {
  return { numeric: {}, scalars: {}, tombstones: {} };
}
function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function hashState(state) {
  let h = 2166136261;
  const mix = (text) => {
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 31;
    h = Math.imul(h, 16777619) >>> 0;
  };
  const mixNum = (n) => {
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
function cloneState(state) {
  return {
    numeric: Object.fromEntries(Object.entries(state.numeric).map(([k, v]) => [k, { ...v }])),
    scalars: Object.fromEntries(Object.entries(state.scalars).map(([k, v]) => [k, { ...v }])),
    tombstones: { ...state.tombstones }
  };
}
function timeOfDay(hour) {
  const h = (Math.round(hour) % 24 + 24) % 24;
  if (h >= 5 && h < 9) return "\u6E05\u6668";
  if (h >= 9 && h < 15) return "\u6B63\u5348";
  if (h >= 15 && h < 20) return "\u9EC4\u660F";
  return "\u6DF1\u591C";
}
function slotMean(slot) {
  return slot.count === 0 ? 0 : slot.valueSum / slot.count;
}
function applyObservation(state, obs) {
  const next = cloneState(state);
  if (next.tombstones[obs.uid]) return next;
  const weight = obs.weight ?? 1;
  const existing = next.numeric[obs.uid];
  next.numeric[obs.uid] = existing ? {
    ...existing,
    count: existing.count + 1,
    valueSum: existing.valueSum + obs.value,
    weightSum: existing.weightSum + weight
  } : { uid: obs.uid, key: obs.key, count: 1, valueSum: obs.value, weightSum: weight };
  return next;
}
function applyScalar(state, uid, key, text) {
  const next = cloneState(state);
  if (next.tombstones[uid]) return next;
  next.scalars[uid] = { uid, key, text };
  return next;
}
function applyTombstone(state, uid, reason) {
  const next = cloneState(state);
  delete next.numeric[uid];
  delete next.scalars[uid];
  next.tombstones[uid] = reason;
  return next;
}
function mergeStates(a, b, base = emptyState()) {
  const out = emptyState();
  const conflicts = [];
  const numericUids = /* @__PURE__ */ new Set([
    ...Object.keys(a.numeric),
    ...Object.keys(b.numeric),
    ...Object.keys(base.numeric)
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
    if (count < 0 || weightSum < 0) {
      throw new MergeError({
        reason: "negative-count",
        message: `\u69FD ${template.key} \u7684\u5145\u5206\u7EDF\u8BA1\u91CF\u5728\u51CF\u53BB base \u540E\u4E3A\u8D1F\uFF0C\u8BF4\u660E base \u4E0D\u662F\u5171\u540C\u7956\u5148`,
        keys: [template.key]
      });
    }
    if (count === 0) continue;
    out.numeric[uid] = { uid, key: template.key, count, valueSum, weightSum };
  }
  const scalarUids = /* @__PURE__ */ new Set([
    ...Object.keys(a.scalars),
    ...Object.keys(b.scalars),
    ...Object.keys(base.scalars)
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
      message: `\u4E24\u6761\u4E16\u754C\u7EBF\u90FD\u6539\u8FC7\u8FD9\u4E9B\u5B57\u6BB5\u4E14\u53D6\u503C\u4E0D\u540C\uFF0C\u62D2\u7EDD\u9759\u9ED8\u62E9\u4E00\uFF1A${conflicts.join("\u3001")}`,
      keys: conflicts
    });
  }
  out.tombstones = { ...a.tombstones, ...b.tombstones, ...base.tombstones };
  return out;
}
function projectObservation(state, obs) {
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
    isNew: !existing
  };
}
function projectChoices(state, choices) {
  const out = {};
  for (const c of choices) {
    out[c.id] = projectObservation(state, { uid: c.uid, key: c.key, value: c.value });
  }
  return out;
}
function uidForKey(state, key) {
  for (const [uid, slot] of Object.entries(state.numeric)) {
    if (slot.key === key) return uid;
  }
  return `m-${key}`;
}
var PRESSURE_WORDS = /压力|紧|焦|怕|冷|疏|怀疑|累|堵|撑不住|慌|房租|风险|冲突|后悔|失去/;
var WARMTH_WORDS = /安心|温|信任|家|喜欢|平静|靠|暖|踏实|被理解|联系|支持|陪伴|满足/;
function readMood(state) {
  let pressure = 0;
  let warmth = 0;
  let dominant = null;
  for (const slot of Object.values(state.numeric)) {
    const value = slotMean(slot);
    if (dominant === null || value > dominant.value) {
      dominant = { key: slot.key, value: Math.round(value * 10) / 10 };
    }
    if (PRESSURE_WORDS.test(slot.key)) pressure += value;
    else if (WARMTH_WORDS.test(slot.key)) warmth += value;
    else {
      pressure += value * 0.5;
      warmth += value * 0.5;
    }
  }
  const balance = Math.round((warmth - pressure) * 10) / 10;
  const p = Math.round(pressure * 10) / 10;
  const w = Math.round(warmth * 10) / 10;
  let line;
  if (!dominant) line = "\u8FD8\u6CA1\u6709\u7559\u4E0B\u4EC0\u4E48\uFF0C\u4E16\u754C\u662F\u5E72\u51C0\u7684\u3002";
  else if (balance > 3) line = `\u5979\u6BD4\u521A\u8FDB\u6765\u65F6\u7A33\u3002\u6491\u4F4F\u5979\u7684\u66F4\u591A\uFF0C\u5360\u4E0A\u98CE\u7684\u662F\u300C${dominant.key}\u300D\u3002`;
  else if (balance < -3) line = `\u5979\u7EF7\u5F97\u6BD4\u4E00\u5F00\u59CB\u7D27\u3002\u538B\u7740\u5979\u7684\u66F4\u591A\uFF0C\u6700\u91CD\u7684\u662F\u300C${dominant.key}\u300D\u3002`;
  else line = `\u5979\u5728\u4E2D\u95F4\u6447\u6446\uFF0C\u4E24\u8FB9\u90FD\u4E0D\u7B97\u538B\u5012\u3002\u6700\u5728\u610F\u7684\u662F\u300C${dominant.key}\u300D\u3002`;
  return { pressure: p, warmth: w, balance, dominant, line };
}
function balanceTone(balance) {
  if (balance > 3) return "warm";
  if (balance < -3) return "tight";
  return "mid";
}
function balanceWord(balance) {
  const tone = balanceTone(balance);
  return tone === "warm" ? "\u504F\u7A33" : tone === "tight" ? "\u7EF7\u7D27" : "\u6447\u6446";
}
function diffState(from, to) {
  const out = [];
  const round = (n) => Math.round(n * 10) / 10;
  for (const [uid, slot] of Object.entries(to.numeric)) {
    const prev = from.numeric[uid];
    if (prev && prev.count === slot.count) continue;
    const before = prev ? slotMean(prev) : 0;
    const after = slotMean(slot);
    out.push({
      key: slot.key,
      before: round(before),
      after: round(after),
      delta: round(after - before),
      count: slot.count
    });
  }
  for (const [uid, slot] of Object.entries(from.numeric)) {
    if (to.numeric[uid]) continue;
    const before = slotMean(slot);
    out.push({
      key: slot.key,
      before: round(before),
      after: 0,
      delta: -round(before),
      count: 0
    });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
function readDelta(deltas) {
  if (!deltas.length) return "";
  const top = deltas[0];
  const rest = deltas.length - 1;
  let head;
  if (top.count === 0) head = `\u300C${top.key}\u300D\u88AB\u6574\u7406\u6389\u4E86`;
  else if (top.count === 1) head = `\u8FD9\u4E00\u6B65\u7B2C\u4E00\u6B21\u7559\u4E0B\u300C${top.key}\u300D\uFF0C\u5F3A\u5EA6 ${top.after}`;
  else if (top.delta > 0) head = `\u300C${top.key}\u300D\u4ECE ${top.before} \u63A8\u5230 ${top.after}`;
  else if (top.delta < 0) head = `\u300C${top.key}\u300D\u4ECE ${top.before} \u843D\u5230 ${top.after}`;
  else head = `\u300C${top.key}\u300D\u8FD8\u662F ${top.after}\uFF0C\u8FD9\u4E00\u6B21\u6CA1\u6539\u52A8\u5B83`;
  return rest > 0 ? `${head}\uFF0C\u53E6\u5916${rest}\u9879\u4E5F\u52A8\u4E86\u3002` : `${head}\u3002`;
}
var nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
var WorldTree = class _WorldTree {
  data;
  constructor(data) {
    this.data = data ?? {
      nodes: {},
      rootId: "",
      audit: [],
      seq: 0
    };
  }
  static create(label = "\u539F\u70B9", state = emptyState()) {
    const tree = new _WorldTree();
    tree.init(label, state);
    return tree;
  }
  static fromData(data) {
    return new _WorldTree(data);
  }
  init(label, state) {
    const node = this.pushNode(null, label, "root", state);
    this.data.rootId = node.id;
    this.log("init", node.id, `\u521B\u5EFA\u4E16\u754C\u300C${label}\u300D`);
    return node;
  }
  toData() {
    return {
      nodes: Object.fromEntries(
        Object.entries(this.data.nodes).map(([k, v]) => [k, { ...v, state: cloneState(v.state) }])
      ),
      rootId: this.data.rootId,
      audit: this.data.audit.map((entry) => ({ ...entry })),
      seq: this.data.seq
    };
  }
  nextSeq() {
    this.data.seq += 1;
    return this.data.seq;
  }
  pushNode(parentId, label, kind, state, mergedFrom = [], meta) {
    const seq = this.nextSeq();
    const node = {
      id: `n${seq}-${hashState(state).slice(0, 4)}`,
      parentId,
      label,
      kind,
      state: cloneState(state),
      stateHash: hashState(state),
      createdAt: nowIso(),
      seq,
      mergedFrom: [...mergedFrom],
      ...meta ? { meta: { ...meta } } : {}
    };
    this.data.nodes[node.id] = node;
    return node;
  }
  log(action, nodeId, detail) {
    const node = this.data.nodes[nodeId];
    this.data.audit.push({
      seq: this.data.audit.length + 1,
      at: nowIso(),
      action,
      nodeId,
      detail,
      stateHash: node?.stateHash ?? ""
    });
  }
  get root() {
    return this.data.nodes[this.data.rootId];
  }
  get nodes() {
    return Object.values(this.data.nodes).sort((x, y) => x.seq - y.seq);
  }
  get audit() {
    return this.data.audit.map((entry) => ({ ...entry }));
  }
  node(id) {
    return this.data.nodes[id];
  }
  children(id) {
    return this.nodes.filter((node) => node.parentId === id);
  }
  /** 从根到该节点的路径，根在前。 */
  pathTo(id) {
    const path = [];
    let cursor = this.data.nodes[id];
    const guard = /* @__PURE__ */ new Set();
    while (cursor) {
      if (guard.has(cursor.id)) break;
      guard.add(cursor.id);
      path.unshift(cursor);
      cursor = cursor.parentId ? this.data.nodes[cursor.parentId] : void 0;
    }
    return path;
  }
  isAncestor(candidateId, descendantId) {
    if (candidateId === descendantId) return true;
    let cursor = this.data.nodes[descendantId];
    const guard = /* @__PURE__ */ new Set();
    while (cursor?.parentId) {
      if (guard.has(cursor.id)) return false;
      guard.add(cursor.id);
      if (cursor.parentId === candidateId) return true;
      cursor = this.data.nodes[cursor.parentId];
    }
    return false;
  }
  /** 最近公共祖先 —— 三路合并的 base 必须取它，否则减法会算错。 */
  lca(leftId, rightId) {
    const leftPath = this.pathTo(leftId).map((node) => node.id);
    const rightSet = new Set(this.pathTo(rightId).map((node) => node.id));
    for (let i = leftPath.length - 1; i >= 0; i -= 1) {
      if (rightSet.has(leftPath[i])) return this.data.nodes[leftPath[i]];
    }
    return void 0;
  }
  /** 在当前节点上记录一次观测，返回新节点。 */
  observe(parentId, obs, label, meta) {
    const parent = this.require(parentId);
    const state = applyObservation(parent.state, obs);
    const node = this.pushNode(
      parent.id,
      label ?? `\u89C2\u6D4B ${obs.key} = ${obs.value}`,
      "observe",
      state,
      [],
      meta
    );
    this.log("observe", node.id, `${obs.key} \u8BB0\u4E00\u6B21 ${obs.value}\uFF08\u6743\u91CD ${obs.weight ?? 1}\uFF09`);
    return node;
  }
  setScalar(parentId, uid, key, text, label) {
    const parent = this.require(parentId);
    const state = applyScalar(parent.state, uid, key, text);
    const node = this.pushNode(parent.id, label ?? `\u8BBE\u5B9A ${key} = ${text}`, "set", state);
    this.log("set", node.id, `${key} \u8BBE\u4E3A\u300C${text}\u300D`);
    return node;
  }
  forget(parentId, uid, reason) {
    const parent = this.require(parentId);
    const state = applyTombstone(parent.state, uid, reason);
    const node = this.pushNode(parent.id, `\u9057\u5FD8 ${uid}`, "observe", state);
    this.log("forget", node.id, `\u5893\u7891\uFF1A${uid}\uFF08${reason}\uFF09`);
    return node;
  }
  /** 开一条新世界线：语义上是一次分叉，状态从 parent 复制。 */
  branch(parentId, label) {
    const parent = this.require(parentId);
    const node = this.pushNode(parent.id, label, "branch", parent.state);
    this.log("branch", node.id, `\u4ECE\u300C${parent.label}\u300D\u5206\u51FA\u4E16\u754C\u7EBF\u300C${label}\u300D`);
    return node;
  }
  /**
   * 合并两条世界线。
   *
   * base 取二者的 LCA。幂等性不靠「一方是另一方祖先」判断 ——
   * 合并节点并不在对方的祖先链上，那个判断会漏掉重复合并。
   * 改为显式记录 mergedFrom：已经吸收过对方就直接返回，统计量不翻倍。
   */
  merge(leftId, rightId, label) {
    const left = this.require(leftId);
    const right = this.require(rightId);
    if (left.id === right.id) return left;
    if (left.mergedFrom.includes(right.id)) return left;
    if (right.mergedFrom.includes(left.id)) return right;
    const base = this.lca(left.id, right.id);
    if (!base) {
      throw new MergeError({
        reason: "no-common-ancestor",
        message: "\u4E24\u6761\u4E16\u754C\u7EBF\u6CA1\u6709\u516C\u5171\u7956\u5148\uFF0C\u65E0\u6CD5\u4E09\u8DEF\u5408\u5E76",
        keys: []
      });
    }
    const merged = mergeStates(left.state, right.state, base.state);
    const absorbed = /* @__PURE__ */ new Set([...left.mergedFrom, ...right.mergedFrom, left.id, right.id]);
    const node = this.pushNode(
      left.id,
      label ?? `\u5408\u5E76 ${left.label} + ${right.label}`,
      "merge",
      merged,
      [...absorbed]
    );
    this.log(
      "merge",
      node.id,
      `\u5408\u5E76\u300C${left.label}\u300D\u4E0E\u300C${right.label}\u300D\uFF0Cbase =\u300C${base.label}\u300D`
    );
    return node;
  }
  /** 给节点补上呈现信息（不产生新节点，只标注这一次演出的样子）。 */
  annotate(id, meta) {
    const node = this.data.nodes[id];
    if (!node) return;
    node.meta = { ...node.meta ?? {}, ...meta };
  }
  /** 回滚：把 target 的状态搬到当前线的末端，历史不丢，只追加。 */
  rollback(fromId, targetId) {
    const from = this.require(fromId);
    const target = this.require(targetId);
    const node = this.pushNode(
      from.id,
      `\u56DE\u6EDA\u5230\u300C${target.label}\u300D`,
      "rollback",
      target.state
    );
    this.log("rollback", node.id, `\u4ECE\u300C${from.label}\u300D\u56DE\u6EDA\u5230\u300C${target.label}\u300D`);
    return node;
  }
  require(id) {
    const node = this.data.nodes[id];
    if (!node) throw new Error(`\u8282\u70B9\u4E0D\u5B58\u5728\uFF1A${id}`);
    return node;
  }
};
var mean = (s) => !s || s.count === 0 ? null : s.valueSum / s.count;
function previewMerge(data, leftId, rightId) {
  const tree = WorldTree.fromData(data);
  const left = tree.node(leftId);
  const right = tree.node(rightId);
  if (!left || !right) return null;
  const base = tree.lca(leftId, rightId);
  const baseState = base?.state ?? emptyState();
  const slots = [];
  const scalars = [];
  const conflicts = [];
  const allUids = /* @__PURE__ */ new Set([
    ...Object.keys(left.state.numeric),
    ...Object.keys(right.state.numeric),
    ...Object.keys(baseState.numeric)
  ]);
  for (const uid of [...allUids].sort()) {
    const a = left.state.numeric[uid] ?? null;
    const b = right.state.numeric[uid] ?? null;
    const bse = baseState.numeric[uid] ?? null;
    const template = a ?? b ?? bse;
    if (!template) continue;
    if (left.state.tombstones[uid] || right.state.tombstones[uid]) {
      slots.push({
        uid,
        key: template.key,
        a,
        b,
        base: bse,
        out: null,
        meanA: mean(a),
        meanB: mean(b),
        meanOut: null,
        kind: "forgotten"
      });
      continue;
    }
    const count = (a?.count ?? 0) + (b?.count ?? 0) - (bse?.count ?? 0);
    const valueSum = (a?.valueSum ?? 0) + (b?.valueSum ?? 0) - (bse?.valueSum ?? 0);
    const weightSum = (a?.weightSum ?? 0) + (b?.weightSum ?? 0) - (bse?.weightSum ?? 0);
    if (count < 0 || weightSum < 0) {
      slots.push({
        uid,
        key: template.key,
        a,
        b,
        base: bse,
        out: null,
        meanA: mean(a),
        meanB: mean(b),
        meanOut: null,
        kind: "conflict"
      });
      conflicts.push({
        key: template.key,
        message: `\u300C${template.key}\u300D\u7684\u8BA1\u6570\u5728\u51CF\u53BB\u5171\u540C\u8D77\u70B9\u540E\u4E3A\u8D1F\uFF0C\u8BF4\u660E\u5171\u540C\u8D77\u70B9\u53D6\u9519\u4E86`
      });
      continue;
    }
    const out = count === 0 ? null : { count, valueSum, weightSum };
    const kind = !a ? "new-b" : !b ? "new-a" : "add";
    slots.push({
      uid,
      key: template.key,
      a,
      b,
      base: bse,
      out,
      meanA: mean(a),
      meanB: mean(b),
      meanOut: mean(out),
      kind
    });
  }
  const allScalarUids = /* @__PURE__ */ new Set([
    ...Object.keys(left.state.scalars),
    ...Object.keys(right.state.scalars),
    ...Object.keys(baseState.scalars)
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
    let kind;
    let out;
    if (aChanged && bChanged && (a?.text ?? null) !== (b?.text ?? null)) {
      kind = "conflict";
      out = null;
      conflicts.push({
        key: template.key,
        message: `\u4E24\u6761\u7EBF\u90FD\u628A\u300C${template.key}\u300D\u6539\u6210\u4E86\u4E0D\u540C\u5185\u5BB9\uFF1A\u300C${a?.text}\u300D\u5BF9\u300C${b?.text}\u300D`
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
      uid,
      key: template.key,
      a: a?.text ?? null,
      b: b?.text ?? null,
      base: bse?.text ?? null,
      out,
      kind
    });
  }
  const merged = slots.filter((s) => s.out);
  const added = merged.filter((s) => s.kind === "add" || s.kind === "new-a" || s.kind === "new-b");
  const summary = conflicts.length ? `\u63A5\u4E0D\u4E0A\uFF1A\u6709 ${conflicts.length} \u5904\u5185\u5BB9\u51B2\u7A81\uFF0C\u9700\u8981\u5148\u51B3\u5B9A\u542C\u8C01\u7684` : added.length ? `\u63A5\u5F97\u4E0A\uFF1A${added.length} \u6761\u8BB0\u5FC6\u4F1A\u5408\u5E76\uFF0C${scalars.filter((s) => s.kind).length} \u4E2A\u8BBE\u5B9A\u4F1A\u4FDD\u7559` : "\u63A5\u5F97\u4E0A\uFF1A\u4E24\u6761\u7EBF\u6CA1\u6709\u4E92\u76F8\u8986\u76D6\u7684\u5185\u5BB9";
  return {
    ok: conflicts.length === 0,
    baseLabel: base?.label ?? "\uFF08\u6CA1\u6709\u5171\u540C\u8D77\u70B9\uFF09",
    baseId: base?.id ?? "",
    leftLabel: left.label,
    rightLabel: right.label,
    nodes: Object.keys(data.nodes).length,
    slots,
    scalars,
    conflicts,
    summary
  };
}
function inspectTree(data) {
  const issues = [];
  const nodes = Object.values(data.nodes);
  if (!data.rootId || !data.nodes[data.rootId]) {
    issues.push({ level: "error", nodeId: "", message: "\u6839\u8282\u70B9\u7F3A\u5931" });
  }
  for (const node of nodes) {
    if (node.stateHash !== hashState(node.state)) {
      issues.push({
        level: "error",
        nodeId: node.id,
        message: `\u72B6\u6001\u54C8\u5E0C\u4E0D\u5339\u914D\uFF1A\u8BB0\u5F55 ${node.stateHash}\uFF0C\u5B9E\u9645 ${hashState(node.state)}`
      });
    }
    if (node.parentId && !data.nodes[node.parentId]) {
      issues.push({ level: "error", nodeId: node.id, message: `\u7236\u8282\u70B9 ${node.parentId} \u4E0D\u5B58\u5728` });
    }
    if (node.kind === "merge" && node.parentId) {
      const parent = data.nodes[node.parentId];
      if (parent && parent.kind !== "merge" && node.stateHash === parent.stateHash) {
        issues.push({
          level: "warn",
          nodeId: node.id,
          message: "\u5408\u5E76\u8282\u70B9\u7684\u72B6\u6001\u4E0E\u7236\u8282\u70B9\u5B8C\u5168\u76F8\u540C\uFF0C\u53EF\u80FD\u662F\u7A7A\u5408\u5E76"
        });
      }
    }
  }
  for (const node of nodes) {
    const seen = /* @__PURE__ */ new Set();
    let cursor = node;
    while (cursor?.parentId) {
      if (seen.has(cursor.id)) {
        issues.push({ level: "error", nodeId: node.id, message: "\u7236\u94FE\u6210\u73AF" });
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
    issues
  };
}

// src/world/prediction.ts
function stepLine(prev, next) {
  const ledger = readDelta(diffState(prev.state, next.state));
  return `- ${next.label}\uFF1A${ledger || "\u8FD9\u4E00\u6B65\u6CA1\u6539\u52A8\u5979\u7684\u72B6\u6001\u3002"}`;
}
function buildPredictionCard(input) {
  const { worldName, who, path, state, license } = input;
  const mood = readMood(state);
  const steps = path.filter((n) => n.kind !== "root");
  const lines = [];
  lines.push(`# ${worldName} \xB7 \u9884\u6D4B\u5361`, "");
  lines.push(`\u751F\u6210\u4E8E ${input.at} \xB7 Mirai-Selene`, "");
  lines.push("## \u8D70\u8FC7");
  if (steps.length === 0) {
    lines.push("\u8FD8\u6CA1\u6709\u8D70\u8FC7\u4EFB\u4F55\u4E00\u6B65\u3002");
  } else {
    steps.forEach((n, i) => lines.push(`${i + 1}. ${n.label}`));
  }
  lines.push("");
  lines.push("## \u73B0\u5728\u7684\u8BFB\u6570");
  if (!mood.dominant) {
    lines.push("\u5979\u8FD8\u6CA1\u6709\u7559\u4E0B\u8BB0\u5FC6\uFF0C\u8BFB\u6570\u662F\u96F6\u3002");
  } else {
    lines.push(`\u6696 ${mood.warmth} \xB7 \u7D27 ${mood.pressure} \xB7 ${balanceWord(mood.balance)}`, "");
    lines.push(
      `${balanceWord(mood.balance)}\uFF1A\u6491\u4F4F\u5979\u7684 ${mood.warmth}\uFF0C\u538B\u7740\u5979\u7684 ${mood.pressure}\uFF0C\u5DEE ${mood.balance > 0 ? "+" : ""}${mood.balance}\u3002`
    );
    lines.push(`\u6700\u91CD\u7684\u662F\u300C${mood.dominant.key}\u300D\uFF0C\u5F3A\u5EA6 ${mood.dominant.value}\u3002`);
  }
  lines.push("");
  lines.push("## \u6BCF\u4E00\u6B65\u7684\u8D26");
  if (path.length < 2) {
    lines.push("\u53EA\u6709\u4E00\u4E2A\u8D77\u70B9\uFF0C\u8FD8\u6CA1\u6709\u53EF\u8BB0\u7684\u8D26\u3002");
  } else {
    for (let i = 1; i < path.length; i += 1) lines.push(stepLine(path[i - 1], path[i]));
  }
  lines.push("");
  lines.push("## \u8FD9\u6761\u7EBF\u7684\u5F62\u72B6");
  lines.push(
    `${steps.length} \u6B65\uFF0C${path.length} \u4E2A\u8282\u70B9\uFF1B${input.branches} \u6761\u5C94\u8DEF\uFF0C${input.merges} \u6B21\u63A5\u4E0A\uFF0C${input.tombstones} \u4EF6\u4E8B\u88AB\u6574\u7406\u6389\uFF08\u5408\u5E76\u65F6\u4E0D\u4F1A\u590D\u6D3B\uFF09\u3002`
  );
  lines.push("");
  lines.push("## \u8FB9\u754C");
  lines.push("- \u8BFB\u6570\u662F\u4ECE\u72B6\u6001\u7B97\u51FA\u6765\u7684\uFF0C\u4E0D\u662F\u6982\u7387\u9884\u6D4B\u3002\u5B83\u56DE\u7B54\u300C\u5979\u73B0\u5728\u504F\u5728\u54EA\u8FB9\u300D\uFF0C\u4E0D\u56DE\u7B54\u300C\u5979\u4EE5\u540E\u4F1A\u4E0D\u4F1A\u6210\u529F\u300D\u3002");
  lines.push("- \u80FD\u590D\u73B0\u7684\u524D\u63D0\u662F\u540C\u4E00\u4EFD\u4E16\u754C\u6587\u4EF6\uFF1A\u540C\u4E00\u72B6\u6001\u6C38\u8FDC\u540C\u4E00\u8BFB\u6570\u3002");
  lines.push(`- \u6388\u6743\uFF1A${license.label}\u3002${license.terms}`);
  lines.push("");
  return lines.join("\n");
}
export {
  MergeError,
  WorldTree,
  applyObservation,
  applyScalar,
  applyTombstone,
  balanceTone,
  balanceWord,
  buildPredictionCard,
  cloneState,
  diffState,
  emptyState,
  hashState,
  hashString,
  inspectTree,
  mergeStates,
  previewMerge,
  projectChoices,
  projectObservation,
  readDelta,
  readMood,
  slotMean,
  timeOfDay,
  uidForKey
};
