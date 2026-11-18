import { describe, expect, it } from "vitest";
import { WorldTree } from "./engine";
import { SPEC_SAMPLES } from "./spec-samples";
import { buildWorldFromSpec, specNodeOf, validateWorldSpec } from "./spec";

describe("World-Spec v1.0", () => {
  it("三份内置世界都能通过校验", () => {
    for (const spec of SPEC_SAMPLES) {
      const result = validateWorldSpec(spec);
      expect(result.ok, result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("\n")).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  it("拒绝对不上的选项目标", () => {
    const broken = {
      ...SPEC_SAMPLES[0],
      logic_nodes: [
        { ...SPEC_SAMPLES[0].logic_nodes[0], choices: [{ label: "走一条不存在的路", to: "ghost" }] },
      ],
    };
    const result = validateWorldSpec(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.some((issue) => issue.message.includes("ghost"))).toBe(true);
  });

  it("每个逻辑节点都折进树里，入口游标指向入口幕", () => {
    for (const spec of SPEC_SAMPLES) {
      const built = buildWorldFromSpec(spec);
      const tree = WorldTree.fromData(built.tree);
      const scenes = tree.nodes.filter((node) => node.meta?.specNode);
      expect(scenes).toHaveLength(spec.logic_nodes.length);
      expect(scenes.map((node) => node.meta?.specNode).sort()).toEqual(
        spec.logic_nodes.map((node) => node.id).sort(),
      );

      const entry = tree.node(built.cursor);
      expect(entry?.meta?.specNode).toBe(spec.entry);
      expect(tree.pathTo(built.cursor).length).toBeGreaterThan(1);
      expect(specNodeOf(spec, entry?.meta?.specNode)?.text).toBe(
        spec.logic_nodes.find((node) => node.id === spec.entry)?.text,
      );
    }
  });

  it("选项目标在树里都能找到", () => {
    for (const spec of SPEC_SAMPLES) {
      const built = buildWorldFromSpec(spec);
      const tree = WorldTree.fromData(built.tree);
      const bySpec = new Map(
        tree.nodes
          .filter((node) => node.meta?.specNode)
          .map((node) => [node.meta?.specNode ?? "", node.id]),
      );
      for (const node of spec.logic_nodes) {
        for (const choice of node.choices ?? []) {
          expect(bySpec.has(choice.to), `${node.id} → ${choice.to}`).toBe(true);
        }
      }
    }
  });
});
