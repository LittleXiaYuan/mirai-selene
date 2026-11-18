import type { WorldSpec } from "@/world/spec";

/** 服务端世界仓库的客户端：热重载、资产任务单。全部走 /mirai-api，前端不碰文件系统。 */

export interface SpecEnvelope {
  ok: boolean;
  version: number;
  spec: WorldSpec | null;
  updated_at: number;
}

export interface AssetTask {
  id: string;
  kind: "background" | "portrait";
  asset_key: string;
  cast_id?: string;
  emotion?: string;
  target: string;
  aspect: string;
  size: string;
  prompt: string;
  negative: string;
}

export async function fetchCurrentSpec(): Promise<SpecEnvelope | null> {
  try {
    const res = await fetch("/mirai-api/spec/current", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as SpecEnvelope;
  } catch {
    return null;
  }
}

export async function pushSpec(spec: WorldSpec): Promise<{ ok: boolean; version?: number; errors?: string[] }> {
  try {
    const res = await fetch("/mirai-api/spec/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec }),
    });
    return (await res.json()) as { ok: boolean; version?: number; errors?: string[] };
  } catch {
    return { ok: false, errors: ["连不上服务端"] };
  }
}

export async function planAssets(body: {
  theme?: string;
  title?: string;
  spec?: WorldSpec;
}): Promise<{ ok: boolean; spec?: WorldSpec; tasks?: AssetTask[]; provider?: string; errors?: string[] }> {
  try {
    const res = await fetch("/mirai-api/assets/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as {
      ok: boolean;
      spec?: WorldSpec;
      tasks?: AssetTask[];
      provider?: string;
      errors?: string[];
    };
  } catch {
    return { ok: false, errors: ["连不上资产工厂"] };
  }
}

export async function generateAsset(task: AssetTask): Promise<{ ok: boolean; url?: string; reason?: string }> {
  try {
    const res = await fetch("/mirai-api/assets/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task }),
    });
    return (await res.json()) as { ok: boolean; url?: string; reason?: string };
  } catch {
    return { ok: false, reason: "连不上资产工厂" };
  }
}
