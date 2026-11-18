import { useCallback, useState } from "react";
import { Button } from "@/components/arc/button/button";
import { Alert } from "@/components/arc/alert/alert";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { slotMean } from "@/world/engine";
import type { UseWorlds } from "./use-worlds";
import styles from "./judge.module.css";

export interface Verdict {
  likely: string;
  assumptions: string[];
  sensitivity: { change: string; effect: string }[];
  risks: string[];
  advice: string;
  offline?: boolean;
}

/**
 * 「把这段经历读成话」。
 *
 * 边界要说清楚：这里的文字是语言模型写的，只负责措辞。
 * 真正算出来的结论在它上面 —— 状态读数、这一步的账，
 * 那些每一步都能被同一份状态复现，这些不能。
 */
export function JudgeBlock({ w }: { w: UseWorlds }) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const node = w.cursor?.node;
  const tree = w.tree;
  const path = w.cursor?.path ?? [];

  const run = useCallback(async () => {
    if (!w.active || !node) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/mirai-api/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          world: {
            name: w.active.name,
            hook: w.active.hook,
            characters: w.active.characters,
          },
          path: path.map((n) => ({ label: n.label, narration: n.meta?.narration ?? "" })),
          memories: Object.values(node.state.numeric)
            .sort((a, b) => slotMean(b) - slotMean(a))
            .slice(0, 10)
            .map((m) => ({ key: m.key, value: Math.round(slotMean(m)) })),
          lanes: w.lanes.map((l) => ({ label: l.label })),
        }),
      });
      const data = (await res.json()) as { verdict?: Verdict; reason?: string };
      if (data.verdict?.likely) {
        setVerdict(data.verdict);
      } else {
        setError(data.reason ? `没能给出判断：${data.reason}` : "没能给出判断");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "连不上判断层");
    } finally {
      setBusy(false);
    }
  }, [w, node, path]);

  const steps = path.filter((n) => n.kind !== "root").length;

  return (
    <div className={styles.judge}>
      {!verdict && !busy && (
        <>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: 1.7 }}>
            你已经替她走了 {steps} 步。把这段经历读成几句话 ——
            由语言模型写，只负责措辞；可比较的读数在上面。
          </p>
          <Button onClick={() => void run()} disabled={steps === 0}>
            {steps === 0 ? "先走一步再来" : "读成话"}
          </Button>
          {error && <Alert tone="danger" title={error} />}
        </>
      )}

      {busy && (
        <div className={styles.loading}>
          <Skeleton lines={3} label="正在把这段经历读成话" />
        </div>
      )}

      {verdict && (
        <>
          <p className={styles.likely}>{verdict.likely}</p>

          {verdict.assumptions.length > 0 && (
            <div className={styles.block}>
              <span className={styles.blockTitle}>这个判断依赖</span>
              <ul className={styles.items}>
                {verdict.assumptions.map((a) => (
                  <li key={a} className={styles.item}>
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {verdict.sensitivity.length > 0 && (
            <div className={styles.block}>
              <span className={styles.blockTitle}>改变什么会不同</span>
              {verdict.sensitivity.map((s) => (
                <div key={s.change} className={styles.sens}>
                  <span className={styles.sensChange}>{s.change}</span>
                  <span className={styles.sensEffect}>{s.effect}</span>
                </div>
              ))}
            </div>
          )}

          {verdict.risks.length > 0 && (
            <div className={styles.block}>
              <span className={styles.blockTitle}>该注意</span>
              <ul className={styles.items}>
                {verdict.risks.map((r) => (
                  <li key={r} className={styles.item}>
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {verdict.advice && <div className={styles.advice}>{verdict.advice}</div>}

          <Button variant="ghost" onClick={() => void run()}>
            重新读一遍
          </Button>
        </>
      )}
    </div>
  );
}
