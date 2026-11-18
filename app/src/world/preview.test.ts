import { describe, expect, it } from "vitest";
import { WorldTree, previewMerge } from "./engine";

/** 两条分支，各写了点东西。 */
function fork() {
  const tree = WorldTree.create("世界");
  const root = tree.root;
  const a = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 6 }, "A 先走");
  const b = tree.observe(root.id, { uid: "m2", key: "房租", value: 4 }, "B 先走");
  return { tree, a, b };
}

describe("合并预演", () => {
  it("两条各写各的：预演显示相加后的均值", () => {
    const { tree, a, b } = fork();
    const p = previewMerge(tree.toData(), a.id, b.id);
    expect(p).not.toBeNull();
    expect(p!.ok).toBe(true);

    const m1 = p!.slots.find((s) => s.key === "焦虑");
    expect(m1?.kind).toBe("new-a");
    expect(m1?.meanOut).toBe(6);

    const m2 = p!.slots.find((s) => s.key === "房租");
    expect(m2?.kind).toBe("new-b");
    expect(m2?.meanOut).toBe(4);

    expect(p!.conflicts).toHaveLength(0);
    expect(p!.summary).toContain("接得上");
  });

  it("同一记忆两边都写：预演给出合并后的均值与计数", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const a = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 8 }, "A");
    const b = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 2 }, "B");

    const p = previewMerge(tree.toData(), a.id, b.id)!;
    const m1 = p.slots.find((s) => s.key === "焦虑")!;
    expect(m1.kind).toBe("add");
    // 3 次观测：根上 0 次 + A 的 8 + B 的 2（base 是根，没有这个槽）
    expect(m1.out?.count).toBe(2);
    expect(m1.meanOut).toBe(5);
  });

  it("标量冲突：预演报出不 ok，并说清两边各写了什么", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const a = tree.setScalar(root.id, "s1", "结局", "她去了上海", "A 的结局");
    const b = tree.setScalar(root.id, "s1", "结局", "她留在青岛", "B 的结局");

    const p = previewMerge(tree.toData(), a.id, b.id)!;
    expect(p.ok).toBe(false);
    expect(p.conflicts).toHaveLength(1);
    expect(p.conflicts[0].key).toBe("结局");
    expect(p.conflicts[0].message).toContain("她去了上海");
    expect(p.conflicts[0].message).toContain("她留在青岛");
    expect(p.summary).toContain("接不上");

    const s = p.scalars.find((x) => x.key === "结局")!;
    expect(s.kind).toBe("conflict");
    expect(s.out).toBeNull();
  });

  it("只有一边改标量：预演说明采用哪一边", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const base = tree.setScalar(root.id, "s1", "结局", "未定", "还没想好");
    const a = tree.setScalar(base.id, "s1", "结局", "她去了上海", "A 改了");
    const b = base;

    const p = previewMerge(tree.toData(), a.id, b.id)!;
    const s = p.scalars.find((x) => x.key === "结局")!;
    expect(s.kind).toBe("take-a");
    expect(s.out).toBe("她去了上海");
    expect(p.ok).toBe(true);
  });

  it("墓碑：预演标成 forgotten，不会复活", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const a = tree.observe(root.id, { uid: "m1", key: "焦虑", value: 6 }, "A 记下");
    const b = tree.forget(root.id, "m1", "整理时收起");

    const p = previewMerge(tree.toData(), a.id, b.id)!;
    const m1 = p.slots.find((s) => s.key === "焦虑");
    expect(m1?.kind).toBe("forgotten");
    expect(m1?.out).toBeNull();
  });

  it("预演是只读的：调用前后树完全不变", () => {
    const { tree, a, b } = fork();
    const before = JSON.stringify(tree.toData());
    previewMerge(tree.toData(), a.id, b.id);
    const after = JSON.stringify(tree.toData());
    expect(after).toBe(before);
  });

  it("base 取最近公共祖先，并报出它的名字", () => {
    const tree = WorldTree.create("世界");
    const root = tree.root;
    const mid = tree.observe(root.id, { uid: "m0", key: "起点", value: 1 }, "共同的一步");
    const a = tree.observe(mid.id, { uid: "m1", key: "A", value: 3 }, "A");
    const b = tree.observe(mid.id, { uid: "m2", key: "B", value: 3 }, "B");

    const p = previewMerge(tree.toData(), a.id, b.id)!;
    expect(p.baseId).toBe(mid.id);
    expect(p.baseLabel).toBe("共同的一步");
  });

  it("节点不存在时返回 null，而不是抛错", () => {
    const { tree, a } = fork();
    expect(previewMerge(tree.toData(), a.id, "nope")).toBeNull();
  });
});
