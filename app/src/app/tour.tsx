import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/arc/button/button";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import styles from "./tour.module.css";

export interface TourStep {
  /** 要聚焦的元素，用 data 属性选，别依赖 CSS Modules 的哈希类名。 */
  target: string;
  title: string;
  body: string;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 10;
const GAP = 14;

/**
 * 聚焦式引导：把真实界面里的目标元素透出来，其余压暗，说明贴在它旁边。
 *
 * 为什么不是居中弹窗：居中弹窗和它解释的东西不在一个位置，
 * 用户要在"读说明"和"找东西"之间来回看。聚焦把两件事放到一起。
 */
export function Tour({
  steps,
  onDone,
}: {
  steps: TourStep[];
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardTop, setCardTop] = useState(0);
  const [cardLeft, setCardLeft] = useState(16);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const reduce = useReducedMotion();

  const step = steps[index];

  const measure = useCallback(() => {
    if (!step) return;
    const el = document.querySelector(step.target) as HTMLElement | null;
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const box: Rect = {
      top: Math.max(0, r.top - PAD),
      left: Math.max(0, r.left - PAD),
      width: Math.min(r.width + PAD * 2, window.innerWidth),
      height: Math.min(r.height + PAD * 2, window.innerHeight),
    };
    setRect(box);

    // 卡片尺寸：先用测得值，首次用估算
    const cw = cardRef.current?.offsetWidth ?? 352;
    const ch = cardRef.current?.offsetHeight ?? 176;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const below = vh - (box.top + box.height);
    const above = box.top;
    const left = box.left;
    const right = vw - (box.left + box.width);

    const clampX = (x: number) => Math.min(Math.max(16, x), Math.max(16, vw - cw - 16));
    const clampY = (y: number) => Math.min(Math.max(16, y), Math.max(16, vh - ch - 16));

    // 依次尝试：下方、上方、左侧、右侧。都不够就贴底。
    if (below >= ch + GAP) {
      setCardTop(box.top + box.height + GAP);
      setCardLeft(clampX(box.left));
    } else if (above >= ch + GAP) {
      setCardTop(box.top - GAP - ch);
      setCardLeft(clampX(box.left));
    } else if (left >= cw + GAP) {
      setCardTop(clampY(box.top + box.height / 2 - ch / 2));
      setCardLeft(box.left - GAP - cw);
    } else if (right >= cw + GAP) {
      setCardTop(clampY(box.top + box.height / 2 - ch / 2));
      setCardLeft(box.left + box.width + GAP);
    } else {
      setCardTop(clampY(vh - ch - 16));
      setCardLeft(clampX(box.left));
    }
  }, [step]);

  useLayoutEffect(() => {
    measure();
  }, [measure, index, cardLeft, cardTop]);

  // 卡片实际高度可能和估算不同（窄屏文字换行更多），量到就重算位置
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, index]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure]);

  // 高亮期间给目标元素打标记，让它在遮罩之上
  useEffect(() => {
    if (!step) return;
    const el = document.querySelector(step.target) as HTMLElement | null;
    el?.setAttribute("data-tour-active", "true");
    return () => {
      el?.removeAttribute("data-tour-active");
    };
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  if (!step) return null;

  const next = () => (index === steps.length - 1 ? onDone() : setIndex(index + 1));

  return (
    <div className={styles.layer} role="dialog" aria-modal="true" aria-label="使用引导">
      {rect && (
        <div
          className={styles.hole}
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          aria-hidden
        />
      )}
      <div className={styles.catch} onClick={next} aria-hidden />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={index}
          ref={cardRef}
          className={styles.card}
          style={{ top: cardTop, left: cardLeft }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: motionTokens.duration.exit } }}
          transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}
        >
          <div className={styles.head}>
            <span className={styles.step}>
              {index + 1}/{steps.length}
            </span>
            <span className={styles.title}>{step.title}</span>
          </div>
          <p className={styles.body}>{step.body}</p>

          <div className={styles.actions}>
            <div className={styles.dots} aria-hidden>
              {steps.map((_, i) => (
                <span key={i} className={styles.dot} data-on={i <= index} />
              ))}
            </div>
            {index > 0 && (
              <Button variant="ghost" onClick={() => setIndex(index - 1)}>
                上一步
              </Button>
            )}
            <Button onClick={next}>
              {index === steps.length - 1 ? "开始" : "下一步"}
              {index < steps.length - 1 && <ArrowRight size={16} strokeWidth={1.75} aria-hidden />}
            </Button>
          </div>
        </motion.div>
      </AnimatePresence>

      <button
        onClick={onDone}
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 82,
          minHeight: "var(--control-height-md)",
          padding: "0 16px",
          borderRadius: "var(--radius-pill)",
          border: "1px solid var(--border)",
          background: "var(--surface-raised)",
          color: "var(--text-secondary)",
          fontSize: "var(--text-xs)",
        }}
      >
        跳过
      </button>
    </div>
  );
}

/** 三步引导，分别指向选择、时间线、分叉。 */
export const STAGE_TOUR: TourStep[] = [
  {
    target: '[data-tour="composer"]',
    title: "写一句，世界就演一幕",
    body: "没有固定选项。你想让她做什么，直接写下来，世界当场生成下一幕。",
  },
  {
    target: '[data-tour="timeline"]',
    title: "每一幕都留在时间线上",
    body: "点任意一个节点就能退回去，那一幕的原文还在。写砸了不用重来。",
  },
  {
    target: '[data-tour="fork"]',
    title: "也可以从这儿分叉",
    body: "从任何一步开一条新线，两条线最后还能接上。世界能导出带走。",
  },
];
