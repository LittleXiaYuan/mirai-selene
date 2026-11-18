import type { WorldSpec } from "@/world/spec";

export interface SocialComment {
  text: string;
  likes?: number;
  intent?: string;
}

export interface SocialSnapshot {
  title: string;
  body: string;
  tags: string[];
  comments: SocialComment[];
  source_type: string;
  source_url: string;
  polarization: number;
  note?: string;
}

export interface FactionAgent {
  id: string;
  name: string;
  role: string;
  portrait: string;
  public_claim: string;
  hidden_motive: string;
  initial_bias: { trust: number; friction: number; ruin_threshold: number };
}

export interface IngestResult {
  ok: boolean;
  fetched: boolean;
  fallback: boolean;
  provider: string;
  faction_source?: "llm" | "archetype";
  snapshot: SocialSnapshot;
  factions: FactionAgent[];
  spec: WorldSpec;
  run_id?: string;
  error?: string;
}

export interface SimEvent {
  round: number;
  faction_id: string;
  faction_name: string;
  portrait: string;
  stance: string;
  stance_label: string;
  trust: number;
  friction: number;
  ruin: number;
  message: string;
}

export interface SimResult {
  ok: boolean;
  provider: string;
  intervention: string;
  timeline: SimEvent[];
  metrics: {
    rounds: number;
    polarization: number;
    ruin_prob: number;
    rupture_actors: string[];
    factions: number;
  };
  branches: { id: string; label: string; text: string; risk: string; projected_ruin: number }[];
  run_id?: string;
  error?: string;
}

export interface AgentRun {
  id: string;
  kind: "ingest" | "simulate" | "forge" | string;
  title: string;
  created_at: string;
}

export async function loadAgentRuns(): Promise<AgentRun[]> {
  try {
    const res = await fetch("/mirai-api/agent/runs", { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { runs?: AgentRun[] };
    return data.runs ?? [];
  } catch {
    return [];
  }
}

export async function getAgentRun(id: string): Promise<{ kind: string; input: unknown; output: unknown } | null> {
  try {
    const res = await fetch(`/mirai-api/agent/runs/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { run?: { kind: string; input: unknown; output: unknown } };
    return data.run ?? null;
  } catch {
    return null;
  }
}

export async function ingestSocial(payload: {
  url?: string;
  text?: string;
  player_faction?: string;
}): Promise<IngestResult | null> {
  try {
    const res = await fetch("/mirai-api/ingest/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return (await res.json()) as IngestResult;
  } catch {
    return null;
  }
}

export async function simulateAgents(payload: {
  factions: FactionAgent[];
  intervention: { text: string; actor?: string };
  rounds?: number;
  /** 父摄取作业，回放时用来把快照和阵营一起恢复。 */
  ingest_run_id?: string;
}): Promise<SimResult | null> {
  try {
    const res = await fetch("/mirai-api/agent/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return (await res.json()) as SimResult;
  } catch {
    return null;
  }
}

export async function loadSocialCases(): Promise<{ id: string; title: string; tags: string[]; source_type: string; source_url: string }[]> {
  try {
    const res = await fetch("/mirai-api/ingest/cases", { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { cases?: { id: string; title: string; tags: string[]; source_type: string; source_url: string }[] };
    return data.cases ?? [];
  } catch {
    return [];
  }
}
