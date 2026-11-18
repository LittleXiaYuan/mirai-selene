import type { WorldSpec } from "@/world/spec";

/** 把一份 Spec 交给服务端，拿回一个可直接运行的单文件 H5 游戏壳。 */
export async function shellHtml(spec: WorldSpec): Promise<string | null> {
  try {
    const res = await fetch("/mirai-api/game/shell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec }),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function downloadShell(spec: WorldSpec): Promise<boolean> {
  const html = await shellHtml(spec);
  if (!html) return false;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${spec.id || "world"}.html`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 20_000);
  return true;
}

/** 预览壳子的视觉；若要看真实推演，发布后用 /game/current。 */
export async function previewShell(spec: WorldSpec): Promise<boolean> {
  const html = await shellHtml(spec);
  if (!html) return false;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  window.open(url, "_blank", "noopener");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
