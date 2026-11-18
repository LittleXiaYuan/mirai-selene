/**
 * 多 Agent 舆情沙盘（上帝视角）。
 *
 * 优先级（100% 诚实标注 provider，绝不伪装）：
 *   1. PAI-SSM 本地推理桥在线时，由真实状态核（paiStep）驱动立场与失控概率（ruin_prob）；
 *   2. LLM 可用时，按真实自定义干预文本动态生成各阵营差异化回应（不再僵硬套模板）；
 *   3. 离线/无 key 时平滑回退本地确定性策略沙盘，保证现场零报错。
 */

import { paiHealth, paiStep } from "./pai.mjs";
import { chatJson, llmConfig } from "./llm.mjs";

const STANCE_SCORE = {
  empathetic: -2,
  neutral: 0,
  probe_blindspot: 1,
  skeptical_push: 2,
  counter_bluff: 3,
  rupture: 4,
};

const STANCE_LABEL = {
  empathetic: "松口",
  neutral: "观望",
  probe_blindspot: "追问",
  skeptical_push: "质疑",
  counter_bluff: "反将",
  rupture: "决裂",
};

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** 失控概率：以每个阵营自己的死穴为拐点的 logistic，不在阈值前就报 100%。 */
function ruinOf(friction, threshold) {
  return clamp(1 / (1 + Math.exp(-(friction - threshold + 0.4) * 1.2)), 0, 1);
}

function policy(faction, intervention, state) {
  const text = intervention.text || "";
  const heat = /公开|证据|录音|起诉|报警|截图|道歉|赔偿|删帖/.test(text);
  const soft = /私下|和解|补偿|沟通|解释|缓/.test(text);
  const hard = /强硬|反击|起诉|报警|曝光|拒绝/.test(text);
  const id = faction.id;

  let trust = state.trust;
  let friction = state.friction;

  if (soft) {
    trust += id === "victim" || id === "guest" ? 0.8 : 0.4;
    friction -= id === "crowd" ? 0.2 : 0.9;
  }
  if (heat) {
    friction += id === "brand" || id === "host" ? 0.8 : id === "skeptic" ? 0.45 : 0.55;
    trust -= id === "brand" ? 0.4 : 0.15;
  }
  if (hard) {
    friction += id === "crowd" ? 0.9 : 0.5;
    trust -= 0.45;
  }
  if (id === "crowd" && /反转|道歉|热搜/.test(text)) friction += 0.7;
  if (id === "silent" && /甩锅|供应商|平台/.test(text)) friction += 0.5;
  if (id === "brand" && /公开|原件/.test(text)) trust -= 0.7;

  trust = clamp(trust, 0, 10);
  friction = clamp(friction, 0, 10);
  const threshold = faction.initial_bias?.ruin_threshold ?? 8.2;

  let stance = "neutral";
  if (friction >= threshold) stance = "rupture";
  else if (friction >= 7.2) stance = "skeptical_push";
  else if (friction >= 6.4) stance = "probe_blindspot";
  else if (trust >= 6.4) stance = "empathetic";
  else if (friction >= 5.8) stance = "counter_bluff";

  return { trust, friction, stance };
}

function messageFor(faction, stance, intervention, round) {
  const said = intervention.text || "刚才那句话";
  const map = {
    victim: {
      empathetic: "如果你现在把整改写清楚，我可以不把第二段录音放出去。",
      neutral: "我还在看，你们先把自己的说法对齐。",
      probe_blindspot: `你刚才说「${said}」，那原件呢？我想看时间戳。`,
      skeptical_push: "这不是解释，这是拖时间。你们每次都这么说。",
      counter_bluff: "行，那我也把最难听的那段放出来，看谁先撑不住。",
      rupture: "不用谈了，我会把完整记录交给平台和监管。",
    },
    guest: {
      empathetic: "公开道歉和整改，我可以删帖。",
      neutral: "我先不删，等你们给一个书面说法。",
      probe_blindspot: "免单不算整改。书面记录呢？",
      skeptical_push: "你们只想让我删帖，不是想解决问题。",
      counter_bluff: "那段私信我也一起发出去。",
      rupture: "那就让平台来处理。",
    },
    brand: {
      empathetic: "我们接受公开整改，也愿意留下书面记录。",
      neutral: "我们在核实，稍后给一个统一回复。",
      probe_blindspot: "你说的原件，能否先发我们一份？",
      skeptical_push: "这个说法和事实有出入，我们保留追责权利。",
      counter_bluff: "如果继续传播不实信息，我们会走法律流程。",
      rupture: "那今天的沟通就到这里。",
    },
    host: {
      empathetic: "我们愿意公开道歉，并把整改记录留在平台上。",
      neutral: "我们可以谈，但帖子里的描述有夸大。",
      probe_blindspot: "你说的照片，能不能提供原始拍摄时间？",
      skeptical_push: "只靠一张图就定罪，这不公平。",
      counter_bluff: "再这样下去，我们只能走平台申诉。",
      rupture: "那就让平台判吧。",
    },
    skeptic: {
      empathetic: "至少这次时间线对上了，我暂时信一半。",
      neutral: "我还在核时间戳，先不站队。",
      probe_blindspot: "「${said}」这句话的时间点，谁可以证明？",
      skeptical_push: "这份记录少了两页，你们在藏什么？",
      counter_bluff: "我把我这边的原始截图也放出来。",
      rupture: "不用解释了，证据链已经断了。",
    },
    crowd: {
      empathetic: "行吧，至少这次看起来像真的。",
      neutral: "再等等，看看有没有反转。",
      probe_blindspot: "所以到底谁先动的手？",
      skeptical_push: "这波回应太像公关稿了。",
      counter_bluff: "热搜已经上了，你们压不住的。",
      rupture: "翻车了翻车了。",
    },
    silent: {
      empathetic: "如果整改到位，我们愿意继续合作。",
      neutral: "我们暂时不回应。",
      probe_blindspot: "这件事会不会影响到我们这边？",
      skeptical_push: "别把我们拉进你们的公关战。",
      counter_bluff: "如果被点名，我们会把自己的记录放出来。",
      rupture: "合作先停。",
    },
  };
  const pool = map[faction.id] ?? {
    empathetic: "这次我信你一半。",
    neutral: "我还在看。",
    probe_blindspot: "先把最关键的那件事说清楚。",
    skeptical_push: "这个说法站不住。",
    counter_bluff: "那我也把我的牌摊开。",
    rupture: "不必再谈了。",
  };
  const text = pool[stance] ?? pool.neutral;
  return text.replace("${said}", said).slice(0, 80) + (round > 1 && stance === "skeptical_push" ? "（第二次追问）" : "");
}

async function synthesizeDynamicLines(factions, interventionText, timeline) {
  if (!llmConfig().ready) return null;
  try {
    const prompt = [
      `你是一个多阵营社会博弈模拟器。针对干预事件：「${interventionText}」，请为以下每一条推演记录写一句极具张力、贴合阵营公开立场与隐性动机的真实短台词（每句 16~45 字，口语化，不要套话）。`,
      `阵营资料：${JSON.stringify(
        factions.map((f) => ({
          id: f.id,
          name: f.name,
          public_claim: f.public_claim,
          hidden_motive: f.hidden_motive,
        })),
      )}`,
      `推演节点列表（请严格返回 JSON 数组 { "items": [{ "idx": 0, "message": "..." }] }，长度与输入一致）：`,
      JSON.stringify(
        timeline.map((ev, idx) => ({
          idx,
          round: ev.round,
          faction_id: ev.faction_id,
          stance: ev.stance_label,
          ruin: ev.ruin,
        })),
      ),
    ].join("\n");
    const res = await chatJson({
      system: "只输出合法 JSON，包含 items 数组，每个元素含 idx 和 message 字段。",
      user: prompt,
      timeoutMs: 4500,
    });
    if (!res?.ok || !Array.isArray(res.data?.items)) return null;
    const map = new Map();
    for (const item of res.data.items) {
      if (typeof item?.idx === "number" && typeof item?.message === "string" && item.message.trim()) {
        map.set(item.idx, item.message.trim().slice(0, 90));
      }
    }
    return map.size ? map : null;
  } catch {
    return null;
  }
}

export async function simulateAgents({ factions = [], intervention = {}, rounds = 3 } = {}) {
  if (!Array.isArray(factions) || !factions.length) {
    return { ok: false, error: "没有可推演的阵营" };
  }
  const text = String(intervention.text ?? "").trim() || "官方深夜发了一封没有公章的道歉信";
  const normalized = intervention.actor
    ? { ...intervention, text: `${intervention.actor}：${text}` }
    : { ...intervention, text };

  const cleanFactions = factions.slice(0, 8);
  const states = cleanFactions.map((faction) => ({
    faction,
    trust: faction.initial_bias?.trust ?? 3,
    friction: faction.initial_bias?.friction ?? 6,
    paiParentId: "root",
  }));
  const timeline = [];
  const totalRounds = Math.max(1, Math.min(5, Number(rounds) || 3));

  // 检测真实 PAI-SSM 推理桥是否在线（600ms 快速探针）
  const health = await paiHealth();
  const usePai = Boolean(health?.ok);
  let paiHits = 0;

  for (let round = 1; round <= totalRounds; round += 1) {
    for (const state of states) {
      const next = policy(state.faction, normalized, state);
      let stance = next.stance;
      let trust = next.trust;
      let friction = next.friction;
      const threshold = state.faction.initial_bias?.ruin_threshold ?? 8.2;
      let ruin = ruinOf(friction, threshold);
      let stateFingerprint;

      if (usePai) {
        const paiRes = await paiStep({
          text: `[第${round}轮|阵营:${state.faction.name}|表态:${state.faction.public_claim}|底牌:${state.faction.hidden_motive}] 面对干预「${normalized.text}」`,
          parent_id: state.paiParentId,
        });
        if (paiRes?.ok && paiRes.stance) {
          paiHits += 1;
          state.paiParentId = paiRes.node_id || state.paiParentId;
          stance = paiRes.stance;
          if (typeof paiRes.ruin_prob === "number") {
            ruin = clamp(paiRes.ruin_prob * 0.65 + ruin * 0.35, 0, 1);
          }
          if (stance === "rupture") friction = Math.max(friction, threshold);
          else if (stance === "empathetic") trust = clamp(trust + 0.6, 0, 10);
          stateFingerprint = paiRes.state_fingerprint;
        }
      }

      state.trust = trust;
      state.friction = friction;
      timeline.push({
        round,
        faction_id: state.faction.id,
        faction_name: state.faction.name,
        portrait: state.faction.portrait,
        stance,
        stance_label: STANCE_LABEL[stance] ?? stance,
        trust: Number(trust.toFixed(1)),
        friction: Number(friction.toFixed(1)),
        ruin: Number(ruin.toFixed(2)),
        ...(stateFingerprint ? { state_fingerprint: stateFingerprint } : {}),
        message: messageFor(state.faction, stance, normalized, round),
      });
    }
  }

  // LLM 可用时并行润色为紧贴自定义干预的真实台词（超时 4.5s 自动保留本地回应）
  const dynamicLines = await synthesizeDynamicLines(cleanFactions, normalized.text, timeline);
  let llmUsed = false;
  if (dynamicLines) {
    llmUsed = true;
    timeline.forEach((ev, idx) => {
      const msg = dynamicLines.get(idx);
      if (msg) ev.message = msg;
    });
  }

  const provider =
    paiHits > 0 && llmUsed
      ? "pai-ssm+llm"
      : paiHits > 0
        ? "pai-ssm"
        : llmUsed
          ? "llm+local-policy"
          : "local-policy";

  const lastRound = timeline.filter((event) => event.round === Math.max(...timeline.map((item) => item.round)));
  const scores = lastRound.map((event) => STANCE_SCORE[event.stance] ?? 0);
  const mean = scores.reduce((sum, value) => sum + value, 0) / Math.max(1, scores.length);
  const polarization = Math.sqrt(
    scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, scores.length),
  ) / 2;
  const ruinProb = Math.max(...lastRound.map((event) => event.ruin), 0);
  const ruinActors = lastRound.filter((event) => event.stance === "rupture").map((event) => event.faction_name);

  const branches = [
    { id: "evidence", label: "公开完整证据", text: "把原件、时间戳和录音一次放完", risk: "可能把对方逼到决裂" },
    { id: "deal", label: "私下和解", text: "先谈补偿，要求书面整改", risk: "围观者会认为你在私了" },
    { id: "fight", label: "强硬反击", text: "起诉造谣者，拒绝删帖", risk: "舆论彻底炸锅" },
  ].map((branch) => {
    const projected = cleanFactions.map((faction) => {
      const initial = {
        trust: faction.initial_bias?.trust ?? 3,
        friction: faction.initial_bias?.friction ?? 6,
      };
      const next = policy(faction, { text: branch.text }, initial);
      const threshold = faction.initial_bias?.ruin_threshold ?? 8.2;
      return ruinOf(next.friction, threshold);
    });
    return {
      ...branch,
      projected_ruin: Number(Math.max(...projected).toFixed(2)),
    };
  });

  return {
    ok: true,
    provider,
    pai_steps: paiHits,
    intervention: normalized.text,
    timeline,
    metrics: {
      rounds: Math.max(...timeline.map((item) => item.round)),
      polarization: Number(polarization.toFixed(2)),
      ruin_prob: Number(ruinProb.toFixed(2)),
      rupture_actors: ruinActors,
      factions: cleanFactions.length,
    },
    branches,
  };
}
