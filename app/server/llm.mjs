/**
 * 统一的 LLM 入口：OpenAI 兼容协议。
 *
 * 为什么单开一层：
 *   · 小浣熊网页端只有登录态内部接口，对外可编程接入走商汤 SenseNova；
 *   · SenseNova 的 compatible-mode 就是 OpenAI 协议，换 base_url 就能切；
 *   · 没有 key 时必须安静地返回 no-key，让调用方回退模板，而不是抛异常。
 *
 * 环境变量优先级（从左到右）：
 *   PLANNER_BASE_URL / PLANNER_API_KEY / PLANNER_MODEL
 *   然后 SENSENOVA_* / YUNQUE_* / MINIMAX_*
 */

const DEFAULT_BASE = "https://api.sensenova.cn/compatible-mode/v1";
const DEFAULT_MODEL = "SenseChat-5";

function pick(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function llmConfig() {
  if (process.env.MIRAI_DISABLE_LLM === "1") {
    return { base: "", key: "", model: DEFAULT_MODEL, url: "", host: "", ready: false };
  }
  // key 与 base 必须来自同一家，否则会拿 A 家的 key 打 B 家的地址
  const providers = [
    { key: process.env.PLANNER_API_KEY, base: process.env.PLANNER_BASE_URL, model: process.env.PLANNER_MODEL },
    { key: process.env.SENSENOVA_API_KEY, base: process.env.SENSENOVA_BASE_URL, model: process.env.SENSENOVA_CHAT_MODEL },
    { key: process.env.YUNQUE_API_KEY, base: process.env.YUNQUE_BASE_URL, model: process.env.YUNQUE_MODEL },
    { key: process.env.MINIMAX_API_KEY, base: process.env.MINIMAX_BASE_URL, model: process.env.MINIMAX_MODEL },
  ].find((provider) => pick(provider.key));

  const base = pick(providers?.base) || (providers ? DEFAULT_BASE : "");
  const key = pick(providers?.key);
  const model = pick(providers?.model) || DEFAULT_MODEL;
  const url = base
    ? base.includes("/chat/completions")
      ? base
      : `${base.replace(/\/+$/, "")}/chat/completions`
    : "";
  let host = "";
  try {
    host = url ? new URL(url).host : "";
  } catch {
    host = "invalid";
  }
  return { base, key, model, url, host, ready: Boolean(key && url) };
}

export function parseJsonObject(text) {
  const cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 一次 JSON 生成。返回结构固定，调用方只判断 ok。
 * `validate(data)` 返回 true 或一句失败原因。
 */
export async function chatJson({
  system = "只输出合法的 JSON，不解释，不使用 markdown。",
  user,
  temperature = 0.7,
  maxTokens = 2000,
  timeoutMs = 45_000,
  validate,
} = {}) {
  const config = llmConfig();
  const started = Date.now();
  if (!config.ready) {
    return { ok: false, reason: "no-key", error: "没有配置 LLM key", model: config.model, provider: config.host, ms: 0 };
  }
  if (!user) {
    return { ok: false, reason: "no-prompt", error: "缺少 user prompt", model: config.model, provider: config.host, ms: 0 };
  }

  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        reason: "http",
        status: res.status,
        error: raw.slice(0, 300),
        model: config.model,
        provider: config.host,
        ms: Date.now() - started,
      };
    }
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "envelope", error: raw.slice(0, 200), model: config.model, provider: config.host, ms: Date.now() - started };
    }
    const content = payload?.choices?.[0]?.message?.content ?? "";
    const data = parseJsonObject(content);
    if (!data) {
      return { ok: false, reason: "parse", error: String(content).slice(0, 200), model: config.model, provider: config.host, ms: Date.now() - started };
    }
    if (validate) {
      const verdict = validate(data);
      if (verdict !== true) {
        return {
          ok: false,
          reason: "invalid",
          error: typeof verdict === "string" ? verdict : "JSON 不符合约束",
          model: config.model,
          provider: config.host,
          ms: Date.now() - started,
        };
      }
    }
    return { ok: true, data, model: config.model, provider: config.host, ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      reason: "network",
      error: error instanceof Error ? error.message : String(error),
      model: config.model,
      provider: config.host,
      ms: Date.now() - started,
    };
  }
}
