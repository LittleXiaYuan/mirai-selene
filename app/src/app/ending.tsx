import { useMemo } from "react";
import { Download, FileDown, RotateCcw } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Alert } from "@/components/arc/alert/alert";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import { balanceWord, readMood, slotMean } from "@/world/engine";
import { buildPredictionCard } from "@/world/prediction";
import { LICENSE_PRESETS } from "@/world/worldfile";
import type { UseWorlds } from "./use-worlds";
import { JudgeBlock } from "./judge-block";
import styles from "./ending.module.css";

/**
 * 结束页：玩家不再操作，系统把这段旅程归纳成几句话。
 *
 * 归纳是本地算的，不依赖 LLM —— 结束时不该出现"正在生成"的等待，
 * 也不该因为网络断了就看不到结局。
 */
export function Ending({ w, onBack }: { w: UseWorlds; onBack: () => void }) {
  const node = w.cursor?.node;
  const tree = w.tree;

  const summary = useMemo(() => {
    if (!node || !tree || !w.active) return null;
    const path = w.cursor?.path ?? [];
    const steps = path.filter((n) => n.kind !== "root");
    const memories = Object.values(node.state.numeric).sort(
      (a, b) => slotMean(b) - slotMean(a),
    );
    const branches = tree.nodes.filter((n) => n.kind === "branch").length;
    const merges = tree.nodes.filter((n) => n.kind === "merge").length;
    const tombstones = Object.keys(node.state.tombstones).length;

    const who = w.active.characters[0]?.name ?? "她";
    const top = memories[0];
    const lines: string[] = [];

    if (steps.length === 0) {
      lines.push(`你还没替${who}做过选择。世界停在这里，等下一步。`);
    } else {
      lines.push(
        `你替${who}做了 ${steps.length} 个选择，走过 ${path.length} 步。`,
      );
      if (top) {
        lines.push(
          `她最在意的还是「${top.key}」，这件事被记了 ${top.count} 次，强度 ${slotMean(top).toFixed(0)}。`,
        );
      }
      if (branches > 1) {
        lines.push(`世界里长出了 ${branches} 条岔路。`);
      }
      if (merges > 0) {
        lines.push(`有 ${merges} 次，两条路重新接上。`);
      }
      if (tombstones > 0) {
        lines.push(`另外有 ${tombstones} 件事被整理掉了，它们不会在合并时复活。`);
      }
    }

    return {
      lines,
      memories: memories.slice(0, 6),
      trail: path.slice(-8),
      steps: steps.length,
      branches,
      merges,
      tombstones,
    };
  }, [node, tree, w.active, w.cursor]);

  /** 结局上的结论只用算出来的读数。这段话不经过模型，断网也在。 */
  const mood = useMemo(() => (node ? readMood(node.state) : null), [node]);

  /**
   * 导出预测卡。
   *
   * 走进去是体验，这张卡才是能被引用的产物：走过的路、每一步的账、
   * 现在的读数、这条线的形状、边界与授权。除了时间戳，逐字可复现。
   */
  const exportCard = () => {
    if (!node || !tree || !w.active || !summary) return;
    const card = buildPredictionCard({
      worldName: w.active.name,
      who: w.active.characters[0]?.name ?? "她",
      path: w.cursor?.path ?? [],
      state: node.state,
      branches: summary.branches,
      merges: summary.merges,
      tombstones: summary.tombstones,
      license: LICENSE_PRESETS.attribution,
      at: new Date().toLocaleString("zh-CN", { hour12: false }),
    });
    const blob = new Blob([card], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${w.active.name}-预测卡.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!node || !summary) {
    return (
      <div className={styles.wrap}>
        <p className={styles.text}>这个世界还没有内容。</p>
        <Button onClick={onBack}>回去</Button>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.eyebrowless}>
        {summary.steps === 0 ? "还没有走到岔路" : "这段旅程到这里"}
      </h1>

      {summary.lines.map((line) => (
        <p key={line} className={styles.text}>
          {line}
        </p>
      ))}

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{summary.steps}</span>
          <span className={styles.statLabel}>个选择</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{summary.branches}</span>
          <span className={styles.statLabel}>条岔路</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{summary.merges}</span>
          <span className={styles.statLabel}>次接上</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{summary.memories.length}</span>
          <span className={styles.statLabel}>件在意的事</span>
        </div>
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitle}>算出来的结论</div>
        {mood && (
          <p className={styles.moodLine}>
            <span className={styles.moodNums}>
              暖 {mood.warmth} · 紧 {mood.pressure} · {balanceWord(mood.balance)}
            </span>
            {mood.line}
          </p>
        )}
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitle}>把这段经历读成话</div>
        <JudgeBlock w={w} />
      </div>

      {summary.memories.length > 0 && (
        <div className={styles.block}>
          <div className={styles.blockTitle}>她记得什么</div>
          {summary.memories.map((m) => (
            <div key={m.uid} className={styles.memRow}>
              <span className={styles.memKey}>{m.key}</span>
              <span className={styles.memBar}>
                <span
                  className={styles.memFill}
                  style={{ width: `${Math.min(100, (slotMean(m) / 10) * 100)}%` }}
                />
              </span>
              <span className={styles.memValue}>{slotMean(m).toFixed(0)}</span>
            </div>
          ))}
        </div>
      )}

      {summary.trail.length > 0 && (
        <div className={styles.block}>
          <div className={styles.blockTitle}>走过的路</div>
          <div className={styles.trail}>
            {summary.trail.map((n) => (
              <span key={n.id} className={styles.trailItem}>
                {n.label}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className={styles.block}>
        <Alert tone="info" title="整理是本地算的">
          这页不调用模型，断网也能看到结局。世界的数据一直都在你自己的浏览器和导出的文件里。
        </Alert>
      </div>

      <div className={styles.actions}>
        <Button
          onClick={() => {
            w.consolidate();
            onBack();
          }}
        >
          整理并封存
        </Button>
        <Button variant="secondary" onClick={w.exportFile}>
          <Download size={16} strokeWidth={1.75} aria-hidden />
          把这个带走
        </Button>
        <Button variant="secondary" onClick={exportCard}>
          <FileDown size={16} strokeWidth={1.75} aria-hidden />
          导出预测卡
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            if (!tree) return;
            w.goBackTo(tree.root.id);
            onBack();
          }}
        >
          <RotateCcw size={16} strokeWidth={1.75} aria-hidden />
          从起点再走一次
        </Button>
        <Button variant="ghost" onClick={onBack}>
          回去接着走
        </Button>
      </div>
    </div>
  );
}

/** 动画参数从 Arc 取，别自己调时长。 */
export const ENDING_MOTION = motionTokens.spring.smooth;
