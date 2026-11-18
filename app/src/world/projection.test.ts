import { describe, expect, it } from "vitest";
import {
  applyObservation,
  emptyState,
  projectChoices,
  projectObservation,
  timeOfDay,
  uidForKey,
} from "./engine";

describe("反事实预测", () => {
  it("新记忆：从 0 到观测值", () => {
    const p = projectObservation(emptyState(), { uid: "m1", key: "焦虑", value: 7 });
    expect(p.now).toBe(0);
    expect(p.after).toBe(7);
    expect(p.isNew).toBe(true);
    expect(p.direction).toBe("up");
  });

  it("已有记忆：给出合并后的精确读数", () => {
    let s = emptyState();
    s = applyObservation(s, { uid: "m1", key: "焦虑", value: 6 });
    s = applyObservation(s, { uid: "m1", key: "焦虑", value: 4 });
    // 当前均值 5（2 次观测）
    const p = projectObservation(s, { uid: "m1", key: "焦虑", value: 8 });
    // 加一次 8 → (6+4+8)/3 = 6
    expect(p.now).toBe(5);
    expect(p.after).toBe(6);
    expect(p.count).toBe(2);
    expect(p.direction).toBe("up");
  });

  it("低于当前均值的观测会把读数拉低", () => {
    let s = emptyState();
    s = applyObservation(s, { uid: "m1", key: "焦虑", value: 9 });
    s = applyObservation(s, { uid: "m1", key: "焦虑", value: 9 });
    const p = projectObservation(s, { uid: "m1", key: "焦虑", value: 2 });
    // (9+9+2)/3 ≈ 6.7
    expect(p.after).toBeCloseTo(6.7, 1);
    expect(p.direction).toBe("down");
  });

  it("等于当前均值时方向为 flat", () => {
    let s = emptyState();
    s = applyObservation(s, { uid: "m1", key: "焦虑", value: 5 });
    const p = projectObservation(s, { uid: "m1", key: "焦虑", value: 5 });
    expect(p.direction).toBe("flat");
  });

  it("不改原状态：预测是只读的", () => {
    const s = applyObservation(emptyState(), { uid: "m1", key: "焦虑", value: 6 });
    const before = JSON.stringify(s);
    projectObservation(s, { uid: "m1", key: "焦虑", value: 10 });
    expect(JSON.stringify(s)).toBe(before);
  });

  it("一次算多个候选，各自独立", () => {
    const s = applyObservation(emptyState(), { uid: "m1", key: "焦虑", value: 4 });
    const out = projectChoices(s, [
      { id: "a", uid: "m1", key: "焦虑", value: 8 },
      { id: "b", uid: "m2", key: "安心", value: 6 },
    ]);
    expect(out.a.after).toBe(6); // (4+8)/2
    expect(out.b.after).toBe(6); // 新记忆
    expect(out.b.isNew).toBe(true);
  });

  it("预测与真正执行的结果一致 —— 这是它可信的依据", () => {
    let s = emptyState();
    s = applyObservation(s, { uid: "m1", key: "焦虑", value: 6 });
    const p = projectObservation(s, { uid: "m1", key: "焦虑", value: 9 });
    const actual = applyObservation(s, { uid: "m1", key: "焦虑", value: 9 });
    const actualMean = actual.numeric.m1.valueSum / actual.numeric.m1.count;
    expect(p.after).toBe(Math.round(actualMean * 10) / 10);
  });

  it("按 key 找到已有记忆的 uid", () => {
    const s = applyObservation(emptyState(), { uid: "x1", key: "焦虑", value: 4 });
    expect(uidForKey(s, "焦虑")).toBe("x1");
    expect(uidForKey(s, "还没出现")).toBe("m-还没出现");
  });

  it("钟点决定时段，用于画面", () => {
    expect(timeOfDay(6)).toBe("清晨");
    expect(timeOfDay(12)).toBe("正午");
    expect(timeOfDay(18)).toBe("黄昏");
    expect(timeOfDay(2)).toBe("深夜");
  });
});
