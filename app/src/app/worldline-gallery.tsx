import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import type { Stance } from "./pai";
import { STANCE_FACE } from "./stance";
import styles from "./gallery.module.css";

export interface SaveSlot {
  id: string;
  nodeId: string;
  label: string;
  kind: string;
  steps: number;
  /** 由状态推出的色相，没有缩略图时就是这条世界线的「脸色」。 */
  tone: string;
  moodWord: string;
  quote?: string;
  image?: string;
  stance?: Stance;
  ruin?: number;
  fingerprint?: string;
  spread?: number;
  commutativity?: number;
}

export interface MergeReport {
  ok: boolean;
  message: string;
  commutativity?: number;
}

interface Flight {
  a: { x: number; y: number; width: number; height: number };
  b: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
}

const SLOTS = 10;
const PAD = 2;

type View = "look" | "kernel";

export function WorldlineGallery({
  slots,
  busy,
  report,
  onOpen,
  onMerge,
  onProbe,
  onClose,
  onHome,
  onWorld,
  onEnter,
}: {
  slots: SaveSlot[];
  busy: boolean;
  report: MergeReport | null;
  onOpen: (slot: SaveSlot) => void;
  onMerge: (a: SaveSlot, b: SaveSlot) => Promise<void> | void;
  onProbe: () => Promise<void> | void;
  onClose?: () => void;
  onHome?: () => void;
  onWorld?: () => void;
  onEnter?: () => void;
}) {
  const reduce = useReducedMotion();
  const [view, setView] = useState<View>("look");
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [flight, setFlight] = useState<Flight | null>(null);
  const [merging, setMerging] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const pressTimer = useRef(0);
  const longPressed = useRef(false);

  const shown = useMemo(() => slots.slice(0, SLOTS), [slots]);
  const blanks = Math.max(0, SLOTS - shown.length);

  const toggle = (slot: SaveSlot) => {
    setPicked((prev) => {
      if (prev.includes(slot.id)) return prev.filter((x) => x !== slot.id);
      const first = prev
        .map((id) => shown.find((item) => item.id === id))
        .find((item): item is SaveSlot => Boolean(item));
      if (first && first.nodeId === slot.nodeId) return prev;
      if (prev.length >= 2) return [prev[1], slot.id];
      return [...prev, slot.id];
    });
  };

  const onCard = (slot: SaveSlot) => {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    if (picking) toggle(slot);
    else onOpen(slot);
  };

  const startPress = (slot: SaveSlot) => {
    if (!picking) return;
    window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      toggle(slot);
    }, 420);
  };

  const endPress = () => window.clearTimeout(pressTimer.current);

  const runMerge = async () => {
    const [a, b] = picked
      .map((id) => shown.find((slot) => slot.id === id))
      .filter((slot): slot is SaveSlot => Boolean(slot));
    if (!a || !b || !gridRef.current) return;

    const grid = gridRef.current.getBoundingClientRect();
    const toRect = (element?: HTMLElement) => {
      const rect = element?.getBoundingClientRect();
      if (!rect) return null;
      return {
        x: rect.left - grid.left,
        y: rect.top - grid.top,
        width: rect.width,
        height: rect.height,
      };
    };
    const ra = toRect(cardRefs.current.get(a.id));
    const rb = toRect(cardRefs.current.get(b.id));

    setMerging(true);
    if (ra && rb && !reduce) {
      setFlight({
        a: ra,
        b: rb,
        center: {
          x: (ra.x + rb.x) / 2 + (ra.width - rb.width) / 4,
          y: (ra.y + rb.y) / 2 + (ra.height - rb.height) / 4,
        },
      });
      await new Promise((resolve) => window.setTimeout(resolve, 460));
    }

    await onMerge(a, b);
    setFlight(null);
    setMerging(false);
    setPicking(false);
    setPicked([]);
  };

  return (
    <div className={styles.gallery}>
      <header className={styles.head}>
        <div className={styles.counter}>
          <b>{String(shown.length).padStart(3, "0")}</b>
          <span>/ {String(SLOTS).padStart(3, "0")}</span>
        </div>

        <div className={styles.tools}>
          <SegmentedControl
            label="存档显示"
            value={view}
            onValueChange={(next) => setView(next as View)}
            options={[
              { value: "look", label: "外观" },
              { value: "kernel", label: "内核" },
            ]}
          />
          <Button size="sm" variant="secondary" onClick={() => void onProbe()} loading={busy}>
            ✨ 让 Agent 探出 3 条分支
          </Button>
          {picking ? (
            <>
              <Button size="sm" onClick={() => void runMerge()} disabled={picked.length !== 2 || merging} loading={merging}>
                {merging ? "正在合流" : `合流 ${picked.length}/2`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPicking(false);
                  setPicked([]);
                }}
              >
                取消
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setPicking(true)} disabled={shown.length < 2}>
              🔀 合流两个存档
            </Button>
          )}
        </div>
      </header>

      <div className={styles.gridWrap} ref={gridRef}>
        <div className={styles.grid} data-view={view}>
          {shown.map((slot, index) => {
            const selected = picked.includes(slot.id);
            const firstPicked = picked
              .map((id) => shown.find((item) => item.id === id))
              .find((item): item is SaveSlot => Boolean(item));
            const blocked =
              picking && !selected && Boolean(firstPicked) && firstPicked?.nodeId === slot.nodeId;
            const face = slot.stance ? STANCE_FACE[slot.stance] : null;
            const ruin = (slot.ruin ?? 0) > 0.8;
            return (
              <motion.button
                key={slot.id}
                type="button"
                layout={!reduce}
                ref={(node) => {
                  if (node) cardRefs.current.set(slot.id, node);
                  else cardRefs.current.delete(slot.id);
                }}
                className={styles.card}
                data-selected={selected || undefined}
                data-ruin={ruin || undefined}
                data-blocked={blocked || undefined}
                style={{ "--card-tone": slot.tone } as CSSProperties}
                onClick={() => onCard(slot)}
                onPointerDown={() => startPress(slot)}
                onPointerUp={endPress}
                onPointerLeave={endPress}
                transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}
                whileHover={reduce ? undefined : { y: -2 }}
                whileTap={reduce ? undefined : { scale: 0.99 }}
                aria-pressed={picking ? selected : undefined}
                aria-label={`No.${String(index + 1).padStart(PAD, "0")} ${slot.label}${ruin ? "，谈崩出局" : ""}`}
                title={blocked ? "这一张和已选的在同一步，换一张" : undefined}
              >
                <span className={styles.slotTop}>
                  <span className={styles.slotNo}>No.{String(index + 1).padStart(PAD, "0")}</span>
                  <span>{slot.steps} 步</span>
                </span>

                <span className={styles.thumb}>
                  {slot.image ? <img src={slot.image} alt="" loading="lazy" /> : <span className={styles.thumbVeil} />}
                  {face ? (
                    <span className={styles.tag}>
                      <Badge size="sm" tone={face.badge}>
                        {face.label}
                      </Badge>
                    </span>
                  ) : null}
                  {ruin ? <span className={styles.stamp}>谈崩出局</span> : null}
                  {picking ? (
                    <span className={styles.pickMark} data-on={selected || undefined}>
                      {selected ? "已选" : "选这张"}
                    </span>
                  ) : null}
                </span>

                <span className={styles.quote}>{slot.quote ?? slot.label}</span>

                {view === "kernel" ? (
                  <span className={styles.kernel}>
                    <span>
                      <span>指纹</span>
                      <b>{slot.fingerprint ?? "本地"}</b>
                    </span>
                    <span>
                      <span>生死跨度</span>
                      <b>{slot.spread != null ? slot.spread.toFixed(2) : "未算"}</b>
                    </span>
                    <span>
                      <span>合流误差</span>
                      <b>{slot.commutativity != null ? slot.commutativity.toExponential(1) : "—"}</b>
                    </span>
                  </span>
                ) : null}

                <span className={styles.foot}>
                  <span>{slot.label}</span>
                  <span>{slot.moodWord}</span>
                </span>
              </motion.button>
            );
          })}

          {Array.from({ length: blanks }).map((_, index) => (
            <div key={`blank-${index}`} className={styles.blank} aria-hidden>
              <span className={styles.slotNo}>No.{String(shown.length + index + 1).padStart(PAD, "0")}</span>
              <span className={styles.emptyMark}>空</span>
            </div>
          ))}
        </div>

        <AnimatePresence>
          {flight ? (
            <>
              {[flight.a, flight.b].map((rect, index) => (
                <motion.span
                  key={`ghost-${index}`}
                  className={styles.ghost}
                  initial={{ x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity: 0.9 }}
                  animate={{
                    x: flight.center.x,
                    y: flight.center.y,
                    width: rect.width * 0.34,
                    height: rect.height * 0.34,
                    opacity: 0,
                  }}
                  exit={{ opacity: 0 }}
                  transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}
                />
              ))}
              <motion.span
                className={styles.flash}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: [0, 0.8, 0], scale: [0.6, 1.4, 1.8] }}
                transition={{ duration: 0.7, ease: motionTokens.ease.standard }}
                style={{ left: flight.center.x, top: flight.center.y }}
              />
            </>
          ) : null}
        </AnimatePresence>
      </div>

      {report ? (
        <Alert tone={report.ok ? "success" : "danger"} title={report.ok ? "两条线接上了" : "这两条接不上"}>
          {report.message}
          {report.commutativity != null ? (
            <span className={styles.errorNote}> 交换律误差 {report.commutativity.toExponential(1)}。</span>
          ) : null}
        </Alert>
      ) : null}

      {!shown.length ? (
        <EmptyState
          title="还没有存档"
          description="先往前走一步，或者让 Agent 探出三条分支。"
          action={
            <Button onClick={() => void onProbe()} loading={busy}>
              ✨ 派 Agent 探路
            </Button>
          }
        />
      ) : null}

      <footer className={styles.footer}>
        <Button variant="ghost" onClick={() => setPicking(false)}>
          保存
        </Button>
        <Button variant="ghost" onClick={onClose}>
          读取
        </Button>
        <Button variant="ghost" onClick={onWorld}>
          切换世界
        </Button>
        <Button variant="ghost" onClick={onEnter}>
          回到游戏
        </Button>
        <Button variant="ghost" onClick={onHome}>
          返回标题界面
        </Button>
      </footer>
    </div>
  );
}
