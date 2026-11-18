/**
 * Agent 层冒烟：现实摄取、阵营拆解、多 Agent 推演、SSRF 防护。
 * 需要先起 serve.mjs（默认 http://127.0.0.1:8080）。
 */

const BASE = process.env.MIRAI_BASE || "http://127.0.0.1:8080";

const checks = [];
function ok(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path, body, raw = false) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: raw ? await res.text() : await res.json().catch(() => null) };
}

async function main() {
  const cases = await get("/mirai-api/ingest/cases");
  ok("内置快照", cases.status === 200 && Array.isArray(cases.body?.cases) && cases.body.cases.length >= 3);

  const ingest = await post("/mirai-api/ingest/social", {
    url: "https://www.xiaohongshu.com/explore/apology-3am",
  });
  const result = ingest.body;
  ok("摄取返回 Spec", ingest.status === 200 && result?.ok === true && Boolean(result.spec));
  ok("阵营 3–5 个", result?.factions?.length >= 3 && result.factions.length <= 5, String(result?.factions?.length));
  ok("表层话术与底牌", Boolean(result?.factions?.[0]?.public_claim) && Boolean(result?.factions?.[0]?.hidden_motive));
  ok("Spec 至少 5 幕", result?.spec?.logic_nodes?.length >= 5, String(result?.spec?.logic_nodes?.length));
  const ids = new Set(result?.spec?.logic_nodes?.map((node) => node.id) ?? []);
  const targetsValid = (result?.spec?.logic_nodes ?? []).every((node) =>
    (node.choices ?? []).every((choice) => ids.has(choice.to)),
  );
  ok("选项引用完整", targetsValid);

  const sim = await post("/mirai-api/agent/simulate", {
    factions: result?.factions ?? [],
    intervention: { text: "官方发道歉信但避谈赔偿" },
    rounds: 3,
  });
  ok("推演返回时间线", sim.body?.ok === true && sim.body.timeline?.length >= (result?.factions?.length ?? 0) * 3);
  ok("推演有失控/极化", Number.isFinite(sim.body?.metrics?.ruin_prob) && Number.isFinite(sim.body?.metrics?.polarization));
  ok("三条干预分支", sim.body?.branches?.length === 3);
  ok("分支预测不全是 100%", new Set(sim.body?.branches?.map((branch) => branch.projected_ruin)).size > 1);

  const ssrf = await post("/mirai-api/ingest/social", { url: "http://127.0.0.1:8080/" });
  ok("拦截内网地址", ssrf.status === 400);

  const failed = checks.filter((check) => !check.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
