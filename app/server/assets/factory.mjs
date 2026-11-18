/**
 * 资产生产线：意图 → 10 个叙事节点 → 立绘/背景任务单 → 图像。
 *
 * 没有图像 key 时，工厂仍然产出完整的 Spec 与 Prompt 任务单 ——
 * 这样评委在断网现场也能看到「工业化交付」的中间产物，而不是一块空白。
 */

import { cacheArt } from "../image.mjs";
import { NEGATIVE, planAssetTasks } from "./prompt-library.mjs";

const MINIMAX_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_IMAGE_URL =
  process.env.MINIMAX_IMAGE_URL || "https://api.minimax.chat/v1/image_generation";

const PROVIDER =
  process.env.ASSET_PROVIDER ||
  (MINIMAX_KEY ? "minimax" : process.env.SENSENOVA_API_KEY ? "sensenova" : "none");

const SENSENOVA_KEY = process.env.SENSENOVA_API_KEY || "";
const SENSENOVA_IMAGE_URL =
  process.env.SENSENOVA_IMAGE_URL || "https://api.sensenova.cn/v1/llm/text2image";
const SENSENOVA_MODEL = process.env.SENSENOVA_MODEL || "sensenova-image";

const FALLBACK_BG = [
  "/mirai/demo_bg_rain_cafe.webp",
  "/mirai/demo_bg_rain_cafe.webp",
  "/mirai/demo_bg_rain_cafe.webp",
  "/mirai/demo_bg_rain_cafe.webp",
  "/mirai/demo_bg_rain_cafe.webp",
  "/mirai/demo_bg_rain_cafe.webp",
  "/mirai/demo_bg_rain_cafe.webp",
  "/mirai/demo_bg_rain_cafe.webp",
  "/mirai/demo_bg_dawn_coast.webp",
  "/mirai/demo_bg_dawn_coast.webp",
];

const portrait = (base, emotions = {}) => ({
  base,
  emotions: { neutral: base, warm: base, cold: base, tense: base, broken: base, ...emotions },
});

const portraitManifest = (key) => {
  if (key === "linxia") {
    return portrait("/mirai/demo_linxia_calm.webp", {
      neutral: "/mirai/demo_linxia_calm.webp",
      warm: "/mirai/demo_linxia_warm.webp",
      cold: "/mirai/demo_linxia_tense.webp",
      tense: "/mirai/demo_linxia_tense.webp",
      broken: "/mirai/demo_linxia_tense.webp",
    });
  }
  if (key === "mentor") {
    return portrait("/mirai/demo_chen_exec.webp");
  }
  return portrait(`/mirai/${key}.webp`);
};

const ACT = [
  { id: "hook", title: "开场", goal: "neutral", place: "第一次见面", time: "黄昏", weather: "阴", mood: "紧绷" },
  { id: "probe", title: "试探", goal: "probe_blindspot", place: "安静的角落", time: "黄昏", weather: "阴", mood: "安静" },
  { id: "push", title: "逼问", goal: "skeptical_push", place: "同一个位置", time: "夜", weather: "雨", mood: "紧绷" },
  { id: "counter", title: "反将", goal: "counter_bluff", place: "走到窗边", time: "夜", weather: "雨", mood: "紧绷" },
  { id: "soft", title: "松口", goal: "empathetic", place: "坐下来", time: "夜", weather: "雨", mood: "安静" },
  { id: "blind", title: "盲区", goal: "probe_blindspot", place: "压低声音", time: "深夜", weather: "雨", mood: "安静" },
  { id: "edge", title: "临界", goal: "counter_bluff", place: "门口", time: "深夜", weather: "雨", mood: "紧绷" },
  { id: "break", title: "决裂", goal: "rupture", place: "门外", time: "凌晨", weather: "雨", mood: "疏离" },
  { id: "turn", title: "破局", goal: "empathetic", place: "回到桌边", time: "凌晨", weather: "晴", mood: "安静" },
  { id: "close", title: "收束", goal: "neutral", place: "天亮之前", time: "清晨", weather: "晴", mood: "安静" },
];

/**
 * 规则化拆解：一个主题 → 十幕。
 * 这是可复现的骨架；接上 LLM 后只需把它替换成同一结构的 JSON。
 */
export function planWorld({ theme, title, cast, stakes, worst, tone, tension } = {}) {
  const subject = String(theme || "一场必须今晚谈完的高利害对话").slice(0, 80);
  const worldTitle = String(title || subject).slice(0, 24);
  const id = `factory-${Date.now().toString(36)}`;
  const toneCue = { 冷峻: "句子都很短", 温柔: "语气放得很软", 荒诞: "像在说一个不好笑的笑话", 克制: "谁都没有抬高音量" }[tone] ?? "";
  const people = (Array.isArray(cast) && cast.length ? cast : [
    { id: "you", name: "你", role: "当事人", traits: "手里有牌，但不想先摊", portrait: "linxia" },
    { id: "other", name: "对方", role: "对手", traits: "从不发火，擅长让人自己退", portrait: "mentor" },
  ]).slice(0, 2);

  const backgrounds = {};
  const nodes = ACT.map((act, index) => {
    const bgKey = `scene-${act.id}`;
    backgrounds[bgKey] = { path: FALLBACK_BG[index % FALLBACK_BG.length] };
    const next = ACT[index + 1];
    const choices =
      index < ACT.length - 1
        ? [
            {
              label: index % 2 === 0 ? "把话挑明" : "退半步，先听",
              to: next.id,
              memory: { key: index % 2 === 0 ? "摊牌" : "试探", value: 6 + (index % 3) },
            },
          ]
        : [];

    return {
      id: act.id,
      title: `${act.title} · ${worldTitle}`,
      scene: {
        background: bgKey,
        place: act.place,
        time: act.time,
        weather: act.weather,
        mood: act.mood,
      },
      speaker: index % 2 === 0 ? people[1]?.name ?? "对方" : people[0]?.name ?? "你",
      text: [
        `${subject}。`,
        stakes && act.id === "push" ? `对方把「${stakes}」原样摆在桌上。` : "",
        worst && act.id === "break" ? `最坏的那一幕正在成形：${worst}。` : "",
        act.goal === "rupture"
          ? "空气忽然变硬，谁都没有先眨眼。"
          : act.goal === "empathetic"
            ? "对方的语气松了半寸，像终于愿意听你把话说完。"
            : "一句话悬在两个人之间，等一个能接住的人。",
        toneCue ? `${toneCue}。` : "",
        Number(tension) > 0.55 && index === 0 ? "你开口前的那一下停顿，已经被看见。" : "",
      ].join(""),
      stance_goal: act.goal,
      observe: [{ key: act.title, value: 5 + (index % 5) }],
      choices,
    };
  });

  const spec = {
    spec_version: "1.0",
    id,
    title: worldTitle,
    subtitle: "资产工厂拆解 · 10 幕骨架",
    logline: subject,
    ui: { palette: "warm", accent: "rose" },
    assets_manifest: {
      cover: { path: "/mirai/demo_bg_rain_cafe.webp" },
      backgrounds,
      portraits: Object.fromEntries(people.map((person) => [person.portrait, portraitManifest(person.portrait)])),
    },
    cast: people.map((person) => ({
      id: person.id,
      name: person.name,
      role: person.role,
      traits: person.traits,
      portrait: person.portrait,
    })),
    state_injection: {
      prior_memories: [
        { key: "底牌", value: 7 },
        { key: "时限", value: 6 },
      ],
      stance_bias: { neutral: 0.4, probe_blindspot: 0.3 },
      temperature: 0.7,
    },
    logic_nodes: nodes,
    entry: nodes[0].id,
  };

  return { spec, tasks: planAssetTasks(spec) };
}

export function assetProvider() {
  return PROVIDER;
}

function providerPlan(task) {
  if (PROVIDER === "minimax") {
    if (!MINIMAX_KEY) return null;
    return {
      provider: "minimax",
      url: MINIMAX_IMAGE_URL,
      headers: { Authorization: `Bearer ${MINIMAX_KEY}`, "Content-Type": "application/json" },
      body: {
        model: process.env.MINIMAX_IMAGE_MODEL || "image-01",
        prompt: `${task.prompt}。${task.negative ? `避免：${task.negative}` : ""}`.slice(0, 1500),
        aspect_ratio: task.aspect,
        n: 1,
        prompt_optimizer: true,
      },
    };
  }
  if (PROVIDER === "sensenova") {
    if (!SENSENOVA_KEY) return null;
    return {
      provider: "sensenova",
      url: SENSENOVA_IMAGE_URL,
      headers: { Authorization: `Bearer ${SENSENOVA_KEY}`, "Content-Type": "application/json" },
      body: {
        model: SENSENOVA_MODEL,
        prompt: `${task.prompt}。Avoid: ${task.negative}`,
        size: task.size,
        n: 1,
      },
    };
  }
  return null;
}

function pickUrl(provider, data) {
  if (provider === "minimax") return data?.data?.image_urls?.[0] ?? null;
  return (
    data?.data?.[0]?.url ??
    data?.data?.image_urls?.[0] ??
    data?.images?.[0]?.url ??
    data?.images?.[0] ??
    data?.output?.[0]?.url ??
    null
  );
}

export async function generateAsset(task) {
  if (!task || typeof task.prompt !== "string") {
    return { ok: false, reason: "bad-task" };
  }
  const planned = providerPlan(task);
  if (!planned) {
    return {
      ok: false,
      degraded: true,
      provider: PROVIDER,
      reason: "没有可用的图像 provider（配置 ASSET_PROVIDER / MINIMAX_API_KEY / SENSENOVA_API_KEY）",
      task,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(planned.url, {
      method: "POST",
      headers: planned.headers,
      body: JSON.stringify(planned.body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    const remote = pickUrl(planned.provider, data);
    if (!res.ok || !remote) {
      return {
        ok: false,
        provider: planned.provider,
        reason: data?.base_resp?.status_msg || data?.error || `http-${res.status}`,
        task,
      };
    }
    const local = await cacheArt(`factory:${task.id}:${task.prompt.slice(0, 48)}`, remote);
    return { ok: true, provider: planned.provider, url: local, task };
  } catch (error) {
    return {
      ok: false,
      provider: planned.provider,
      reason: error instanceof Error ? error.message : "生成失败",
      task,
    };
  } finally {
    clearTimeout(timer);
  }
}
