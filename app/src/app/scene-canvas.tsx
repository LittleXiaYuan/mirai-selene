import { useEffect, useRef } from "react";

/**
 * 实时场景渲染器。
 *
 * 为什么不用"每幕生成一张图"当主画面：生成一张要十几秒，
 * 那段时间里画面是死的。游戏从来不是每帧算一张图 ——
 * 它用参数化的渲染器，状态一变，下一帧就是新的。
 *
 * 这里做的是同一件事：把 place / time / mood / weather 读成参数，
 * 每帧画一次。切一幕就是参数变，所有东西连续地过渡过去，不闪、不空。
 *
 * 生成的插画是另一层：它晚一点到，淡入盖在上面。到不了就一直是这一层。
 */

export interface SceneParams {
  place: string;
  time: string;
  mood: string;
  weather: string;
  /** 世界记得的事：画面是状态的函数，不是像素的函数。 */
  memories?: { key: string; value: number }[];
  /** 世界时钟：小时 0–23。影响太阳高度和整体光温。 */
  hour?: number;
}

interface Vec {
  skyTop: [number, number, number];
  skyMid: [number, number, number];
  skyLow: [number, number, number];
  ground: [number, number, number];
  sun: [number, number, number];
  sunY: number;
  sunX: number;
  sunR: number;
  starAlpha: number;
  fog: number;
  rain: number;
  snow: number;
  interior: boolean;
  contrast: number;
  /** 压力：值越高越冷、越灰、越压暗。 */
  pressure: number;
  /** 暖意：值越高越暖，光越软。 */
  warmth: number;
}

const TIME_PRESETS: Record<string, Partial<Vec>> = {
  dawn: {
    skyTop: [42, 48, 82],
    skyMid: [122, 96, 120],
    skyLow: [214, 160, 150],
    ground: [30, 30, 40],
    sun: [255, 210, 170],
    sunY: 0.62,
    sunR: 26,
    starAlpha: 0.25,
  },
  morning: {
    skyTop: [58, 96, 148],
    skyMid: [126, 168, 200],
    skyLow: [206, 224, 232],
    ground: [44, 48, 52],
    sun: [255, 246, 226],
    sunY: 0.34,
    sunR: 22,
    starAlpha: 0,
  },
  noon: {
    skyTop: [54, 108, 172],
    skyMid: [120, 172, 216],
    skyLow: [208, 232, 244],
    ground: [52, 56, 58],
    sun: [255, 255, 246],
    sunY: 0.16,
    sunR: 18,
    starAlpha: 0,
  },
  dusk: {
    skyTop: [46, 34, 62],
    skyMid: [140, 78, 86],
    skyLow: [232, 150, 96],
    ground: [28, 22, 26],
    sun: [255, 176, 112],
    sunY: 0.66,
    sunR: 28,
    starAlpha: 0.18,
  },
  night: {
    skyTop: [8, 10, 22],
    skyMid: [16, 20, 40],
    skyLow: [30, 36, 62],
    ground: [10, 11, 16],
    sun: [206, 220, 255],
    sunY: 0.24,
    sunX: 0.74,
    sunR: 16,
    starAlpha: 1,
  },
};

function timeKey(text: string): keyof typeof TIME_PRESETS {
  if (/清晨|早|晨/.test(text)) return "dawn";
  if (/正午|午|日间|白天/.test(text)) return "noon";
  if (/黄昏|傍晚|夕|落/.test(text)) return "dusk";
  if (/深夜|夜|凌晨/.test(text)) return "night";
  return "dusk";
}

const PRESSURE_RE = /压力|紧|焦|怕|冷|疏|怀疑|累|堵|撑不住|慌/;
const WARM_RE = /安心|温|信任|家|喜欢|平静|靠|暖|踏实|被理解/;

/** 记忆不是装饰：它们决定这个世界的色调。 */
function moodFromMemories(memories: { key: string; value: number }[] = []) {
  let pressure = 0;
  let warmth = 0;
  for (const m of memories) {
    const v = Math.max(0, Math.min(10, Number(m.value) || 0));
    if (PRESSURE_RE.test(m.key)) pressure += v;
    if (WARM_RE.test(m.key)) warmth += v;
  }
  return {
    pressure: Math.min(1, pressure / 24),
    warmth: Math.min(1, warmth / 24),
  };
}

function targetFor(p: SceneParams): Vec {
  const base = TIME_PRESETS[timeKey(`${p.time}${p.place}`)];
  const w = p.weather;
  const interior = /房|屋|室|厅|书|办公|车|舱/.test(p.place);
  const tense = /紧|冷|疏|压|不安/.test(p.mood);

  const { pressure, warmth } = moodFromMemories(p.memories);

  return {
    pressure,
    warmth,
    skyTop: base.skyTop ?? [30, 34, 52],
    skyMid: base.skyMid ?? [80, 90, 120],
    skyLow: base.skyLow ?? [150, 150, 170],
    ground: base.ground ?? [20, 22, 30],
    sun: base.sun ?? [255, 240, 220],
    // 有钟点时用钟点算太阳高度：6 点地平线，12 点最高，18 点落下
    sunY:
      typeof p.hour === "number"
        ? Math.max(0.06, Math.min(0.94, 1.02 - Math.abs(p.hour - 12) / 7.2))
        : (base.sunY ?? 0.5),
    sunX: base.sunX ?? 0.5,
    sunR: base.sunR ?? 22,
    starAlpha: base.starAlpha ?? 0,
    fog: /雾|霾/.test(w) ? 0.8 : /雨/.test(w) ? 0.35 : /阴/.test(w) ? 0.5 : 0.06,
    rain: /雨/.test(w) ? 1 : 0,
    snow: /雪/.test(w) ? 1 : 0,
    interior,
    contrast: tense ? 0.28 : 0,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRgb = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

export function SceneCanvas({
  params,
  frozen = false,
  paused = false,
}: {
  params: SceneParams;
  /** 冻结时参数立即到位、粒子停在确定位置 —— 同一状态必然同一帧。 */
  frozen?: boolean;
  /**
   * 暂停时只画一帧，不进 rAF 循环。
   *
   * 对照视图里同时有好几个画布，每个都跑 60fps 没必要 ——
   * 没有变化的那几格画一次就够，省下来的算力留给真正在动的那格。
   */
  paused?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const targetRef = useRef<Vec>(targetFor(params));
  const curRef = useRef<Vec>(targetFor(params));
  const rafRef = useRef<number>(0);
  const particlesRef = useRef<{ x: number; y: number; v: number; l: number }[]>([]);
  const tRef = useRef(0);

  // 参数变了只改目标，渲染循环自己插值过去 —— 这样不会闪
  useEffect(() => {
    targetRef.current = targetFor(params);
  }, [params.place, params.time, params.mood, params.weather, params.hour, params.memories]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // 初始粒子
    const seed = () => {
      const list: { x: number; y: number; v: number; l: number }[] = [];
      for (let i = 0; i < 140; i += 1) {
        // 确定性伪随机：同一个世界永远同一批粒子
        const a = ((i * 2654435761) >>> 0) / 4294967296;
        const b = ((i * 40503 + 7919) % 65536) / 65536;
        const c = ((i * 2246822519) >>> 0) / 4294967296;
        const d = ((i * 3266489917) >>> 0) / 4294967296;
        list.push({ x: a, y: b, v: 0.4 + c, l: 0.4 + d * 0.6 });
      }
      particlesRef.current = list;
    };
    seed();

    const draw = (loop: boolean) => {
      const w = canvas.width;
      const h = canvas.height;
      const cur = curRef.current;
      const tgt = targetRef.current;

      // 朝目标插值：约 0.9 秒走完；冻结时直接到位
      const k = reduce || frozen ? 1 : 0.055;
      cur.skyTop = lerpRgb(cur.skyTop, tgt.skyTop, k);
      cur.skyMid = lerpRgb(cur.skyMid, tgt.skyMid, k);
      cur.skyLow = lerpRgb(cur.skyLow, tgt.skyLow, k);
      cur.ground = lerpRgb(cur.ground, tgt.ground, k);
      cur.sun = lerpRgb(cur.sun, tgt.sun, k);
      cur.sunY = lerp(cur.sunY, tgt.sunY, k);
      cur.sunX = lerp(cur.sunX, tgt.sunX, k);
      cur.sunR = lerp(cur.sunR, tgt.sunR, k);
      cur.starAlpha = lerp(cur.starAlpha, tgt.starAlpha, k);
      cur.fog = lerp(cur.fog, tgt.fog, k);
      cur.rain = lerp(cur.rain, tgt.rain, k);
      cur.snow = lerp(cur.snow, tgt.snow, k);
      cur.contrast = lerp(cur.contrast, tgt.contrast, k);
      cur.pressure = lerp(cur.pressure, tgt.pressure, k);
      cur.warmth = lerp(cur.warmth, tgt.warmth, k);
      cur.interior = tgt.interior;

      // 粒子位置固定，不随时间走：画面必须是状态的纯函数
      tRef.current = 0;
      const t = tRef.current;

      // 记忆调制：压力去饱和并压暗，暖意往低空加温
      const sat = 1 - cur.pressure * 0.55;
      const dim = 1 - cur.pressure * 0.22 + cur.warmth * 0.06;
      const mix = (c: [number, number, number]): [number, number, number] => {
        const g = (c[0] + c[1] + c[2]) / 3;
        return [
          (g + (c[0] - g) * sat) * dim,
          (g + (c[1] - g) * sat) * dim,
          (g + (c[2] - g) * sat) * dim + cur.warmth * 14,
        ];
      };

      // 天空
      const horizon = h * (cur.interior ? 0.58 : 0.62);
      const sky = ctx.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, `rgb(${mix(cur.skyTop).map(Math.round).join(",")})`);
      sky.addColorStop(0.55, `rgb(${mix(cur.skyMid).map(Math.round).join(",")})`);
      sky.addColorStop(1, `rgb(${mix(cur.skyLow).map(Math.round).join(",")})`);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, horizon);

      // 星
      if (cur.starAlpha > 0.02) {
        ctx.fillStyle = `rgba(240,244,255,${cur.starAlpha * 0.7})`;
        for (const p of particlesRef.current.slice(0, 60)) {
          const x = p.x * w;
          const y = p.y * horizon * 0.8;
          const r = p.l * dpr * 0.9;
          ctx.fillRect(x, y, r, r);
        }
      }

      // 日月
      const sunX = w * cur.sunX;
      const sunY = horizon * cur.sunY;
      const halo = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, cur.sunR * dpr * 6);
      halo.addColorStop(0, `rgba(${cur.sun.map(Math.round).join(",")},0.5)`);
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(sunX - cur.sunR * dpr * 6, sunY - cur.sunR * dpr * 6, cur.sunR * dpr * 12, cur.sunR * dpr * 12);
      ctx.beginPath();
      ctx.arc(sunX, sunY, cur.sunR * dpr * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${cur.sun.map(Math.round).join(",")})`;
      ctx.fill();

      // 远景轮廓：城市或山，随地点变
      const city = /上海|城市|街|路|楼/.test(params.place);
      ctx.fillStyle = `rgba(${mix(cur.ground).map(Math.round).join(",")},0.72)`;
      ctx.beginPath();
      ctx.moveTo(0, horizon);
      if (city) {
        let x = 0;
        let i = 0;
        while (x < w) {
          const bw = (18 + ((i * 37) % 46)) * dpr;
          const bh = (26 + ((i * 53) % 90)) * dpr;
          ctx.lineTo(x, horizon - bh);
          ctx.lineTo(x + bw, horizon - bh);
          x += bw + 3 * dpr;
          i += 1;
        }
      } else {
        const amp = 26 * dpr;
        for (let x = 0; x <= w; x += 8 * dpr) {
          const y = horizon - Math.sin(x / (90 * dpr) + 1.3) * amp - Math.sin(x / (37 * dpr)) * amp * 0.35;
          ctx.lineTo(x, y);
        }
      }
      ctx.lineTo(w, horizon);
      ctx.closePath();
      ctx.fill();

      // 地面
      const ground = ctx.createLinearGradient(0, horizon, 0, h);
      ground.addColorStop(0, `rgb(${mix(cur.ground).map(Math.round).join(",")})`);
      ground.addColorStop(1, `rgb(${mix(cur.ground).map((v) => Math.round(v * 0.55)).join(",")})`);
      ctx.fillStyle = ground;
      ctx.fillRect(0, horizon, w, h - horizon);

      // 室内：窗框与光带
      if (cur.interior) {
        const margin = w * 0.16;
        const top = h * 0.1;
        const bottom = horizon * 1.02;
        // 窗外的光
        const shaft = ctx.createLinearGradient(w * 0.5, top, w * 0.5, h);
        shaft.addColorStop(0, `rgba(${cur.sun.map(Math.round).join(",")},${0.22 + cur.starAlpha * -0.1})`);
        shaft.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = shaft;
        ctx.beginPath();
        ctx.moveTo(margin, top);
        ctx.lineTo(w - margin, top);
        ctx.lineTo(w - margin * 0.2, h);
        ctx.lineTo(margin * 0.2, h);
        ctx.closePath();
        ctx.fill();
        // 窗框
        ctx.strokeStyle = `rgba(${cur.ground.map((v) => Math.round(v * 0.4)).join(",")},0.85)`;
        ctx.lineWidth = 6 * dpr;
        ctx.strokeRect(margin, top, w - margin * 2, bottom - top);
        ctx.beginPath();
        ctx.moveTo(w / 2, top);
        ctx.lineTo(w / 2, bottom);
        ctx.moveTo(margin, (top + bottom) / 2);
        ctx.lineTo(w - margin, (top + bottom) / 2);
        ctx.stroke();
      }

      // 雾
      if (cur.fog > 0.02) {
        const fog = ctx.createLinearGradient(0, horizon - h * 0.16, 0, horizon + h * 0.1);
        fog.addColorStop(0, "rgba(190,196,210,0)");
        fog.addColorStop(0.6, `rgba(190,196,210,${cur.fog * 0.42})`);
        fog.addColorStop(1, "rgba(190,196,210,0)");
        ctx.fillStyle = fog;
        ctx.fillRect(0, horizon - h * 0.16, w, h * 0.26);
      }

      // 雨
      if (cur.rain > 0.02) {
        ctx.strokeStyle = `rgba(200,214,230,${cur.rain * 0.34})`;
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath();
        for (const p of particlesRef.current) {
          const x = p.x * w;
          const y = p.y * h;
          ctx.moveTo(x, y);
          ctx.lineTo(x - 2 * dpr, y + 16 * p.l * dpr);
        }
        ctx.stroke();
      }

      // 雪
      if (cur.snow > 0.02) {
        ctx.fillStyle = `rgba(240,246,255,${cur.snow * 0.5})`;
        for (const p of particlesRef.current) {
          const x = p.x * w;
          const y = p.y * h;
          ctx.beginPath();
          ctx.arc(x, y, p.l * 1.6 * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 情绪：压暗四角，紧张时更重
      const vig = ctx.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.25, w / 2, h * 0.5, Math.max(w, h) * 0.78);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, `rgba(0,0,0,${0.42 + cur.contrast + cur.pressure * 0.2})`);
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, w, h);

      if (loop) rafRef.current = requestAnimationFrame(() => draw(true));
    };

    rafRef.current = requestAnimationFrame(() => draw(!paused));

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
    // paused 时同一个 effect 会在参数变化后重跑，画一帧就够
  }, [params.place, params.time, params.mood, params.weather, params.hour, params.memories, paused]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}
