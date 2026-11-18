import { useMemo } from "react";
import { ArrowLeft, GitMerge } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { balanceTone, readMood, slotMean } from "@/world/engine";
import { SceneCanvas } from "./scene-canvas";
import type { UseWorlds } from "./use-worlds";
import styles from "./compare.module.css";

/**
 * 对照视图：把几条未来并排放。
 *
 * 为什么值得有：切换视角时一次只能看一条，「并行」就只是个说法。
 * 并排放在一起，一眼能看出哪条线的她更紧绷、哪条线的画面更暗 ——
 * 这是状态存在树上才做得到的事。
 *
 * 只有当前观察的那条线跑动画，其余各画一帧 ——
 * 否则三块画布同时 60fps，手机扛不住也没必要。
 */
export function CompareView({ w, onBack }: { w: UseWorlds; onBack: () => void }) {
  const tree = w.tree;

  const cards = useMemo(() => {
    if (!tree) return [];
    return w.lanes.map((lane) => {
      const node = tree.node(lane.cursor);
      const steps = tree.pathTo(lane.cursor).length;
      const memories = node
        ? Object.values(node.state.numeric)
            .sort((a, b) => slotMean(b) - slotMean(a))
            .slice(0, 4)
        : [];
      return {
        lane,
        node,
        steps,
        memories,
        mood: node ? readMood(node.state) : null,
      };
    });
  }, [tree, w.lanes]);

  if (!tree || !cards.length) {
    return (
      <div className="page">
        <EmptyState
          title="还没有可对照的线"
          description="在世界里开一条新线，这里就能并排看。"
          action={<Button onClick={onBack}>回去</Button>}
        />
      </div>
    );
  }

  // 找出第一条线独有的记忆，用来指出"这里开始不一样了"
  const firstKeys = new Set(cards[0]?.memories.map((m) => m.key) ?? []);

  // 按状态读数排序：balance 高的是"更稳"的那条
  const ranked = cards
    .filter((c) => c.mood)
    .slice()
    .sort((a, b) => (b.mood?.balance ?? 0) - (a.mood?.balance ?? 0));
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  return (
    <div className={styles.compare}>
      <div className="row">
        <button className="icon-button" onClick={onBack} aria-label="回到世界">
          <ArrowLeft size={20} strokeWidth={1.75} aria-hidden />
        </button>
        <div className="topbar-title">
          <h1>并排看几条未来</h1>
          <p>
            {cards.length} 条线 <span aria-hidden>·</span> 同一段历史，从这里分头走
          </p>
        </div>
      </div>

      {best && (
        <p className={styles.verdict}>
          按状态读数，{best.lane.label} 这条线的她最稳
          {worst && best.lane.id !== worst.lane.id ? `，${worst.lane.label} 最紧` : ""}。
        </p>
      )}

      <div className={styles.grid}>
        {cards.map(({ lane, node, steps, memories, mood }) => {
          const meta = node?.meta ?? {};
          const isActive = lane.id === w.activeLaneId;
          const onlyHere = memories.filter((m) => !firstKeys.has(m.key));

          return (
            <button
              key={lane.id}
              className={styles.laneCard}
              data-active={isActive}
              data-compare-lane={lane.id}
              onClick={() => w.focusLane(lane.id)}
              aria-pressed={isActive}
            >
              <div className={styles.canvas}>
                <SceneCanvas
                  paused={!isActive}
                  frozen={!isActive}
                  params={{
                    place: meta.place ?? "",
                    time: meta.time ?? "",
                    mood: meta.mood ?? "",
                    weather: meta.weather ?? "",
                    hour: Number(meta.hour ?? "18") || 18,
                    memories: memories.map((m) => ({
                      key: m.key,
                      value: Math.round(slotMean(m)),
                    })),
                  }}
                />
              </div>

              <div className={styles.cardBody}>
                <div className={styles.cardHead}>
                  <span className={styles.cardName}>{lane.label}</span>
                  <span className={styles.cardMeta}>
                    {steps} 步
                    {meta.hour ? ` · ${String(meta.hour).padStart(2, "0")}:00` : ""}
                  </span>
                </div>

                <p className={styles.cardLine}>
                  {meta.narration?.slice(0, 90) || "还没有走过一步。"}
                </p>

                {mood && (
                  <span className={styles.mood} data-tone={balanceTone(mood.balance)}>
                    <span className={styles.moodNums}>
                      暖 {mood.warmth} · 紧 {mood.pressure}
                    </span>
                    {mood.line}
                  </span>
                )}

                {memories.length > 0 && (
                  <div className={styles.mems}>
                    {memories.map((m) => (
                      <span key={m.uid} className={styles.memRow}>
                        <span className={styles.memKey}>{m.key}</span>
                        <span className={styles.memBar}>
                          <span
                            className={styles.memFill}
                            style={{ width: `${Math.min(100, (slotMean(m) / 10) * 100)}%` }}
                          />
                        </span>
                        <span className={styles.memVal}>{slotMean(m).toFixed(0)}</span>
                      </span>
                    ))}
                  </div>
                )}

                {onlyHere.length > 0 && (
                  <span className={styles.diverged}>
                    只有这条线记得：{onlyHere.map((m) => m.key).join("、")}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onBack}>
          <GitMerge size={16} strokeWidth={1.75} aria-hidden />
          回到世界里合并
        </Button>
      </div>
    </div>
  );
}
