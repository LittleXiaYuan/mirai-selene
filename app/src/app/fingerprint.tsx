import { useEffect, useState } from "react";

/**
 * 画面指纹：从真实 canvas 像素算一个短值。
 *
 * 为什么值得有一个：我们主张「同一个状态必然同一帧」。
 * 这句话可以被当场验证 —— 拖回同一幕，指纹必须一样。
 * 如果它变了，说明渲染里混进了时间或随机，那这个主张就是假的。
 *
 * 采样方式：跳过粒子密集区，取画面里若干固定点的像素，
 * 量化到 16 级后拼成 hash，最后 6 位。
 */

export type Fingerprint = {
  value: string;
  at: string;
};

const SAMPLE_SEED = [
  [0.18, 0.12],
  [0.42, 0.08],
  [0.66, 0.16],
  [0.86, 0.1],
  [0.3, 0.3],
  [0.58, 0.34],
  [0.78, 0.28],
  [0.12, 0.44],
  [0.5, 0.48],
  [0.9, 0.42],
];

export function readFingerprint(canvas: HTMLCanvasElement | null): Fingerprint | null {
  if (!canvas || canvas.width < 8 || canvas.height < 8) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  try {
    // 只读一次，取 10 个点，量化到 4 位
    let acc = 0x811c9dc5;
    const parts: string[] = [];
    for (const [fx, fy] of SAMPLE_SEED) {
      const x = Math.min(canvas.width - 1, Math.max(0, Math.round(canvas.width * fx)));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.round(canvas.height * fy)));
      const d = ctx.getImageData(x, y, 1, 1).data;
      const q = ((d[0] >> 4) << 8) | ((d[1] >> 4) << 4) | (d[2] >> 4);
      parts.push(q.toString(16).padStart(3, "0"));
      acc ^= q;
      acc = Math.imul(acc, 0x01000193) >>> 0;
    }
    const value = acc.toString(16).padStart(8, "0").slice(0, 6);
    return {
      value,
      at: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    };
  } catch {
    // 跨域或 DPR 变化时读不到
    return null;
  }
}

function currentCanvas(ref: React.RefObject<HTMLCanvasElement | null>) {
  const host = document.querySelector('[data-canvas-host="true"]');
  return (host?.querySelector("canvas") ?? ref.current) as HTMLCanvasElement | null;
}

/**
 * 等画面**真的**稳定再取指纹。
 *
 * 固定延时不可靠：插值走多久取决于从哪个状态切过来，
 * 而且切换瞬间取到的可能是过渡中的一帧 —— 那就不是"这一状态的那一帧"。
 * 所以改成轮询：连续两次读到同一个值，才算稳定。
 */
export function useFingerprint(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  deps: unknown[],
  settleMs = 1200,
): Fingerprint | null {
  const [fp, setFp] = useState<Fingerprint | null>(null);

  useEffect(() => {
    let alive = true;
    let last = "";
    let stableCount = 0;
    let timer = 0;

    const tick = () => {
      if (!alive) return;
      const snap = readFingerprint(currentCanvas(canvasRef));
      if (!snap) {
        timer = window.setTimeout(tick, 150);
        return;
      }
      if (snap.value === last) {
        stableCount += 1;
      } else {
        last = snap.value;
        stableCount = 0;
      }
      // 连续 3 次一样（约 270ms 无变化）就认为画面稳住了
      if (stableCount >= 3) {
        setFp(snap);
        return;
      }
      timer = window.setTimeout(tick, 150);
    };

    // 先等一个基本延时，让插值开始收敛
    timer = window.setTimeout(tick, settleMs);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return fp;
}
