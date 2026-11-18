import type { MoodReading } from "@/world/engine";
import type { Stance } from "./pai";

export interface StanceFace {
  /** 给玩家看的四个字，不用模型术语。 */
  label: string;
  /** 这一档她在做什么。 */
  hint: string;
  /** 舞台氛围色，只在色相上做变化，亮度交给 token。 */
  tone: string;
  /** Arc Badge 的语义 tone。 */
  badge: "neutral" | "success" | "info" | "warning" | "danger";
}

export const STANCE_FACE: Record<Stance, StanceFace> = {
  empathetic: {
    label: "信了一点",
    hint: "她愿意往下听，语气软了。",
    tone: "var(--tone-teal)",
    badge: "success",
  },
  neutral: {
    label: "平视",
    hint: "她在看你怎么说，不急着表态。",
    tone: "var(--tone-sky)",
    badge: "neutral",
  },
  probe_blindspot: {
    label: "追问底牌",
    hint: "她摸到你还没说的地方，开始主动问。",
    tone: "var(--tone-sky)",
    badge: "info",
  },
  skeptical_push: {
    label: "听出心虚",
    hint: "你的话和语气对不上，她当场抬杠。",
    tone: "var(--tone-amber)",
    badge: "warning",
  },
  counter_bluff: {
    label: "反将一军",
    hint: "她拿住你的软肋，把问题原样推回来。",
    tone: "var(--tone-violet)",
    badge: "info",
  },
  rupture: {
    label: "谈崩",
    hint: "这一步踩穿了不可逆的那条线。",
    tone: "var(--tone-rose)",
    badge: "danger",
  },
};

export const STANCE_ORDER: Stance[] = [
  "empathetic",
  "neutral",
  "probe_blindspot",
  "skeptical_push",
  "counter_bluff",
  "rupture",
];

/**
 * 桥没起来时的替身：只看本地状态读数。
 * 它不假装是模型输出 —— 只用来决定舞台的冷暖，不显示概率。
 */
export function stanceFromMood(mood: MoodReading | null, tension = 0): Stance {
  if (!mood) return "neutral";
  if (mood.balance > 3) return "empathetic";
  if (mood.pressure >= 14 && tension > 0.55) return "rupture";
  if (tension > 0.5) return "skeptical_push";
  if (mood.pressure > 10) return "probe_blindspot";
  if (mood.balance < -3) return "counter_bluff";
  return "neutral";
}

export function isStance(value: unknown): value is Stance {
  return typeof value === "string" && value in STANCE_FACE;
}
