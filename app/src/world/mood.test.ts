import { describe, expect, it } from "vitest";
import { applyObservation, emptyState, readMood } from "./engine";

function stateOf(pairs: [string, string, number][]) {
  let s = emptyState();
  for (const [uid, key, value] of pairs) {
    s = applyObservation(s, { uid, key, value });
  }
  return s;
}

describe("状态读数", () => {
  it("负性记忆累加到 pressure", () => {
    const s = stateOf([
      ["m1", "焦虑", 8],
      ["m2", "房租压力", 6],
    ]);
    const m = readMood(s);
    expect(m.pressure).toBe(14);
    expect(m.warmth).toBe(0);
    expect(m.balance).toBe(-14);
    expect(m.line).toContain("绷得比一开始紧");
  });

  it("正性记忆累加到 warmth", () => {
    const s = stateOf([
      ["m1", "安心", 7],
      ["m2", "被理解", 5],
    ]);
    const m = readMood(s);
    expect(m.warmth).toBe(12);
    expect(m.balance).toBe(12);
    expect(m.line).toContain("稳");
  });

  it("两边都有时按差值判断", () => {
    const s = stateOf([
      ["m1", "焦虑", 5],
      ["m2", "安心", 7],
    ]);
    const m = readMood(s);
    expect(m.balance).toBe(2);
    expect(m.line).toContain("摇摆");
  });

  it("报出最强的一条记忆", () => {
    const s = stateOf([
      ["m1", "焦虑", 4],
      ["m2", "房租压力", 9],
    ]);
    expect(readMood(s).dominant).toEqual({ key: "房租压力", value: 9 });
  });

  it("空状态有兜底文案", () => {
    const m = readMood(emptyState());
    expect(m.dominant).toBeNull();
    expect(m.balance).toBe(0);
    expect(m.line).toContain("干净");
  });

  it("同一状态永远同一个读数", () => {
    const s = stateOf([
      ["m1", "焦虑", 6],
      ["m2", "安心", 3],
    ]);
    expect(readMood(s).balance).toBe(readMood(s).balance);
  });
});
