import { useCallback, useMemo, useState } from "react";

/**
 * 把一段叙事切成 galgame 的「一屏一句」。
 *
 * 为什么不整段显示：
 *   1. 一屏塞 350 字，字号只能压到看不清（台词区曾被压成 16px 就是这么来的）
 *   2. 视觉小说是一句一句推的，读者有节奏
 *   3. 切句之后「点击继续」才有意义
 *
 * 切分规则：先按换行分段（换行是作者的分段，不抹掉），段内按句末标点断，
 * 但引号内的句号不断句。过长的句子硬断，否则一屏放不下。
 */

const SENTENCE_END = /[。！？…]/;
const ELLIPSIS = "...";

export function splitSentences(text: string, maxLen = 58): string[] {
  const cleaned = (text ?? "").replace(/\s*\n+\s*/g, "\n").trim();
  if (!cleaned) return [];

  const pieces: { text: string; para: number }[] = [];

  cleaned.split("\n").forEach((para, pi) => {
    const line = para.trim();
    if (!line) return;

    let buf = "";
    let quote = 0; // 引号深度：引号内的句号不断句
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "\u201c" || ch === "\u300c") quote += 1;
      else if (ch === "\u201d" || ch === "\u300d") quote = Math.max(0, quote - 1);

      buf += ch;
      const tail3 = line.slice(Math.max(0, i - 2), i + 1);
      const isEnd = (SENTENCE_END.test(ch) || tail3 === ELLIPSIS) && quote === 0;
      // 关闭引号本身也收尾：「…不去。”」应当在引号处结束这一句，
      // 否则它会被并进下一句，读起来是两句话挤在一屏。
      const closesQuote =
        (ch === "\u201d" || ch === "\u300d") &&
        quote === 0 &&
        SENTENCE_END.test(buf[buf.length - 2] ?? "");
      if (isEnd || closesQuote || buf.length >= maxLen) {
        if (buf.trim()) pieces.push({ text: buf.trim(), para: pi });
        buf = "";
      }
    }
    if (buf.trim()) pieces.push({ text: buf.trim(), para: pi });
  });

  // 只在同一段内、且片段短到会「闪」（<6 字）时并到前一句。跨段不合并。
  const merged: { text: string; para: number }[] = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    const tooShort = p.text.length < 6;
    const samePara = prev !== undefined && prev.para === p.para;
    const fits = prev !== undefined && prev.text.length + p.text.length <= maxLen;
    if (prev && samePara && tooShort && fits) {
      prev.text = prev.text + p.text;
    } else {
      merged.push({ text: p.text, para: p.para });
    }
  }

  return merged.map((m) => m.text);
}

/**
 * 逐句推进的状态。
 *
 * 切换节点时回到第一句。文本还在流式到达时，切句结果会跟着变，
 * 但下标会被夹在有效范围内，不会跳。
 */
export function useSentences(text: string, nodeId: string | undefined) {
  const [index, setIndex] = useState(0);
  const [lastNode, setLastNode] = useState(nodeId);
  const all = useMemo(() => splitSentences(text), [text]);

  // 换节点就回到第一句（渲染期修正，不用 effect，避免闪一帧）
  if (nodeId !== lastNode) {
    setLastNode(nodeId);
    setIndex(0);
  }

  const safeIndex = Math.min(index, Math.max(0, all.length - 1));
  const current = all[safeIndex] ?? "";
  const atEnd = all.length === 0 || safeIndex >= all.length - 1;

  const next = useCallback(() => {
    setIndex((i) => Math.min(i + 1, Math.max(0, all.length - 1)));
  }, [all.length]);

  const prev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const reset = useCallback(() => setIndex(0), []);

  return {
    sentences: all,
    index: safeIndex,
    total: all.length,
    current,
    atEnd,
    next,
    prev,
    reset,
  };
}
