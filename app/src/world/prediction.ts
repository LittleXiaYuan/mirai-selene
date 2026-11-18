/**
 * 预测卡：把一个世界走得出来的东西，写成一份能被引用的文档。
 *
 * 为什么需要它：用户说的那句话是产品定位 —— 「有人做世界模型，
 * 但没有人用世界模型去做预测」。走进去是体验，**出来必须有一份能带走的判断**。
 *
 * 这份卡里没有一句是语言模型写的，全部由状态算出：
 * 每一步的账（diffState）、当前读数（readMood）、分支与合并的计数。
 * 所以同一份世界文件，任何时候生成，除时间戳外逐字相同。
 */

import { balanceWord, diffState, readDelta, readMood } from "./engine";
import type { WorldNode, WorldState } from "./engine";

export interface PredictionInput {
  worldName: string;
  /** 主角名，用来写句子。 */
  who: string;
  /** 从根到当前节点的节点序列。 */
  path: WorldNode[];
  state: WorldState;
  /** 分支 / 合并 / 整理掉的计数，由调用方从树上数出来。 */
  branches: number;
  merges: number;
  tombstones: number;
  license: { label: string; terms: string };
  /** 生成时间（ISO）。传进来而不是现取，测试才能断言逐字相同。 */
  at: string;
}

function stepLine(prev: WorldNode, next: WorldNode): string {
  const ledger = readDelta(diffState(prev.state, next.state));
  return `- ${next.label}：${ledger || "这一步没改动她的状态。"}`;
}

export function buildPredictionCard(input: PredictionInput): string {
  const { worldName, who, path, state, license } = input;
  const mood = readMood(state);
  const steps = path.filter((n) => n.kind !== "root");
  const lines: string[] = [];

  lines.push(`# ${worldName} · 预测卡`, "");
  lines.push(`生成于 ${input.at} · Mirai-Selene`, "");
  lines.push("## 走过");
  if (steps.length === 0) {
    lines.push("还没有走过任何一步。");
  } else {
    steps.forEach((n, i) => lines.push(`${i + 1}. ${n.label}`));
  }
  lines.push("");

  lines.push("## 现在的读数");
  if (!mood.dominant) {
    lines.push("她还没有留下记忆，读数是零。");
  } else {
    lines.push(`暖 ${mood.warmth} · 紧 ${mood.pressure} · ${balanceWord(mood.balance)}`, "");
    lines.push(
      `${balanceWord(mood.balance)}：撑住她的 ${mood.warmth}，压着她的 ${mood.pressure}，` +
        `差 ${mood.balance > 0 ? "+" : ""}${mood.balance}。`,
    );
    lines.push(`最重的是「${mood.dominant.key}」，强度 ${mood.dominant.value}。`);
  }
  lines.push("");

  lines.push("## 每一步的账");
  if (path.length < 2) {
    lines.push("只有一个起点，还没有可记的账。");
  } else {
    for (let i = 1; i < path.length; i += 1) lines.push(stepLine(path[i - 1], path[i]));
  }
  lines.push("");

  lines.push("## 这条线的形状");
  lines.push(
    `${steps.length} 步，${path.length} 个节点；` +
      `${input.branches} 条岔路，${input.merges} 次接上，` +
      `${input.tombstones} 件事被整理掉（合并时不会复活）。`,
  );
  lines.push("");

  lines.push("## 边界");
  lines.push("- 读数是从状态算出来的，不是概率预测。它回答「她现在偏在哪边」，不回答「她以后会不会成功」。");
  lines.push("- 能复现的前提是同一份世界文件：同一状态永远同一读数。");
  lines.push(`- 授权：${license.label}。${license.terms}`);
  lines.push("");

  return lines.join("\n");
}
