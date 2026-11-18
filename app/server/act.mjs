/**
 * 世界模型的一次「演出」：玩家随便写一句，世界当场生成下一幕。
 *
 * 为什么流式：固定脚本的视觉小说是"翻页"，世界模型应该是"正在发生"。
 *
 * 两段式，而不是一次调用吐正文+JSON：
 *   1) 流式写这一幕（不要求 JSON，模型更容易写好）；
 *   2) 正文写完后，用同一段文字抽地点/时间/氛围/记忆/建议。
 * 一次调用要求模型既写散文又守 JSON 格式，实测经常丢格式。
 *
 * 协议（SSE）：
 *   event: delta    {"text"}                   正文，逐段推送
 *   event: scene    {"place","time","mood","weather"}
 *   event: suggest  {"items":[...]}
 *   event: done     {"memory":{"key","value"}}
 *   event: error    {"message"}
 */

const NARRATE_SYS = [
  "你在演一个具体的人的一刻。第二人称，写动作、光线、声音、身体反应。",
  "禁止写总结、评论、主题升华；禁止出现「选择」「分支」「系统」「世界线」这些词。",
  "禁止引入与这个世界无关的物件和场景（钟楼、怀表、废墟、魔法）。",
  "只写这一幕的正文，不要标题，不要 markdown，不要解释。",
].join("\n");

function narratePrompt(world, memories, action) {
  return [
    `世界：${world?.name ?? "未命名"}。${world?.hook ?? ""}`,
    (world?.characters ?? [])
      .slice(0, 6)
      .map((c) => `- ${c.name}（${c.role}）：${c.traits}`)
      .join("\n"),
    "",
    memories.length
      ? `她已经在意的：${memories.map((m) => `${m.key}(${m.value})`).join("、")}`
      : "她还没有特别在意的事。",
    "",
    `刚刚发生：${action}`,
    "",
    "写这一幕，180 到 260 字，分 2 到 3 段。从上一个动作的直接后果写起，不要重新介绍人物。",
  ].join("\n");
}

function extractPrompt(world, narration, action) {
  return [
    "把这一幕压成结构化字段。只输出一个 JSON 对象，不要 markdown 代码块。",
    `世界：${world?.name ?? ""}`,
    `动作：${action}`,
    `正文：${narration.slice(0, 700)}`,
    "",
    '输出：{"place":"地点，六个字以内","time":"清晨|正午|黄昏|深夜 之一","mood":"安静|紧绷|疏离|温柔 之一",',
    '      "weather":"晴|阴|雨|雾 之一","memory":{"key":"这一幕留下的记忆，四个字以内","value":0到10},',
    '      "suggestions":["下一步能做什么，第一人称短句，12字以内","...","...","..."]}',
    "suggestions 给 4 条，一条激进、一条保守、一条关于别人、一条关于她自己。",
  ].join("\n");
}

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
}

function send(res, event, data) {
  if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamChat({ key, base, model, messages, onDelta, signal, maxTokens = 700, temperature = 0.85 }) {
  const upstream = await fetch(base, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
    signal,
  });
  if (!upstream.ok || !upstream.body) throw new Error(`upstream ${upstream.status}`);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    const lines = raw.split("\n");
    raw = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let piece = "";
      try {
        piece = JSON.parse(payload).choices?.[0]?.delta?.content ?? "";
      } catch {
        continue;
      }
      if (!piece) continue;
      text += piece;
      await onDelta(piece);
    }
  }
  return text;
}

async function plainChat({ key, base, model, messages, maxTokens = 320, temperature = 0.4 }) {
  const res = await fetch(base, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const content = data.choices?.[0]?.message?.content ?? "";
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export async function handleAct(req, res, { key, base, model, readBody }) {
  const body = await readBody(req);
  const action = String(body.action ?? "").slice(0, 300) || "她什么也没做。";
  const world = body.world ?? {};
  const memories = Array.isArray(body.memories) ? body.memories.slice(0, 12) : [];

  sseHead(res);

  // 没有 key：给一段和输入相关、确定性的回应，不白屏
  if (!key) {
    const fallback = `${action.replace(/[。！？\s]+$/, "")}。她做这件事的时候，屋子里的声音轻了一下，像世界在把这句话记下来。`;
    for (const chunk of fallback.match(/.{1,12}/g) ?? []) {
      send(res, "delta", { text: chunk });
      await new Promise((r) => setTimeout(r, 26));
    }
    send(res, "scene", { place: "此刻的房间", time: "黄昏", mood: "安静", weather: "阴" });
    send(res, "suggest", {
      items: ["先看看四周", "叫一声她的名字", "什么也不做", "往门外走"],
    });
    send(res, "done", { memory: { key: "停顿", value: 3 }, offline: true });
    res.end();
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75_000);
  let narration = "";

  try {
    narration = await streamChat({
      key,
      base,
      model,
      messages: [
        { role: "system", content: NARRATE_SYS },
        { role: "user", content: narratePrompt(world, memories, action) },
      ],
      signal: controller.signal,
      onDelta: async (piece) => send(res, "delta", { text: piece }),
    });

    if (!narration.trim()) throw new Error("模型没有返回正文");

    // 第二段：抽结构化字段。失败也不影响正文，只少了场景和建议。
    let meta = null;
    try {
      const raw = await plainChat({
        key,
        base,
        model,
        messages: [
          { role: "system", content: "你只输出一个 JSON 对象，不写解释。" },
          { role: "user", content: extractPrompt(world, narration, action) },
        ],
      });
      const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start !== -1 && end !== -1) meta = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      meta = null;
    }

    if (meta) {
      send(res, "scene", {
        place: String(meta.place ?? "未名的地点").slice(0, 12),
        time: String(meta.time ?? "黄昏").slice(0, 6),
        mood: String(meta.mood ?? "安静").slice(0, 6),
        weather: String(meta.weather ?? "阴").slice(0, 4),
      });
      if (Array.isArray(meta.suggestions) && meta.suggestions.length) {
        // 每条建议尽量带上它会留下的记忆，前端才能算"这一步会把她推向哪"
        send(res, "suggest", {
          items: meta.suggestions.slice(0, 4).map((s) => {
            const o = typeof s === "string" ? { text: s } : (s ?? {});
            const text = String(o.text ?? "").slice(0, 30);
            const key = o.key
              ? String(o.key).slice(0, 12)
              : text.replace(/[，。！？、\s]/g, "").slice(0, 4) || "下一步";
            const value =
              typeof o.value === "number" && Number.isFinite(o.value)
                ? Math.max(0, Math.min(10, Math.round(o.value)))
                : 6;
            return { text, key, value };
          }).filter((x) => x.text),
        });
      }
      send(res, "done", {
        memory: {
          key: String(meta.memory?.key ?? "这一刻").slice(0, 8),
          value: Math.max(0, Math.min(10, Number(meta.memory?.value) || 4)),
        },
      });
    } else {
      send(res, "done", { memory: { key: "这一幕", value: 4 } });
    }
  } catch (error) {
    send(res, "error", {
      message: error instanceof Error ? error.message : "生成失败",
    });
  } finally {
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  }
}
