/**
 * PAI-SSM 本地推理桥（127.0.0.1:5290）的代理层。
 *
 * 为什么必须走服务端代理：
 *   · 浏览器直接连 5290 会撞 CORS 和混合内容，现场换机器还得改前端；
 *   · 桥没起来时前端必须拿到一个「可降级」的答复，而不是 500 白屏。
 * 所以这里只在桥可用时透传 JSON，其余情况一律回 `{ ok: false, degraded: true }`。
 */

const BASE = (process.env.PAI_BASE || "http://127.0.0.1:5290").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.PAI_TIMEOUT_MS || 1500);

async function call(path, body) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error(data?.error ?? `PAI-SSM ${res.status}`);
    return { ...data, bridge_ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      degraded: true,
      error: error instanceof Error ? error.message : String(error),
      bridge_ms: Date.now() - started,
    };
  }
}

export const paiStep = (body) => call("/step", body);
export const paiMerge3 = (body) => call("/merge3", body);

export async function paiHealth() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(600) });
    return await res.json();
  } catch {
    return { ok: false, degraded: true, base: BASE };
  }
}
