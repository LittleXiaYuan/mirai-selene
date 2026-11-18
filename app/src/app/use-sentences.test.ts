import { describe, expect, it } from "vitest";
import { splitSentences } from "./use-sentences";

describe("叙事切句", () => {
  it("按句号断，每句独立成一屏", () => {
    const s = splitSentences("她把信放在桌上。窗外开始下雨。她想起母亲说过的话。");
    expect(s).toEqual(["她把信放在桌上。", "窗外开始下雨。", "她想起母亲说过的话。"]);
  });

  it("问号和感叹号也算句末", () => {
    const s = splitSentences("你真的要走吗？她点了点头！然后再没说话。");
    expect(s.length).toBe(3);
    expect(s[0]).toBe("你真的要走吗？");
    expect(s[1]).toBe("她点了点头！");
  });

  it("不切断引号里的内容", () => {
    const s = splitSentences("她说：“我不去。真的不去。”然后转过身。");
    // 引号内的句号不断句；引号关闭时这一句结束，后面的另起一屏
    expect(s).toEqual(["她说：“我不去。真的不去。”", "然后转过身。"]);
  });

  it("引号结束后可以正常断句", () => {
    const s = splitSentences("她说：“我不去。”窗外的雨还在下。");
    expect(s).toEqual(["她说：“我不去。”", "窗外的雨还在下。"]);
  });

  it("过长的句子会硬断，避免一屏放不下", () => {
    const long = "她" + "很".repeat(160) + "。";
    const s = splitSentences(long, 58);
    expect(s.length).toBeGreaterThan(1);
    for (const part of s) {
      expect(part.length).toBeLessThanOrEqual(58);
    }
  });

  it("太短的片段并到上一句，不单独占一屏", () => {
    const s = splitSentences("她停了一下。又走了。她终于推开门，外面的风灌了进来。");
    // "又走了。" 只有 4 个字，应并入前一句
    expect(s.some((x) => x === "又走了。")).toBe(false);
  });

  it("换行分段", () => {
    const s = splitSentences("第一段。\n第二段。");
    expect(s).toEqual(["第一段。", "第二段。"]);
  });

  it("空文本返回空数组", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n  ")).toEqual([]);
  });

  it("省略号算句末", () => {
    const s = splitSentences("她没有回答…只是看着窗外。");
    expect(s.length).toBe(2);
  });
});
