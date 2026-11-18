/**
 * 走完之后，把这段经历读成话。
 *
 * 注意边界：这里**不算预测**。预测是引擎算的（状态差值、读数），
 * 这部分只是语言模型根据走过的事给出措辞，帮助人把经历说清楚。
 * 之前它承担的「最可能怎样」已经撤掉 —— 实测它给的是通用建议和假精度，
 * 假精度比没有更伤可信度。
 */

const SYSTEM = [
  "你是 Mirai-Selene 的判断层。玩家已经在一个世界里替主角走过一段，",
  "你的任务是把这段经历压成可用的判断，而不是复述剧情。",
  "",
  "要求：",
  "1. 只依据给出的世界、走过的事、留下的记忆。不要引入外部事实。",
  "2. 每条判断要具体到这件事、这个人，不能是通用建议。",
  "3. 不确定就说不确定，不要编。",
  "4. 只输出一个 JSON 对象，不要 markdown 代码块，不要解释。",
].join("\n");

function buildPrompt(payload) {
  const world = payload.world ?? {};
  const path = Array.isArray(payload.path) ? payload.path.slice(-14) : [];
  const memories = Array.isArray(payload.memories) ? payload.memories.slice(0, 10) : [];
  const lanes = Array.isArray(payload.lanes) ? payload.lanes : [];

  return [
    `世界：${world.name ?? "未命名"}。${world.hook ?? ""}`,
    (world.characters ?? [])
      .slice(0, 5)
      .map((c) => `- ${c.name}（${c.role}）：${c.traits}`)
      .join("\n"),
    "",
    "走过的事（按顺序）：",
    ...path.map((p, i) => `${i + 1}. ${String(p.label ?? "").slice(0, 60)}${p.narration ? ` —— ${String(p.narration).slice(0, 120)}` : ""}`),
    "",
    memories.length
      ? `她留下了这些记忆：${memories.map((m) => `${m.key}(${m.value})`).join("、")}`
      : "她还没有留下明显的记忆。",
    "",
    lanes.length > 1 ? `同时观察了 ${lanes.length} 条线：${lanes.map((l) => l.label).join("、")}` : "",
    "",
    "输出 JSON：",
    "{",
    '  "likely": "按现在这样走下去，最可能发生什么。一句话，40 字内，具体。",',
    '  "assumptions": ["这个判断依赖的前提，2 到 3 条，每条 20 字内"],',
    '  "sensitivity": [{"change": "如果改变什么，20 字内", "effect": "结果会怎么变，30 字内"}],',
    '  "risks": ["最该注意的一件事，1 到 2 条，每条 25 字内"],',
    '  "advice": "如果只给一句建议，是什么。30 字内。",',
    "}",
    "sensitivity 给 2 条，要指向具体变量（某个人、某个决定、某个时间点），不要写「保持沟通」这类空话。",
    "不要写百分比、不要写「提高 X% 可能性」这类假精度 —— 你给不出概率。",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 去掉控制字符和替换符（模型偶尔吐出乱码）。逐字符判断，避开正则里的转义坑。 */
function clean(text, max) {
  const src = String(text ?? "");
  let out = "";
  for (const ch of src) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || code === 0xfffd) continue;
    out += ch;
  }
  return out.trim().slice(0, max);
}

function parseObject(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no json");
  return JSON.parse(cleaned.slice(start, end + 1));
}

const EMPTY_VERDICT = {
  likely: "",
  assumptions: [],
  sensitivity: [],
  risks: [],
  advice: "",
  offline: true,
};

export async function handleJudge(req, res, { key, base, model, readBody }) {
  const send = (status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(body));
  };

  let payload;
  try {
    payload = await readBody(req, 400_000);
  } catch {
    send(400, { error: "bad body", verdict: EMPTY_VERDICT });
    return;
  }

  if (!key) {
    send(200, { verdict: EMPTY_VERDICT });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  try {
    const upstream = await fetch(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: buildPrompt(payload) },
        ],
        temperature: 0.2,
        max_tokens: 700,
      }),
      signal: controller.signal,
    });
    const data = await upstream.json().catch(() => ({}));
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!upstream.ok || !text) throw new Error(`upstream ${upstream.status}`);

    const parsed = parseObject(text);
    const verdict = {
      likely: clean(parsed.likely, 80),
      assumptions: (Array.isArray(parsed.assumptions) ? parsed.assumptions : [])
        .slice(0, 3)
        .map((s) => clean(s, 40)).filter(Boolean),
      sensitivity: (Array.isArray(parsed.sensitivity) ? parsed.sensitivity : [])
        .slice(0, 3)
        .map((s) => ({
          change: clean(s?.change, 40),
          effect: clean(s?.effect, 60),
        }))
        .filter((s) => s.change && s.effect),
      risks: (Array.isArray(parsed.risks) ? parsed.risks : []).slice(0, 2).map((s) => String(s).slice(0, 50)),
      advice: clean(parsed.advice, 60),
    };

    send(200, { verdict });
  } catch (error) {
    send(200, {
      verdict: EMPTY_VERDICT,
      reason: error instanceof Error ? error.message : "failed",
    });
  } finally {
    clearTimeout(timer);
  }
}
