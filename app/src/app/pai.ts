/**
 * PAI-SSM 推理桥的前端客户端。
 *
 * 前端不做任何矩阵运算：这里只把「一句话 + 12 维韵律」递过去，
 * 拿回反讨好姿态、生死分位数与盲区追问。桥没起来时一律返回 null，
 * 调用方退回本地确定性分支 —— 台上不能因为少开一个进程就白屏。
 */

export type Stance =
  | "empathetic"
  | "neutral"
  | "probe_blindspot"
  | "skeptical_push"
  | "counter_bluff"
  | "rupture";

export interface PaiStep {
  ok: true;
  node_id: string;
  parent_id?: string;
  state_fingerprint?: string;
  latency_ms?: number;
  bridge_ms?: number;
  stance: Stance;
  model_stance?: Stance;
  stance_probs?: Record<Stance, number>;
  alarm_override?: Stance | null;
  incongruence?: number;
  epistemic_variance?: number;
  quantiles?: {
    q10: number;
    q30: number;
    q50: number;
    q70: number;
    q90: number;
    spread: number;
  };
  ruin_prob?: number;
  active_probe?: { best_index: number; best_probe: string; eig_nats: number[] } | null;
}

export interface PaiMerge {
  ok: true;
  node_id: string;
  state_fingerprint?: string;
  commutativity_max_diff: number;
  latency_ms?: number;
  bridge_ms?: number;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(`/mirai-api/pai/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean } & T;
    return data?.ok ? data : null;
  } catch {
    return null;
  }
}

export function paiStep(
  payload: {
    text: string;
    prosody?: number[] | null;
    parent_id?: string;
    node_id?: string;
    candidate_probes?: string[];
  },
  signal?: AbortSignal,
) {
  return post<PaiStep>("step", payload, signal);
}

export function paiMerge3(payload: { left_id: string; right_id: string; base_id?: string }) {
  return post<PaiMerge>("merge3", payload);
}

export async function paiHealth(): Promise<{ ok: boolean; device?: string; params?: number } | null> {
  try {
    const res = await fetch("/mirai-api/pai/health");
    if (!res.ok) return null;
    return (await res.json()) as { ok: boolean; device?: string; params?: number };
  } catch {
    return null;
  }
}
