import { describe, expect, it } from "vitest";
import { WorldTree, hashState } from "./engine";
import {
  WorldFileError,
  WORLD_FILE_MAGIC,
  exportWorldFile,
  inspectWorldFile,
  parseWorldFile,
  roundTrip,
  serializeWorldFile,
} from "./worldfile";

/** 造一棵有分支、合并、回滚、墓碑的树，用来测往返。 */
function sampleTree() {
  const tree = WorldTree.create("林夏的毕业选择");
  const root = tree.root;
  const shanghai = tree.observe(root.id, { uid: "m-sh", key: "上海", value: 8 }, "去上海");
  const kaoyan = tree.observe(root.id, { uid: "m-ky", key: "考研", value: 6 }, "留校读研");
  const merged = tree.merge(shanghai.id, kaoyan.id, "两条线收束");
  const forgotten = tree.forget(merged.id, "m-sh", "梦里的噪声");
  const rolled = tree.rollback(forgotten.id, merged.id);
  tree.branch(rolled.id, "第三条线");
  return tree;
}

describe("World File 导出 / 校验 / 载入", () => {
  it("导出的文件带 magic、版本与 checksum", () => {
    const tree = sampleTree();
    const file = exportWorldFile(tree.toData(), { name: "林夏的毕业选择", author: "Mirai" });

    expect(file.magic).toBe(WORLD_FILE_MAGIC);
    expect(file.version).toBe(1);
    expect(file.checksum).toMatch(/^[0-9a-f]{8}$/);
    expect(file.meta.name).toBe("林夏的毕业选择");
    expect(file.meta.author).toBe("Mirai");
  });

  it("序列化是确定性的：同一棵树导出两次字节一致", () => {
    const tree = sampleTree();
    const meta = { name: "世界", author: "Mirai", exportedAt: "2026-11-09T00:00:00.000Z" };
    const a = serializeWorldFile(exportWorldFile(tree.toData(), meta));
    const b = serializeWorldFile(exportWorldFile(tree.toData(), meta));
    expect(a).toBe(b);
  });

  it("往返无损：导出再导入，节点与状态哈希完全一致", () => {
    const tree = sampleTree();
    const file = exportWorldFile(tree.toData(), { name: "世界" });
    const result = roundTrip(file);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("往返无损");
  });

  it("导入后可以直接继续操作，状态哈希与原树一致", () => {
    const tree = sampleTree();
    const text = serializeWorldFile(exportWorldFile(tree.toData(), { name: "世界" }));
    const back = parseWorldFile(text);
    const restored = WorldTree.fromData(back.tree);

    for (const node of tree.nodes) {
      const counterpart = restored.node(node.id);
      expect(counterpart).toBeDefined();
      expect(counterpart?.stateHash).toBe(node.stateHash);
      expect(hashState(counterpart!.state)).toBe(node.stateHash);
    }
    // 还能继续长出新的世界线
    const next = restored.observe(restored.root.id, { uid: "m-new", key: "新记忆", value: 3 });
    expect(next.state.numeric["m-new"]).toBeDefined();
  });

  it("inspect 报告世界规模与一致性结论", () => {
    const tree = sampleTree();
    const file = exportWorldFile(tree.toData(), { name: "世界" });
    const report = inspectWorldFile(file);

    expect(report.fileOk).toBe(true);
    expect(report.checksumOk).toBe(true);
    expect(report.branches).toBe(1);
    expect(report.merges).toBe(1);
    expect(report.rollbacks).toBe(1);
    expect(report.leafCount).toBeGreaterThan(0);
    expect(report.message).toContain("世界完整");
  });

  it("篡改状态后 inspect 报错（逐节点摘要校验）", () => {
    const tree = sampleTree();
    const file = exportWorldFile(tree.toData(), { name: "世界" });
    const anyId = Object.keys(file.tree.nodes)[0];
    file.tree.nodes[anyId].state.tombstones["injected"] = "被篡改";

    const report = inspectWorldFile(file);
    // checksum 只覆盖结构，所以改状态不会让它失配；
    // 但逐节点的 stateHash 校验会抓住它。
    expect(report.fileOk).toBe(false);
    expect(report.issues.some((i) => i.message.includes("摘要不符"))).toBe(true);
  });

  it("解析篡改过的文件会抛 WorldFileError", () => {
    const tree = sampleTree();
    const text = serializeWorldFile(exportWorldFile(tree.toData(), { name: "世界" }));
    const tampered = text.replace(/"version": 1/, '"version": 1');
    // 直接改 checksum 让它失配
    const broken = tampered.replace(/"checksum": "[0-9a-f]{8}"/, '"checksum": "00000000"');
    expect(() => parseWorldFile(broken)).toThrow(WorldFileError);
  });

  it("拒绝非世界文件与不支持版本", () => {
    expect(() => parseWorldFile("{}")).toThrow(WorldFileError);
    expect(() => parseWorldFile("not json")).toThrow(WorldFileError);
    expect(() =>
      parseWorldFile(JSON.stringify({ magic: WORLD_FILE_MAGIC, version: 999, tree: { nodes: {} } })),
    ).toThrow(WorldFileError);
  });

  it("数据不一致的树拒绝导出，而不是导出坏文件", () => {
    const tree = sampleTree();
    const data = tree.toData();
    const anyId = Object.keys(data.nodes)[0];
    data.nodes[anyId].stateHash = "deadbeef";

    expect(() => exportWorldFile(data, { name: "坏世界" })).toThrow(WorldFileError);
  });
});
