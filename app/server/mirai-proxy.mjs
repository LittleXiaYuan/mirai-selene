import http from "node:http";

const PORT = Number(process.env.MIRAI_PROXY_PORT || 5280);
const KEY = process.env.MINIMAX_API_KEY || "";
const BASE = process.env.MINIMAX_BASE_URL || "https://api.minimax.chat/v1/chat/completions";
const MODEL = process.env.MINIMAX_MODEL || "MiniMax-Text-01";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

async function chat(messages, { temperature = 0.6, max_tokens = 700 } = {}) {
  if (!KEY) throw new Error("MINIMAX_API_KEY is not set");
  const response = await fetch(BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`MiniMax HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  if (data.base_resp?.status_code) throw new Error(`MiniMax ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
  const content = data.choices?.[0]?.message?.content ?? "";
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function parseJson(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON array in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function parseObject(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

const FALLBACK_BRANCHES = [
  { label: "上海线", route: "shanghai", outcome: "她去了上海，获得了更大的舞台，但和母亲的距离变远。", confidence: 0.62, assumption: "她更在意成长，而不是稳定。" },
  { label: "考研线", route: "kaoyan", outcome: "她留下来读研，路径更稳，但会反复怀疑自己是不是在躲。", confidence: 0.48, assumption: "导师的支持能抵消她对“逃避”的恐惧。" },
  { label: "青岛线", route: "qingdao", outcome: "她留在青岛，关系更近，但“如果当时”会长期回响。", confidence: 0.55, assumption: "她愿意用可能性换取确定性。" },
];

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/health" || req.url === "/api/mirai/health")) {
    json(res, 200, { ok: true, model: MODEL, key: Boolean(KEY) });
    return;
  }

  if (req.method !== "POST") {
    json(res, 404, { error: "Not found" });
    return;
  }

  try {
    if (req.url === "/api/mirai/chat") {
      const body = await readBody(req);
      const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
      const content = await chat(messages, { temperature: 0.7, max_tokens: 500 });
      json(res, 200, { content });
      return;
    }

    if (req.url === "/api/mirai/predict") {
      const body = await readBody(req);
      const world = body.world ?? {};
      const intervention = String(body.intervention ?? "").slice(0, 200);
      const cast = (world.characters ?? []).slice(0, 8).map((c) => `${c.name}（${c.role}）：${c.traits}`).join("；");
      const specs = [
        { route: "shanghai", label: "上海线", action: "去上海工作" },
        { route: "kaoyan", label: "考研线", action: "留校读研" },
        { route: "qingdao", label: "青岛线", action: "回青岛或留在青岛" },
      ];
      const branches = [];
      for (const spec of specs) {
        const fallback = FALLBACK_BRANCHES.find((item) => item.route === spec.route) ?? FALLBACK_BRANCHES[0];
        try {
          const text = await chat([
            { role: "system", content: "你是 Mirai-Selene 的世界模型推演引擎。只输出一个严格 JSON 对象，不写解释。" },
            { role: "user", content: [
              `世界：${world.name ?? "未命名"}。`,
              `梗概：${world.summary ?? ""}`,
              `角色：${cast}`,
              `干预：${intervention}`,
              `请只写「${spec.label}」：林夏${spec.action}之后的世界。`,
              `严格输出 {"label":"${spec.label}","route":"${spec.route}","outcome":"一句话结局","confidence":0.6,"assumption":"关键假设"}。`,
              "不要输出 markdown，不要解释。",
            ].join("\n") },
          ], { temperature: 0.5, max_tokens: 320 });
          const parsed = parseObject(text);
          branches.push({
            label: spec.label,
            route: spec.route,
            outcome: String(parsed.outcome ?? fallback.outcome).slice(0, 160),
            confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || fallback.confidence)),
            assumption: String(parsed.assumption ?? fallback.assumption).slice(0, 120),
          });
        } catch {
          branches.push(fallback);
        }
      }
      json(res, 200, { branches });
      return;
    }

    if (req.url === "/api/mirai/extract") {
      const body = await readBody(req);
      const text = String(body.text ?? "").slice(0, 4000);
      const prompt = [
        "从下面的文字里抽取角色。严格输出 JSON 数组，最多 6 个，每项包含 name、role、traits（一句话）。",
        "不要输出 markdown，不要解释，只输出 JSON。",
        `文字：\n${text}`,
      ].join("\n");
      let characters;
      try {
        const output = await chat([
          { role: "system", content: "你是 Mirai-Selene 的世界导入器。你只输出严格 JSON。" },
          { role: "user", content: prompt },
        ], { temperature: 0.3, max_tokens: 700 });
        const parsed = parseJson(output);
        characters = parsed.slice(0, 6).map((item) => ({
          name: String(item.name ?? "角色").slice(0, 20),
          role: String(item.role ?? "角色").slice(0, 30),
          traits: String(item.traits ?? "").slice(0, 80),
        }));
        if (!characters.length) throw new Error("No characters");
      } catch {
        characters = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 6).map((line, index) => {
          const parts = line.replace(/^[-*]\s*/, "").split(/[：:，,]/).map((part) => part.trim()).filter(Boolean);
          return { name: parts[0] || `角色 ${index + 1}`, role: parts[1] || "角色", traits: parts.slice(2).join("，") || "待补充" };
        });
      }
      json(res, 200, { characters });
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mirai proxy on http://127.0.0.1:${PORT} · model ${MODEL} · key ${KEY ? "set" : "missing"}`);
});
