import { describe, expect, it } from "vitest";
import { applyObservation, emptyState, hashState } from "./engine";
import type { WorldNode } from "./engine";
import { buildPredictionCard } from "./prediction";
import { LICENSE_PRESETS } from "./worldfile";

function chain(labels: string[], memories: [string, string, number][][]): WorldNode[] {
  let state = emptyState();
  let parent: string | null = null;
  const out: WorldNode[] = [];

  labels.forEach((label, i) => {
    for (const [uid, key, value] of memories[i] ?? []) {
      state = applyObservation(state, { uid, key, value });
    }
    const node: WorldNode = {
      id: `n${i}`,
      parentId: parent,
      label,
      kind: i === 0 ? "root" : "observe",
      state,
      stateHash: hashState(state),
      createdAt: "2026-11-15T22:00:00+08:00",
      seq: i,
      mergedFrom: [],
    };
    out.push(node);
    parent = node.id;
  });

  return out;
}

const base = {
  worldName: "林夏的毕业选择",
  who: "林夏",
  branches: 3,
  merges: 1,
  tombstones: 1,
  license: LICENSE_PRESETS.attribution,
  at: "2026-11-15T22:00:00+08:00",
};

describe("预测卡", () => {
  const path = chain(
    ["起点", "认识林夏", "去上海"],
    [
      [],
      [["m1", "安心", 6]],
      [["m2", "房租压力", 8]],
    ],
  );

  it("列出走过的每一步", () => {
    const card = buildPredictionCard({ ...base, path, state: path[2].state });
    expect(card).toContain("1. 认识林夏");
    expect(card).toContain("2. 去上海");
    expect(card).not.toContain("起点\n1.");
  });

  it("读数与账都写进卡里", () => {
    const card = buildPredictionCard({ ...base, path, state: path[2].state });
    expect(card).toContain("暖 6 · 紧 8 · 摇摆");
    expect(card).toContain("第一次留下「安心」");
    expect(card).toContain("第一次留下「房租压力」");
    expect(card).toContain("强度 8");
  });

  it("形状计数来自调用方数出来的树", () => {
    const card = buildPredictionCard({ ...base, path, state: path[2].state });
    expect(card).toContain("3 条岔路，1 次接上，1 件事被整理掉");
  });

  it("把边界和授权写在最后，不藏起来", () => {
    const card = buildPredictionCard({ ...base, path, state: path[2].state });
    expect(card).toContain("不是概率预测");
    expect(card).toContain("署名后可商用");
  });

  it("同一份世界同一时间戳，逐字相同", () => {
    const a = buildPredictionCard({ ...base, path, state: path[2].state });
    const b = buildPredictionCard({ ...base, path, state: path[2].state });
    expect(a).toBe(b);
  });

  it("没走过时也不崩，直接说明", () => {
    const empty = chain(["起点"], [[]]);
    const card = buildPredictionCard({ ...base, path: empty, state: empty[0].state });
    expect(card).toContain("还没有走过任何一步");
    expect(card).toContain("只有一个起点");
  });
});
