import { useCallback, useRef, useState } from "react";
import { GitMerge, Plus, Sparkles, Square } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Input } from "@/components/arc/input/input";
import { Select } from "@/components/arc/select/select";
import { previewMerge, type MergePreview } from "@/world/engine";
import type { UseWorlds } from "./use-worlds";
import lanes from "./lanes.module.css";

/** 把合并预演摊成人能读的三行。 */
function MergeReport({ preview }: { preview: MergePreview }) {
  const added = preview.slots.filter((s) => s.out && s.kind !== "forgotten");
  const forgotten = preview.slots.filter((s) => s.kind === "forgotten");

  return (
    <div className={lanes.preview}>
      <Alert
        tone={preview.ok ? "success" : "danger"}
        title={preview.summary}
      >
        共同起点是「{preview.baseLabel}」。
        {preview.ok ? "接上之后两边的内容都保留。" : "需要先决定冲突的那几项听谁的。"}
      </Alert>

      {added.map((s) => (
        <div key={s.uid} className={lanes.previewItem}>
          <span className={lanes.previewKey}>{s.key}</span>
          <span className={lanes.previewCalc}>
            {s.kind === "add"
              ? `${s.meanA?.toFixed(1)} 与 ${s.meanB?.toFixed(1)} → ${s.meanOut?.toFixed(1)}（${s.a?.count ?? 0} + ${s.b?.count ?? 0} 次观测）`
              : s.kind === "new-a"
                ? `只有左边写过 → ${s.meanOut?.toFixed(1)}`
                : `只有右边写过 → ${s.meanOut?.toFixed(1)}`}
          </span>
          <span className={lanes.previewBadge}>
            {s.kind === "add" ? "相加" : "新增"}
          </span>
        </div>
      ))}

      {forgotten.map((s) => (
        <div key={s.uid} className={lanes.previewItem}>
          <span className={lanes.previewKey}>{s.key}</span>
          <span className={lanes.previewCalc}>已被一方收起，合并后不会复活</span>
          <span className={lanes.previewBadge}>收起</span>
        </div>
      ))}

      {preview.conflicts.map((c) => (
        <div key={c.key} className={lanes.previewItem}>
          <span className={lanes.previewKey}>{c.key}</span>
          <span className={lanes.previewCalc}>{c.message}</span>
          <span className={lanes.previewBadge} style={{ color: "var(--danger)" }}>
            拒绝
          </span>
        </div>
      ))}

      {!added.length && !forgotten.length && !preview.conflicts.length && (
        <EmptyState title="没有需要合并的内容" description="两条线没有互相覆盖的东西。" />
      )}
    </div>
  );
}

export function LanesPanel({
  w,
  onAutoRun,
  autoRunning,
  autoDone,
  autoTarget,
}: {
  w: UseWorlds;
  onAutoRun: (steps: number) => void;
  autoRunning: boolean;
  autoDone: number;
  autoTarget: number;
}) {
  const [newLane, setNewLane] = useState("");
  const [mergeId, setMergeId] = useState("");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const node = w.cursor?.node;
  const tree = w.tree;
  const busy = useRef(false);

  const candidates = (tree && node ? tree.nodes : [])
    .filter((n) => n.id !== node?.id)
    .map((n) => ({ value: n.id, label: `${n.label}（${n.kind}）` }));

  const runPreview = useCallback(() => {
    if (!tree || !node || !mergeId || busy.current) return;
    busy.current = true;
    try {
      setPreview(previewMerge(tree.toData(), node.id, mergeId));
    } finally {
      busy.current = false;
    }
  }, [tree, node, mergeId]);

  const activeLaneList = w.lanes;

  return (
    <>
      <div className={lanes.lanes}>
        <span className="muted">同时看几条线</span>
        <Input
          label="新线名字"
          value={newLane}
          onChange={(e) => setNewLane(e.target.value)}
          placeholder="留空就自动命名"
          className="field-16"
        />
        <div className={lanes.laneList}>
          {activeLaneList.map((lane) => {
            const laneNode = tree?.node(lane.cursor);
            const steps = tree ? tree.pathTo(lane.cursor).length : 0;
            return (
              <button
                key={lane.id}
                className={lanes.lane}
                data-active={lane.id === w.activeLaneId}
                data-lane={lane.id}
                onClick={() => w.focusLane(lane.id)}
                aria-pressed={lane.id === w.activeLaneId}
              >
                {lane.label}
                <span className={lanes.laneCount}>
                  {steps} 步
                  {laneNode?.meta?.place ? ` · ${laneNode.meta.place}` : ""}
                </span>
              </button>
            );
          })}
          <button
            className={lanes.laneAdd}
            onClick={() => {
              const label = newLane.trim() || `线 ${activeLaneList.length + 1}`;
              w.addLane(label);
              setNewLane("");
            }}
            aria-label="从这一步开一条新线"
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

      </div>

      <div className={lanes.lanes}>
        <span className="muted">让世界自己走几幕</span>
        <div className={lanes.autoRow}>
          <button
            className={lanes.autoBtn}
            onClick={() => onAutoRun(3)}
            disabled={autoRunning}
            aria-label="自动推演三幕"
          >
            {autoRunning ? <Square size={14} strokeWidth={1.75} aria-hidden /> : <Sparkles size={14} strokeWidth={1.75} aria-hidden />}
            {autoRunning ? "停下" : "走三幕"}
          </button>
          <button
            className={lanes.autoBtn}
            onClick={() => onAutoRun(6)}
            disabled={autoRunning}
            aria-label="自动推演六幕"
          >
            走六幕
          </button>
          {autoTarget > 0 && (
            <span className={lanes.autoProgress}>
              {autoDone} / {autoTarget}
            </span>
          )}
        </div>
        <span className="muted">
          世界自己选下一步，每一幕照样落成可回放的节点。
        </span>
      </div>

      <div className={lanes.lanes}>
        <span className="muted">接上另一条线</span>
        <Select
          label="要接的线"
          placeholder="选一条线"
          value={mergeId}
          onValueChange={setMergeId}
          options={[{ value: "", label: "选一条线" }, ...candidates]}
        />
        <div className={lanes.autoRow}>
          <button
            className={lanes.autoBtn}
            onClick={runPreview}
            disabled={!mergeId}
            aria-label="预演合并结果"
          >
            <GitMerge size={14} strokeWidth={1.75} aria-hidden />
            先看会发生什么
          </button>
          {preview && (
            <button
              className={lanes.autoBtn}
              onClick={() => w.mergeInto(mergeId)}
              disabled={!preview.ok}
              aria-label="确认合并"
            >
              确认接上
            </button>
          )}
        </div>
        {preview && <MergeReport preview={preview} />}
      </div>

      {w.lanes.length > 1 && (
        <div className={lanes.lanes}>
          <Button
            variant="ghost"
            onClick={() => w.removeLane(w.activeLaneId)}
            aria-label="收起当前这条线"
          >
            收起这条线
          </Button>
        </div>
      )}
    </>
  );
}
