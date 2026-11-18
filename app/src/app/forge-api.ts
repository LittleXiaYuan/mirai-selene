import type { WorldSpec } from "@/world/spec";
import type { AssetTask } from "./spec-api";

export interface ForgeReply {
  ok: boolean;
  session_id?: string;
  step: number;
  total: number;
  done: boolean;
  question?: string;
  hint?: string;
  chips?: string[];
  greeting?: string;
  reply?: string;
  spec?: WorldSpec;
  tasks?: AssetTask[];
  error?: string;
}

export async function startForge(): Promise<ForgeReply | null> {
  try {
    const res = await fetch("/mirai-api/forge/start", { method: "POST" });
    if (!res.ok) return null;
    return (await res.json()) as ForgeReply;
  } catch {
    return null;
  }
}

export async function forgeTurn(payload: {
  session_id: string;
  text: string;
  tension?: number;
}): Promise<ForgeReply | null> {
  try {
    const res = await fetch("/mirai-api/forge/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await res.json()) as ForgeReply;
  } catch {
    return null;
  }
}
