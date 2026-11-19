/**
 * 世界铸造台：启发式对话 → World-Spec。
 *
 * 不做开放式聊天。Selene 只问六件事：处境、主角的软肋、对手的牌、今晚要谈成什么、
 * 最坏的结局、对手戏的温度。答案逐条落到模板里，最后交给资产工厂折成十幕。
 *
 * 语音张力（tension）会进入世界：说话发虚时，对方会更早看穿你。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { planWorld } from "./assets/factory.mjs";
import { planAssetTasks } from "./assets/prompt-library.mjs";
import { deleteForgeSession, loadForgeSession, saveForgeSession } from "./agent_store.mjs";
import { chatJson } from "./llm.mjs";

const TTL_MS = 30 * 60 * 1000;

/**
 * 同一组六个答案只生成一次。
 * 现场演示会重复同一组处境，重跑一遍模型既慢又可能给出不同文本；
 * 缓存让第二次点击是即时的，也让"同一输入两次结果一致"这条验收成立。
 */
const CACHE_DIR = join(dirname(process.env.MIRAI_DATA || "./data/mirai.db"), "forge-cache");
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function cacheKey(answers, tone, tension) {
  const raw = JSON.stringify([
    answers.theme, answers.protagonist, answers.opponent,
    answers.stakes, answers.worst, tone, tension > 0.55 ? 1 : 0,
  ]);
  return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

function readCache(key) {
  try {
    const file = join(CACHE_DIR, `${key}.json`);
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(data?.nodes) || !data.nodes.length) return null;
    if (Date.now() - Number(data.at || 0) > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(key, generated) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify({ at: Date.now(), ...generated }));
  } catch {
    // 缓存写不进去不影响这次生成
  }
}

const STEPS = [
  {
    key: "theme",
    question: "你想预演哪一种处境？",
    hint: "一句话就行，越具体越好。",
    chips: [
      "周三之前，医院与上海 offer",
      "尽调前 48 小时，合伙人逼宫",
      "实名举报前夜，咖啡馆约谈",
      "我妈的手术费和我签不签那份合同",
    ],
  },
  {
    key: "protagonist",
    question: "主角是谁？他/她最怕失去什么？",
    hint: "名字 + 一句软肋。比如「林夏，怕的不是选错，是没得选」。",
    chips: ["林夏，怕的不是选错，是没得选", "周屿，怕代码被人绕过", "我，怕明天之后没有退路"],
  },
  {
    key: "opponent",
    question: "对面坐着谁？他手里有什么牌？",
    hint: "对手越具体，推演越不客气。",
    chips: ["陈总，从不发火，擅长让人自己退", "母亲，嘴硬心软，瞒着复查结果", "投资人，只给最后一次机会"],
  },
  {
    key: "stakes",
    question: "今晚必须谈成什么？谈崩的代价是什么？",
    hint: "把最坏的结果直接说出来，世界才有分位数。",
    chips: ["必须拿到密钥，否则周一尽调过不了", "必须知道报告结果，否则我不敢走", "必须让她签字，否则我明天就被清退"],
  },
  {
    key: "worst",
    question: "最坏的结局长什么样？",
    hint: "不是「失败」，要一个具体的画面。",
    chips: ["她把报告单收进包里，再也没提", "他带着团队和代码一起消失", "举报信被退回，名字却传遍了公司"],
  },
  {
    key: "tone",
    question: "这场对手戏，你想要什么温度？",
    hint: "温度只改语气，不改利害。",
    chips: ["冷峻", "温柔", "荒诞", "克制"],
  },
];

const sessions = new Map();

const id = () => `forge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function sweep() {
  const now = Date.now();
  for (const [key, value] of sessions) {
    if (now - value.at > TTL_MS) sessions.delete(key);
  }
}
setInterval(sweep, 5 * 60 * 1000).unref();

function payload(step, extra = {}) {
  const item = STEPS[step];
  return {
    ok: true,
    step,
    total: STEPS.length,
    done: false,
    question: item?.question ?? "",
    hint: item?.hint ?? "",
    chips: item?.chips ?? [],
    ...extra,
  };
}

function acknowledge(key, answer, tension) {
  const short = answer.trim().replace(/\s+/g, " ").slice(0, 48);
  const soft = tension > 0.55 ? "你的语气有点飘，我记下了。" : "";
  const map = {
    theme: `记住了：${short}。${soft}`,
    protagonist: `软肋是「${short}」。这比目标有用。${soft}`,
    opponent: `对手是「${short}」。${soft}`,
    stakes: `代价是「${short}」。${soft}`,
    worst: `最坏会走到「${short}」。${soft}`,
    tone: `温度定为「${short}」。${soft}`,
  };
  return map[key] ?? `记住了：${short}。`;
}

function parsePerson(text, fallbackName, role) {
  const clean = text.trim().replace(/^我(叫|是)/, "").trim();
  const cut = clean.split(/[，,。；;：:]/)[0] ?? clean;
  const name = cut.length > 0 && cut.length <= 10 ? cut : fallbackName;
  const rest = clean.length > cut.length ? clean.slice(cut.length + 1).trim() : "";
  return {
    name,
    role,
    traits: (rest || clean).slice(0, 48),
  };
}

function portraitKey(name, fallback) {
  if (/母|妈|外婆|奶奶|姨/.test(name)) return "mother";
  if (/selene|塞勒涅|月/i.test(name)) return "selene";
  if (/导师|陈|总|周|老板|投资人|合伙人|对手/.test(name)) return "mentor";
  if (/林|夏|你/.test(name)) return "linxia";
  return fallback;
}

function toneBias(tone, tension) {
  const base = { 冷峻: 0.55, 温柔: 0.72, 荒诞: 0.88, 克制: 0.45 }[tone] ?? 0.65;
  return Math.min(0.98, base + Math.max(0, tension - 0.4) * 0.35);
}

/* ------------------------------------------------------------------ *
 * 真实 LLM：把六问折成十幕
 * 走 server/llm.mjs 的统一入口（SenseNova 兼容模式 / 任意 OpenAI 兼容服务）
 * ------------------------------------------------------------------ */

const STANCES = new Set(["empathetic", "neutral", "probe_blindspot", "skeptical_push", "counter_bluff", "rupture"]);

function nodePrompt(answers, theme, stakes, worst, tone) {
  return [
    "把下面这场真实处境写成十幕互动叙事，只输出一个 JSON 对象，不要 markdown。",
    `处境：${theme}`,
    `主角：${answers.protagonist || "你"}`,
    `对手：${answers.opponent || "对方"}`,
    `必须谈成：${stakes}`,
    `最坏结局：${worst}`,
    `对手戏温度：${tone}`,
    "",
    "要求：",
    "1. nodes 恰好 10 个，id 从 n01 到 n10；n01 是开场，后面的节点按剧情推进。",
    "2. 每个节点 60-120 字，第二人称，写动作、光线、声音、身体反应；不写总结、不写主题升华。",
    "3. stance_goal 只能是 empathetic / neutral / probe_blindspot / skeptical_push / counter_bluff / rupture 之一。",
    "4. 每个非终局节点给 1-2 个 choices；to 必须指向另一个节点 id。允许两条线在后面的节点汇合。",
    "5. speaker 用主角或对手的名字；不要新增角色。",
    "",
    '输出结构：{"title":"世界标题，14字以内","subtitle":"一句副题","logline":"一句话梗概",',
    '"nodes":[{"id":"n01","title":"这一幕的名字","speaker":"名字","text":"正文","stance_goal":"neutral",',
    '"place":"地点","time":"清晨|正午|黄昏|深夜","weather":"晴|阴|雨|雾","mood":"安静|紧绷|疏离|温柔",',
    '"choices":[{"label":"下一步能做什么","to":"n02"}]}]}',
  ].join("\n");
}

function sanitizeGenerated(raw, baseSpec) {
  if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length !== 10) return null;
  const ids = new Set();
  for (const node of raw.nodes) {
    if (!node || typeof node.id !== "string" || !/^n\d{2}$/.test(node.id) || ids.has(node.id)) return null;
    ids.add(node.id);
  }
  const baseNodes = baseSpec.logic_nodes;
  const nodes = [];
  for (let index = 0; index < raw.nodes.length; index += 1) {
    const rawNode = raw.nodes[index];
    const base = baseNodes[index] ?? baseNodes[0];
    const text = String(rawNode.text ?? "").trim();
    if (text.length < 20) return null;
    if (!STANCES.has(rawNode.stance_goal)) return null;
    const choices = Array.isArray(rawNode.choices)
      ? rawNode.choices
          .filter((choice) => choice && typeof choice.label === "string" && ids.has(choice.to))
          .slice(0, 2)
          .map((choice) => ({
            id: `c-${rawNode.id}-${String(choice.to)}`,
            label: choice.label.slice(0, 30),
            to: choice.to,
            memory: { key: rawNode.title ? String(rawNode.title).slice(0, 6) : "这一步", value: 5 },
          }))
      : [];
    nodes.push({
      id: rawNode.id,
      title: String(rawNode.title || base.title).slice(0, 20),
      scene: {
        background: base.scene?.background,
        place: String(rawNode.place || base.scene?.place || "").slice(0, 16),
        time: String(rawNode.time || base.scene?.time || "").slice(0, 8),
        weather: String(rawNode.weather || base.scene?.weather || "").slice(0, 8),
        mood: String(rawNode.mood || base.scene?.mood || "").slice(0, 8),
      },
      speaker: String(rawNode.speaker || base.speaker || "旁白").slice(0, 12),
      text,
      stance_goal: rawNode.stance_goal,
      observe: [{ key: String(rawNode.title || "这一幕").slice(0, 6), value: 5 + (index % 4) }],
      choices,
    });
  }
  return {
    title: typeof raw.title === "string" ? raw.title.slice(0, 16) : undefined,
    subtitle: typeof raw.subtitle === "string" ? raw.subtitle.slice(0, 32) : undefined,
    logline: typeof raw.logline === "string" ? raw.logline.slice(0, 120) : undefined,
    nodes,
  };
}

async function generateWithLLM(answers, baseSpec, { theme, stakes, worst, tone }) {
  const result = await chatJson({
    system: "你是互动叙事引擎。只输出合法的 JSON，不解释，不使用 markdown。",
    user: nodePrompt(answers, theme, stakes, worst, tone),
    temperature: 0.85,
    maxTokens: 2000,
    timeoutMs: 25_000,
  });
  if (!result.ok) {
    console.warn(`[forge] LLM ${result.reason} (${result.model}): ${String(result.error).slice(0, 120)}`);
    return null;
  }
  return sanitizeGenerated(result.data, baseSpec);
}

async function compose(session) {
  const a = session.answers;
  const tension = Number(session.tension || 0);
  const theme = a.theme || "一场必须今晚谈完的高利害对话";
  const rawTitle = theme.split(/[，,。；;：:]/)[0].trim();
  const title = (rawTitle.length > 14 ? rawTitle.slice(0, 14) : rawTitle) || "今晚之前";

  const you = parsePerson(a.protagonist || "你，最怕没有选择", "你", "当事人");
  const other = parsePerson(a.opponent || "对方，擅长让人自己退", "对方", "对手");
  const stakes = (a.stakes || "谈不成，就再也没有下一次").slice(0, 60);
  const worst = (a.worst || "两个人都没得到想要的东西").slice(0, 60);
  const tone = a.tone || "克制";

  const cast = [
    { id: "you", name: you.name, role: you.role, traits: you.traits, portrait: portraitKey(you.name, "linxia") },
    { id: "other", name: other.name, role: other.role, traits: other.traits, portrait: portraitKey(other.name, "mentor") },
  ];

  const planned = planWorld({ theme, title, cast, stakes, worst, tone, tension });

  planned.spec.logline = `${theme}。今晚要谈成的是「${stakes}」；最坏会走到「${worst}」。`;
  planned.spec.subtitle = `Agent 铸造 · ${tone} · 十幕`;
  planned.spec.state_injection = {
    ...planned.spec.state_injection,
    temperature: toneBias(tone, tension),
    stance_bias:
      tone === "温柔"
        ? { empathetic: 0.4, probe_blindspot: 0.25 }
        : tone === "冷峻"
          ? { skeptical_push: 0.45, counter_bluff: 0.3 }
          : tone === "荒诞"
            ? { counter_bluff: 0.4, rupture: 0.2 }
            : { neutral: 0.4, probe_blindspot: 0.3 },
    prior_memories: [
      { key: "底牌", value: 7 },
      { key: "时限", value: 7 },
      ...(tension > 0.55 ? [{ key: "被听出的犹豫", value: 8 }] : []),
    ],
  };

  // 先查缓存，再走真实 LLM；额度/网络/格式任何一步失败就回落到本地模板，并在回复里说明。
  const key = cacheKey(a, tone, tension);
  const cached = readCache(key);
  let generated = cached
    ? { title: cached.title, subtitle: cached.subtitle, logline: cached.logline, nodes: cached.nodes }
    : null;
  let source = cached ? "cache" : "template";
  if (!generated) {
    generated = await generateWithLLM(a, planned.spec, { theme, stakes, worst, tone });
    if (generated) {
      writeCache(key, generated);
      source = "llm";
    }
  }
  if (generated) {
    planned.spec.title = generated.title || planned.spec.title;
    planned.spec.subtitle = generated.subtitle || planned.spec.subtitle;
    planned.spec.logline = generated.logline || planned.spec.logline;
    planned.spec.logic_nodes = generated.nodes;
    planned.spec.entry = generated.nodes[0].id;
    planned.tasks = planAssetTasks(planned.spec);
  }

  const hook = planned.spec.logic_nodes[0];
  const hesitation =
    tension > 0.55
      ? "你开口前停了一下，这一下被对方看见了。"
      : "你没有绕，直接把话放在桌上。";
  hook.text = `${theme}。${hesitation}${hook.text.split("。").slice(1).join("。")}`;
  hook.observe = [
    { key: "开场", value: 5 },
    ...(tension > 0.55 ? [{ key: "被听出的犹豫", value: 8 }] : []),
  ];

  return {
    ok: true,
    done: true,
    step: STEPS.length,
    total: STEPS.length,
    reply: `够了。${you.name} 对 ${other.name}，${tone}的十幕。我把语音里的犹豫也写进了第一幕。`,
    spec: planned.spec,
    tasks: planAssetTasks(planned.spec),
    source,
  };
}

export function startForge(db = null) {
  sweep();
  const session_id = id();
  const session = {
    id: session_id,
    at: Date.now(),
    step: 0,
    answers: {},
    tension: 0,
  };
  sessions.set(session_id, session);
  if (db) saveForgeSession(db, session_id, session);
  return payload(0, {
    session_id,
    greeting: "我是 Selene。别写设定，先告诉我你想走进哪一种处境。",
  });
}

export async function forgeTurn(body, db = null) {
  const sessionId = String(body?.session_id ?? "");
  let session = sessions.get(sessionId);
  if (!session && db) {
    const saved = loadForgeSession(db, sessionId);
    if (saved) {
      session = saved;
      sessions.set(sessionId, saved);
    }
  }
  if (!session) {
    return { ok: false, error: "这个对话已经过期，重新开一个。" };
  }
  if (Date.now() - Number(session.at || 0) > TTL_MS) {
    sessions.delete(session.id);
    if (db) deleteForgeSession(db, session.id);
    return { ok: false, error: "这个对话已经过期，重新开一个。" };
  }
  const text = String(body?.text ?? "").trim();
  if (!text) return { ok: false, error: "说一句就行。" };

  session.at = Date.now();
  session.tension = Math.max(session.tension, Number(body?.tension ?? 0));
  const current = STEPS[session.step];
  if (current) session.answers[current.key] = text;
  session.step += 1;
  session.at = Date.now();

  if (session.step >= STEPS.length) {
    const composed = await compose(session);
    if (db) deleteForgeSession(db, session.id);
    sessions.delete(session.id);
    return composed;
  }

  if (db) saveForgeSession(db, session.id, session);
  return payload(session.step, {
    session_id: session.id,
    reply: acknowledge(current?.key ?? "", text, Number(body?.tension ?? 0)),
  });
}
