import { describe, expect, it } from "vitest";
import { applyObservation, diffState, emptyState, readDelta } from "./engine";
import type { WorldState } from "./engine";

function stateOf(pairs: [string, string, number][]): WorldState {
  let s = emptyState();
  for (const [uid, key, value] of pairs) {
    s = applyObservation(s, { uid, key, value });
  }
  return s;
}

describe("这一步的账", () => {
  it("新留下的记忆记为第一次", () => {
    const before = emptyState();
    const after = stateOf([["m1", "房租", 6]]);
    const d = diffState(before, after);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ key: "房租", before: 0, after: 6, delta: 6, count: 1 });
    expect(readDelta(d)).toContain("第一次留下「房租」");
  });

  it("同一条记忆再推一次，读数往上走", () => {
    const before = stateOf([["m1", "焦虑", 4]]);
    const after = stateOf([
      ["m1", "焦虑", 4],
      ["m1", "焦虑", 8],
    ]);
    const d = diffState(before, after);
    expect(d[0]).toMatchObject({ key: "焦虑", before: 4, after: 6, delta: 2, count: 2 });
    expect(readDelta(d)).toBe("「焦虑」从 4 推到 6。");
  });

  it("这一步没碰过的记忆不出现在账上", () => {
    const before = stateOf([
      ["m1", "焦虑", 4],
      ["m2", "安心", 7],
    ]);
    const after = stateOf([
      ["m1", "焦虑", 4],
      ["m2", "安心", 7],
      ["m1", "焦虑", 8],
    ]);
    const d = diffState(before, after);
    expect(d.map((x) => x.key)).toEqual(["焦虑"]);
  });

  it("被整理掉的记忆记为负，不会被忽略", () => {
    const before = stateOf([["m1", "房租", 6]]);
    const after = emptyState();
    const d = diffState(before, after);
    expect(d[0]).toMatchObject({ key: "房租", before: 6, after: 0, delta: -6, count: 0 });
    expect(readDelta(d)).toContain("被整理掉了");
  });

  it("按变化大小排序，最重的排第一", () => {
    const before = emptyState();
    const after = stateOf([
      ["m1", "小波动", 2],
      ["m2", "房租压力", 9],
    ]);
    expect(diffState(before, after)[0].key).toBe("房租压力");
  });

  it("没有变化时给空串，界面据此不显示", () => {
    const s = stateOf([["m1", "焦虑", 5]]);
    expect(diffState(s, s)).toEqual([]);
    expect(readDelta([])).toBe("");
  });

  it("同一对状态永远算出同一个账", () => {
    const before = stateOf([["m1", "焦虑", 3]]);
    const after = stateOf([
      ["m1", "焦虑", 3],
      ["m1", "焦虑", 9],
    ]);
    expect(diffState(before, after)).toEqual(diffState(before, after));
  });
});
