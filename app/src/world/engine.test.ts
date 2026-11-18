import { describe, expect, it } from "vitest";
import {
  MergeError,
  WorldTree,
  applyObservation,
  emptyState,
  hashState,
  inspectTree,
  mergeStates,
  slotMean,
  type WorldState,
} from "./engine";

/** 造一个只有一条观测的状态，方便对比合并语义。 */
function stateWith(values: Record<string, { key: string; value: number }>): WorldState {
  let state = emptyState();
  for (const [uid, { key, value }] of Object.entries(values)) {
    state = applyObservation(state, { uid, key, value });
  }
  return state;
}

describe("merge3 充分统计量合并", () => {
  it("两条独立观测合并后 count 相加、均值正确", () => {
    const a = stateWith({ m1: { key: "焦虑", value: 6 } });
    const b = stateWith({ m2: { key: "房租", value: 4 } });
    const merged = mergeStates(a, b, emptyState());

    expect(merged.numeric.m1.count).toBe(1);
    expect(merged.numeric.m2.count).toBe(1);
    expect(slotMean(merged.numeric.m1)).toBe(6);
    expect(slotMean(merged.numeric.m2)).toBe(4);
  });

  it("同一槽在两个分支各观测一次，合并后 count = 2 且均值是两次的平均", () => {
    const a = stateWith({ m1: { key: "焦虑", value: 6 } });
    const b = stateWith({ m1: { key: "焦虑", value: 4 } });
    const merged = mergeStates(a, b, emptyState());

    expect(merged.numeric.m1.count).toBe(2);
    expect(slotMean(merged.numeric.m1)).toBe(5);
  });

  it("交换律：merge(a,b) 与 merge(b,a) 结果相同", () => {
    const base = stateWith({ m1: { key: "焦虑", value: 5 } });
    const a = applyObservation(base, { uid: "m1", key: "焦虑", value: 8 });
    const b = applyObservation(base, { uid: "m1", key: "焦虑", value: 2 });

    const ab = mergeStates(a, b, base);
    const ba = mergeStates(b, a, base);

    expect(hashState(ab)).toBe(hashState(ba));
    // 三次观测：base 的 5、a 的 8、b 的 2 —— base 那次是共同历史，保留一次
    expect(ab.numeric.m1.count).toBe(3);
    expect(slotMean(ab.numeric.m1)).toBe(5);
  });

  it("结合律：先合 a、b 再合 c，与先合 b、c 再合 a 一致", () => {
    const base = emptyState();
    const a = stateWith({ m1: { key: "焦虑", value: 3 } });
    const b = stateWith({ m1: { key: "焦虑", value: 5 } });
    const c = stateWith({ m1: { key: "焦虑", value: 7 } });

    const left = mergeStates(mergeStates(a, b, base), c, base);
    const right = mergeStates(a, mergeStates(b, c, base), base);

    expect(hashState(left)).toBe(hashState(right));
    expect(left.numeric.m1.count).toBe(3);
    expect(slotMean(left.numeric.m1)).toBe(5);
  });

  it("标量槽两侧改成不同值 → 拒绝合并并说明冲突字段", () => {
    const base = emptyState();
    const a: WorldState = {
      ...emptyState(),
      scalars: { s1: { uid: "s1", key: "结局", text: "她去了上海" } },
    };
    const b: WorldState = {
      ...emptyState(),
      scalars: { s1: { uid: "s1", key: "结局", text: "她留在青岛" } },
    };

    let error: unknown;
    try {
      mergeStates(a, b, base);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MergeError);
    expect((error as MergeError).conflict.reason).toBe("scalar-diverged");
    expect((error as MergeError).conflict.keys).toContain("结局");
  });

  it("只有一侧改标量 → 直接采用改动的一侧", () => {
    const base: WorldState = {
      ...emptyState(),
      scalars: { s1: { uid: "s1", key: "结局", text: "未定" } },
    };
    const a = base;
    const b: WorldState = {
      ...emptyState(),
      scalars: { s1: { uid: "s1", key: "结局", text: "她去了上海" } },
    };
    const merged = mergeStates(a, b, base);
    expect(merged.scalars.s1.text).toBe("她去了上海");
  });

  it("墓碑永远赢：一侧删掉的记忆不会被另一侧复活", () => {
    const a = stateWith({ m1: { key: "焦虑", value: 5 } });
    const b: WorldState = {
      ...a,
      numeric: {},
      tombstones: { m1: "低显著度噪声" },
    };
    const merged = mergeStates(a, b, emptyState());
    expect(merged.numeric.m1).toBeUndefined();
    expect(merged.tombstones.m1).toBe("低显著度噪声");
  });

  it("base 不是共同祖先时抛出 negative-count，而不是静默算错", () => {
    const a = stateWith({ m1: { key: "焦虑", value: 5 } });
    const b = stateWith({ m2: { key: "房租", value: 3 } });
    // base 里 m1 的 count 比 a 还大，减法必为负
    let bogusBase = emptyState();
    bogusBase = applyObservation(bogusBase, { uid: "m1", key: "焦虑", value: 9 });
    bogusBase = applyObservation(bogusBase, { uid: "m1", key: "焦虑", value: 9 });

    expect(() => mergeStates(a, b, bogusBase)).toThrow(MergeError);
  });
});

describe("版本树 branch / merge / rollback", () => {
  it("分叉两条线各自观测，合并后两边的记忆都在", () => {
    const tree = WorldTree.create("林夏的毕业选择");
    const root = tree.root;
    const left = tree.observe(root.id, { uid: "m-sh", key: "上海", value: 8 }, "上海线");
    const right = tree.observe(root.id, { uid: "m-qd", key: "青岛", value: 6 }, "青岛线");

    const merged = tree.merge(left.id, right.id);
    expect(merged.kind).toBe("merge");
    expect(merged.state.numeric["m-sh"]).toBeDefined();
    expect(merged.state.numeric["m-qd"]).toBeDefined();
  });

  it("merge 用 LCA 做 base：共同祖先里的观测不会被算两次", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const shared = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 5 }, "共同记忆");
    const a = tree.observe(shared.id, { uid: "m1", key: "焦虑", value: 8 }, "上海线追加");
    const b = tree.observe(shared.id, { uid: "m1", key: "焦虑", value: 2 }, "青岛线追加");

    const merged = tree.merge(a.id, b.id);
    const lca = tree.lca(a.id, b.id);
    expect(lca?.id).toBe(shared.id);
    // 三次观测都在：shared 的 5、a 的 8、b 的 2；均值仍是 5
    expect(merged.state.numeric.m1.count).toBe(3);
    expect(slotMean(merged.state.numeric.m1)).toBe(5);
  });

  it("重复合并同一枝是幂等的：快进返回，统计量不翻倍", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const a = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 4 });
    const b = tree.observe(root.id, { uid: "m2", key: "房租", value: 9 });

    const once = tree.merge(a.id, b.id);
    const twice = tree.merge(once.id, b.id);

    expect(twice.id).toBe(once.id);
    expect(twice.state.numeric.m1.count).toBe(1);
    expect(twice.state.numeric.m2.count).toBe(1);
  });

  it("合并结果的交换律在树上也成立", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const a = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 4 });
    const b = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 6 });

    const ab = tree.merge(a.id, b.id);
    const ba = tree.merge(b.id, a.id);

    expect(ab.stateHash).toBe(ba.stateHash);
    expect(slotMean(ab.state.numeric.m1)).toBe(5);
  });

  it("回滚把目标状态搬回线末，且不删除历史节点", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const step1 = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 7 });
    const step2 = tree.observe(step1.id, { uid: "m2", key: "房租", value: 3 });
    const before = tree.nodes.length;

    const rolled = tree.rollback(step2.id, step1.id);
    expect(rolled.stateHash).toBe(step1.stateHash);
    expect(rolled.state.numeric.m2).toBeUndefined();
    expect(tree.nodes.length).toBe(before + 1);
    expect(tree.node(step2.id)).toBeDefined();
  });

  it("回滚可以回到被遗忘之前，但墓碑不会因此消失", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const step1 = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 7 });
    const step2 = tree.forget(step1.id, "m1", "低显著度噪声");

    expect(step2.state.numeric.m1).toBeUndefined();
    const rolled = tree.rollback(step2.id, step1.id);
    // 回滚到遗忘之前，记忆回来
    expect(rolled.state.numeric.m1).toBeDefined();
    // 但之后新状态里墓碑仍在，防止它被后来的合并复活
    expect(step2.state.tombstones.m1).toBe("低显著度噪声");
  });

  it("审计日志逐条记录了每个动作", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const a = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 4 });
    const b = tree.branch(a.id, "上海线");
    tree.merge(a.id, b.id);

    const actions = tree.audit.map((entry) => entry.action);
    expect(actions).toContain("init");
    expect(actions).toContain("observe");
    expect(actions).toContain("branch");
    expect(actions).toContain("merge");
    // 每条审计都带状态哈希，便于事后核对
    for (const entry of tree.audit) {
      expect(entry.stateHash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("inspect 能报出完整性与节点统计", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const a = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 4 });
    const b = tree.branch(a.id, "上海线");
    tree.merge(a.id, b.id);

    const report = inspectTree(tree.toData());
    expect(report.ok).toBe(true);
    expect(report.branches).toBe(1);
    expect(report.merges).toBe(1);
    expect(report.issues.filter((issue) => issue.level === "error")).toHaveLength(0);
  });

  it("inspect 能发现被篡改的状态哈希", () => {
    const tree = WorldTree.create("世界");
    tree.observe(tree.root.id, { uid: "m1", key: "焦虑", value: 4 });

    const data = tree.toData();
    const anyId = Object.keys(data.nodes)[0];
    data.nodes[anyId].stateHash = "deadbeef";

    const report = inspectTree(data);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes("状态哈希不匹配"))).toBe(true);
  });
});
