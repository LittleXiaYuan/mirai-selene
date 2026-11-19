/**
 * 现实吞噬器：小红书 / 抖音 / 任意热帖 → 快照 → 阵营 Agent → World-Spec。
 *
 * 这里不依赖训练中的模型：
 *   · 先真实抓取页面（标题/描述/标签）；
 *   · 抓不到时使用内置高保真快照，现场不怕反爬；
 *   · 阵营拆解优先 LLM（server/llm.mjs，SenseNova 兼容接口），
 *     没有 key、超时或 JSON 不合格时回退本地原型 Archetypes + 评论意图；
 *   · 输出仍是 v1 渲染器能吃的 Spec，同时带上 factions / social_pulse 供 Agent 沙盘使用。
 */

import { chatJson } from "./llm.mjs";
import { fetchXhsNote, xhsConfigured } from "./xhs.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const CASES = [
  {
    id: "xhs-apology-3am",
    source_type: "xiaohongshu",
    source_url: "https://www.xiaohongshu.com/explore/apology-3am",
    title: "凌晨三点的致歉信，该不该发",
    body:
      "品牌被曝质检报告造假后沉默了 36 小时，凌晨三点突然发出一封没有公章的致歉信，评论区已经吵翻了。",
    tags: ["#避雷", "#品牌公关", "#质检报告", "#凌晨三点"],
    comments: [
      { text: "避重就轻，质检报告原件敢晒出来吗？", likes: 4821, intent: "skeptic" },
      { text: "人家都道歉了还想怎样，差不多得了", likes: 930, intent: "brand" },
      { text: "我就是买了同批次的，现在只想退货", likes: 2600, intent: "victim" },
      { text: "等一个反转，感觉还有第二段录音", likes: 1510, intent: "crowd" },
      { text: "供应商那边到现在一句话没说", likes: 420, intent: "silent" },
    ],
    factions: [
      { id: "victim", name: "维权当事人·林夏", role: "买家 / 维权方", portrait: "linxia", public_claim: "只求一个公开透明的说法", hidden_motive: "手里还留着同批次检测报告，等品牌先撒谎再放出来", trust: 2.1, friction: 7.8, ruin: 8.5 },
      { id: "brand", name: "品牌公关·陈总", role: "品牌方", portrait: "mentor", public_claim: "我们已经在彻查，请大家给一点时间", hidden_motive: "先把周末拖过去，等热度掉下来再谈赔偿", trust: 4.2, friction: 5.4, ruin: 8.0 },
      { id: "skeptic", name: "理性考据党·周屿", role: "围观考据", portrait: "selene", public_claim: "我只认时间戳和原件", hidden_motive: "想验证致歉信到底是不是凌晨三点发的，还是提前写好的", trust: 3.4, friction: 6.1, ruin: 7.6 },
      { id: "crowd", name: "情绪吃瓜·小满", role: "吃瓜群众", portrait: "mother", public_claim: "等一个反转，越大越好", hidden_motive: "并不关心谁对谁错，只想看品牌当场翻车", trust: 2.8, friction: 8.2, ruin: 9.0 },
      { id: "silent", name: "沉默利益方·供应商", role: "供应链", portrait: "mentor", public_claim: "我们不方便回应", hidden_motive: "怕被品牌甩锅，已经在准备自己的出库记录", trust: 3.0, friction: 4.6, ruin: 7.2 },
    ],
  },
  {
    id: "douyin-partner-last-night",
    source_type: "douyin",
    source_url: "https://www.douyin.com/video/partner-last-night",
    title: "合伙人散伙前夜，他把密钥改了",
    body:
      "联合创始人半夜改掉生产库密钥，第二天投资人尽调，技术合伙人只留下一句「你自己讲」。",
    tags: ["#创业", "#合伙人", "#尽调", "#密钥"],
    comments: [
      { text: "改密钥这事一旦坐实，信任就没了", likes: 3100, intent: "skeptic" },
      { text: "投资人只看数据，谁讲不重要", likes: 870, intent: "silent" },
      { text: "创业公司千万别两个人都是技术", likes: 1900, intent: "crowd" },
      { text: "先看谁在撒谎，密钥不是重点", likes: 1200, intent: "victim" },
    ],
    factions: [
      { id: "founder", name: "CEO·你", role: "创始人", portrait: "linxia", public_claim: "密钥只是临时安全措施", hidden_motive: "账上只剩六周，不能让投资人看到真实权限结构", trust: 3.2, friction: 6.4, ruin: 8.4 },
      { id: "cto", name: "技术合伙人·周屿", role: "合伙人", portrait: "mentor", public_claim: "我只想要一个说法", hidden_motive: "已经备份了代码和离职信，只等对方先摊牌", trust: 4.0, friction: 7.2, ruin: 8.8 },
      { id: "investor", name: "投资人·陈总", role: "投资人", portrait: "selene", public_claim: "我们只看治理结构", hidden_motive: "如果团队分裂，估值可以再压两成", trust: 3.5, friction: 5.0, ruin: 7.4 },
      { id: "crowd", name: "员工群·小满", role: "员工", portrait: "mother", public_claim: "别影响发工资就行", hidden_motive: "已经在改简历，但还想等年终奖", trust: 2.6, friction: 6.8, ruin: 8.0 },
    ],
  },
  {
    id: "xhs-homestay",
    source_type: "xiaohongshu",
    source_url: "https://www.xiaohongshu.com/explore/homestay",
    title: "民宿避雷：床单有血渍，老板让我删帖",
    body:
      "入住当晚发现床单有血渍，拍照发帖后老板私信说可以免单，但要先把帖子删了。",
    tags: ["#民宿避雷", "#消费者权益", "#卫生"],
    comments: [
      { text: "免单就想删帖？至少得道歉和整改", likes: 5200, intent: "victim" },
      { text: "先别删，保留证据报警", likes: 3400, intent: "skeptic" },
      { text: "这种店就该挂出来", likes: 2800, intent: "crowd" },
      { text: "平台也有责任吧", likes: 1100, intent: "silent" },
    ],
    factions: [
      { id: "guest", name: "住客·林夏", role: "消费者", portrait: "linxia", public_claim: "我只要一个公开道歉和整改", hidden_motive: "照片还有第二组，但不想把事闹到无法收场", trust: 3.0, friction: 7.0, ruin: 8.2 },
      { id: "host", name: "民宿老板·陈总", role: "商家", portrait: "mentor", public_claim: "卫生问题我们认，但帖子有夸大", hidden_motive: "只愿意免单，不愿意留下书面整改记录", trust: 3.6, friction: 5.8, ruin: 7.8 },
      { id: "platform", name: "平台客服·Selene", role: "平台", portrait: "selene", public_claim: "我们会介入核实", hidden_motive: "更想把帖子降权，而不是处理商家", trust: 3.2, friction: 5.2, ruin: 7.5 },
      { id: "crowd", name: "围观住客·小满", role: "潜在消费者", portrait: "mother", public_claim: "以后不敢订了", hidden_motive: "只想知道能不能退款，并不关心整改", trust: 2.4, friction: 6.6, ruin: 8.0 },
    ],
  },
];

const PORTRAITS = ["linxia", "mentor", "selene", "mother"];
const BACKGROUNDS = ["/mirai/07-market.webp", "/mirai/04-world.webp", "/mirai/08-closing.webp", "/mirai/01-cover.webp"];

const hash = (value) => {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
};

function detectSource(url) {
  if (/xiaohongshu\.com|xhslink/i.test(url)) return "xiaohongshu";
  if (/douyin\.com|iesdouyin/i.test(url)) return "douyin";
  return "web";
}

function extractTags(text) {
  return Array.from(new Set(String(text).match(/#[^\s#，,。；;]+/g) ?? [])).slice(0, 8);
}

function clean(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function meta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const found = html.match(pattern);
    if (found) return clean(found[1]);
  }
  return "";
}

function assertSafeUrl(raw) {
  const target = new URL(raw);
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("只支持 http/https 链接");
  const host = target.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (blocked) throw new Error("不允许抓取内网地址");
  return target;
}

async function fetchPage(url) {
  assertSafeUrl(url);
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(9_000),
  });
  if (!res.ok) throw new Error(`抓取失败 ${res.status}`);
  const html = (await res.text()).slice(0, 500_000);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = clean(meta(html, "og:title") || titleTag?.[1] || "");
  const body = clean(meta(html, "og:description") || meta(html, "description") || "");
  const tags = extractTags(`${title} ${body} ${meta(html, "keywords")}`);
  const generic = /^(小红书|抖音|抖音-记录美好生活|小红书 - 你的生活指南|小红书 - 标记我的生活)$/i.test(title.trim());
  if (generic || body.length < 20) throw new Error("平台反爬或空页面，使用快照");
  return { title: title || "一条正在发酵的热帖", body, tags, comments: [] };
}

function matchCase(url) {
  if (/apology|xhs-apology|致歉|质检|凌晨三点/i.test(url)) return CASES[0];
  if (/partner|douyin-partner|合伙|密钥|尽调/i.test(url)) return CASES[1];
  if (/homestay|民宿|避雷|床单/i.test(url)) return CASES[2];
  return null;
}

function heuristicFactions(snapshot) {
  const title = snapshot.title || "这场争议";
  const tags = snapshot.tags?.join("、") || "热帖";
  const intents = new Set((snapshot.comments ?? []).map((comment) => comment.intent));
  const base = [
    {
      id: "victim",
      name: "当事维权方·林夏",
      role: "当事人",
      portrait: "linxia",
      public_claim: `只求一个公开透明的说法（${tags}）`,
      hidden_motive: "手里还有第二段没放出的证据，等对方先撒谎再放",
      trust: 2.2,
      friction: 7.6,
      ruin: 8.5,
    },
    {
      id: "brand",
      name: "被质疑方·陈总",
      role: "对方",
      portrait: "mentor",
      public_claim: "我们已经在核实，请给一点时间",
      hidden_motive: "想把事情拖过这个周末，等热度自己掉下来",
      trust: 4.1,
      friction: 5.5,
      ruin: 8.0,
    },
    {
      id: "skeptic",
      name: "理性考据党·周屿",
      role: "围观者",
      portrait: "selene",
      public_claim: "我只认时间戳和原件",
      hidden_motive: `想验证「${title}」里最关键的那份材料是不是真的`,
      trust: 3.4,
      friction: 6.2,
      ruin: 7.6,
    },
    {
      id: "crowd",
      name: "情绪吃瓜·小满",
      role: "围观者",
      portrait: "mother",
      public_claim: "等一个反转，越大越好",
      hidden_motive: "并不关心谁对谁错，只想看当事人当场翻车",
      trust: 2.7,
      friction: 8.1,
      ruin: 9.0,
    },
    {
      id: "silent",
      name: "沉默利益方",
      role: "相关方",
      portrait: "mentor",
      public_claim: "我们不方便回应",
      hidden_motive: "怕被甩锅，已经在准备自己的记录和截图",
      trust: 3.0,
      friction: 4.8,
      ruin: 7.2,
    },
  ];
  return base.filter((faction, index) => index < 3 || intents.has(faction.id) || index === 4).map((faction) => ({
    ...faction,
    initial_bias: { trust: faction.trust, friction: faction.friction, ruin_threshold: faction.ruin },
  }));
}

const FACTION_FIELDS = ["name", "role", "public_claim", "hidden_motive"];
const BIAS_FIELDS = ["trust", "friction", "ruin_threshold"];

function factionPrompt(snapshot) {
  const comments = (snapshot.comments ?? []).slice(0, 5).map((comment) => comment.text);
  return [
    "从下面这条热帖里拆出 3-5 个真实阵营，只输出 JSON。",
    `标题：${snapshot.title}`,
    `正文：${snapshot.body}`,
    snapshot.tags?.length ? `标签：${snapshot.tags.join("、")}` : "",
    comments.length ? `高赞评论：${comments.join(" / ")}` : "",
    "",
    "要求：",
    "1. factions 恰好 3-5 个，id 用英文小写（victim / brand / skeptic / silent 之类）。",
    "2. public_claim 是它在公开场合会说的话（≤30 字）；hidden_motive 是没亮出来的底牌（≤40 字）。",
    "3. initial_bias 的 trust / friction / ruin_threshold 都是 0-10：对当事人的信任、与对方的摩擦、何时决裂。",
    "4. 阵营之间必须有真实利益冲突，不要写成「网友 A / B / C」，也不要都站同一边。",
    '输出结构：{"factions":[{"id":"victim","name":"当事维权方·林夏","role":"当事人",',
    '"public_claim":"只求一个公开透明的说法","hidden_motive":"手里还有第二段证据",',
    '"initial_bias":{"trust":2.2,"friction":7.6,"ruin_threshold":8.5}}]}',
  ]
    .filter(Boolean)
    .join("\n");
}

function validateFactions(data) {
  const list = data?.factions;
  if (!Array.isArray(list) || list.length < 3 || list.length > 5) return "factions 需要 3-5 个";
  const ids = new Set();
  for (const faction of list) {
    if (!faction || typeof faction.id !== "string" || !faction.id.trim()) return "缺少 id";
    if (ids.has(faction.id)) return `重复的 id：${faction.id}`;
    ids.add(faction.id);
    for (const field of FACTION_FIELDS) {
      if (typeof faction[field] !== "string" || !faction[field].trim()) {
        return `${faction.id} 缺少 ${field}`;
      }
    }
    const bias = faction.initial_bias ?? {};
    for (const field of BIAS_FIELDS) {
      const value = Number(bias[field]);
      if (!Number.isFinite(value) || value < 0 || value > 10) {
        return `${faction.id}.initial_bias.${field} 需要 0-10`;
      }
    }
  }
  return true;
}

async function factionsFromLLM(snapshot) {
  const result = await chatJson({
    system: "你是社会冲突分析师。只输出合法的 JSON，不解释，不使用 markdown。",
    user: factionPrompt(snapshot),
    temperature: 0.4,
    maxTokens: 1200,
    timeoutMs: 25_000,
    validate: validateFactions,
  });
  if (!result.ok) {
    if (result.reason !== "no-key") {
      console.warn(`[ingest] faction LLM ${result.reason}: ${String(result.error).slice(0, 120)}`);
    }
    return null;
  }
  return normalizeFactions({ factions: result.data.factions });
}

function normalizeFactions(snapshot) {
  const source = snapshot.factions?.length ? snapshot.factions : heuristicFactions(snapshot);
  return source.map((faction, index) => ({
    id: faction.id ?? `faction-${index}`,
    name: faction.name ?? `阵营 ${index + 1}`,
    role: faction.role ?? "相关方",
    portrait: faction.portrait ?? PORTRAITS[index % PORTRAITS.length],
    public_claim: faction.public_claim ?? "还没有表态",
    hidden_motive: faction.hidden_motive ?? "还没有被看穿",
    initial_bias: faction.initial_bias ?? {
      trust: faction.trust ?? 3,
      friction: faction.friction ?? 6,
      ruin_threshold: faction.ruin ?? 8,
    },
  }));
}

function buildSpec(snapshot, factions, playerFaction) {
  const cast = factions.map((faction) => ({
    id: faction.id,
    name: faction.name,
    role: faction.role,
    traits: faction.public_claim,
    portrait: faction.portrait,
  }));
  const speaker = factions[0]?.name ?? "当事人";
  const player = factions.find((faction) => faction.id === playerFaction);
  const title = (snapshot.title || "热帖风波").slice(0, 18);
  const tags = snapshot.tags?.join(" ") || "";
  const opening = `${snapshot.title}。${snapshot.body}`.slice(0, 240);

  const node = (id, titleText, place, time, speakerName, text, stance, choices) => ({
    id,
    title: titleText,
    scene: {
      background: place,
      place: place === "post" ? "首页" : place === "comments" ? "评论区" : "线下",
      time,
      weather: "阴",
      mood: stance === "rupture" ? "紧绷" : stance === "empathetic" ? "温柔" : "安静",
    },
    speaker: speakerName,
    text,
    stance_goal: stance,
    observe: [{ key: titleText.slice(0, 6), value: 5 + (id.length % 4) }],
    choices,
  });

  const nodes = [
    node("post", "帖子发出", "post", "深夜", speaker, opening, "neutral", [
      { label: "把事情原样摊开", to: "split", memory: { key: "摊开", value: 7 } },
      { label: "先看评论区怎么站队", to: "comments", memory: { key: "观察", value: 5 } },
    ]),
    node("split", "阵营分裂", "comments", "深夜", factions[1]?.name ?? speaker,
      `评论区很快分成几派。${factions[1]?.public_claim ?? "对方"}与${factions[2]?.public_claim ?? "围观者"}各说各话，真正的底牌都还没亮。`,
      "probe_blindspot", [
        { label: "点名要求对方亮证据", to: "evidence", memory: { key: "逼宫", value: 8 } },
        { label: "私下联系对方谈条件", to: "deal", memory: { key: "私下", value: 6 } },
      ]),
    node("comments", "评论区", "comments", "深夜", factions[2]?.name ?? speaker,
      `最高赞那条是「${snapshot.comments?.[0]?.text ?? "先别急着站队"}」。情绪在涨，但还没有人拿出原件。`,
      "skeptical_push", [
        { label: "把原件晒出来", to: "evidence", memory: { key: "公开", value: 8 } },
        { label: "只回应情绪，不交证据", to: "deal", memory: { key: "拖", value: 5 } },
      ]),
    node("evidence", "证据", "night", "凌晨", factions[3]?.name ?? speaker,
      `你把最关键的记录放到桌面上。${player ? `作为${player.name}，` : ""}所有人都安静了一秒，然后开始重新算自己的账。`,
      "counter_bluff", [
        { label: "趁势要求公开道歉", to: "calm", memory: { key: "道歉", value: 8 } },
        { label: "把最难听的那句也放出来", to: "rupture", memory: { key: "翻脸", value: 9 } },
      ]),
    node("deal", "私下谈", "quiet", "凌晨", factions[1]?.name ?? speaker,
      "对方把声音压低，说可以谈，但条件是不能留下书面记录。你意识到，这句话本身就是证据。",
      "probe_blindspot", [
        { label: "答应，但偷偷留底", to: "calm", memory: { key: "留底", value: 7 } },
        { label: "拒绝，回到公开场", to: "rupture", memory: { key: "拒绝", value: 8 } },
      ]),
    node("calm", "暂时平息", "night", "清晨", factions[0]?.name ?? speaker,
      "对方发了公开道歉，评论区没有完全消气，但至少没有人再喊「删帖」。你知道这只是暂时的。",
      "empathetic", []),
    node("rupture", "彻底炸锅", "comments", "清晨", factions[3]?.name ?? speaker,
      "最难听的那句被截图转了出去。品牌、平台、围观者都被卷进来，热搜挂了一整天。",
      "rupture", []),
  ];

  return {
    spec_version: "1.0",
    id: `social-${snapshot.id || hash(title).toString(36)}`,
    title,
    subtitle: `现实摄取 · ${snapshot.source_type ?? "web"} · ${factions.length} 个阵营`,
    logline: snapshot.body?.slice(0, 100) ?? title,
    ui: { palette: "warm", accent: "rose" },
    assets_manifest: {
      cover: { path: BACKGROUNDS[0] },
      backgrounds: {
        post: { path: BACKGROUNDS[0] },
        comments: { path: BACKGROUNDS[1] },
        night: { path: BACKGROUNDS[2] },
        quiet: { path: BACKGROUNDS[3] },
      },
      portraits: Object.fromEntries(
        factions.map((faction) => [
          faction.portrait,
          { base: `/mirai/${faction.portrait}.webp`, emotions: { neutral: `/mirai/${faction.portrait}.webp` } },
        ]),
      ),
    },
    cast,
    state_injection: {
      prior_memories: [
        { key: "阵营", value: factions.length * 2 },
        { key: "极化", value: Math.round((snapshot.polarization ?? 0.7) * 10) },
        ...snapshot.tags?.slice(0, 2).map((tag) => ({ key: tag.replace("#", ""), value: 5 })) ?? [],
      ],
      temperature: 0.8,
    },
    logic_nodes: nodes,
    entry: "post",
    meta: {
      source_type: snapshot.source_type,
      source_url: snapshot.source_url,
      theme_skin: "cinema-warm",
      captured_at: snapshot.captured_at,
    },
    factions,
    social_pulse: {
      comment_sample_count: snapshot.comments?.length ?? 0,
      polarization_index: snapshot.polarization ?? 0.7,
      top_ranked_comments: (snapshot.comments ?? []).slice(0, 3).map((comment, index) => ({
        rank: index + 1,
        faction: comment.intent ?? "crowd",
        text: comment.text,
        inferred_intent: comment.intent === "skeptic" ? "逼宫亮底牌" : comment.intent === "crowd" ? "等反转" : "要说法",
      })),
    },
  };
}

export function socialCases() {
  return CASES.map((item) => ({
    id: item.id,
    source_type: item.source_type,
    source_url: item.source_url,
    title: item.title,
    tags: item.tags,
    comments: item.comments.length,
  }));
}

export async function ingestSocial({ url = "", text = "", player_faction = "" } = {}) {
  let snapshot = null;
  let fetched = false;
  let fallback = false;
  let provider = "snapshot";
  let xhsAttempted = false;

  if (String(text).trim()) {
    const body = String(text).trim();
    snapshot = {
      id: `text-${hash(body).toString(36)}`,
      source_type: "text",
      source_url: "",
      title: body.split(/[。\n]/)[0].slice(0, 24) || "一段正在发酵的处境",
      body,
      tags: extractTags(body),
      comments: [],
      polarization: 0.7,
      captured_at: new Date().toISOString(),
    };
  } else if (String(url).trim()) {
    const target = String(url).trim();
    try {
      assertSafeUrl(target);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "链接不安全" };
    }
    // 小红书先走真实读取（需要 XHS_COOKIE）；失败再退回通用抓取，最后才是快照。
    if (/xiaohongshu\.com|xhslink/i.test(target) && xhsConfigured()) {
      xhsAttempted = true;
      try {
        const note = await fetchXhsNote(target);
        snapshot = {
          id: `xhs-${hash(target).toString(36)}`,
          source_type: "xiaohongshu",
          source_url: target,
          title: note.title,
          body: note.body,
          tags: note.tags,
          comments: note.comments.map((comment) => ({
            text: comment.text,
            likes: comment.likes,
            intent: "unknown",
          })),
          polarization: 0.72,
          captured_at: new Date().toISOString(),
          note: note.commentsFetched
            ? `小红书真实读取 · ${note.comments.length} 条评论`
            : "小红书真实读取 · 正文与标签已取，评论被风控拦下",
        };
        fetched = true;
        provider = "xhs";
      } catch (error) {
        // 登录态过期、缺 xsec_token 或被风控；原因留在服务端日志里，别静默。
        console.warn(`[xhs] real read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!snapshot) try {
      const page = await fetchPage(target);
      snapshot = {
        id: `url-${hash(target).toString(36)}`,
        source_type: detectSource(target),
        source_url: target,
        title: page.title,
        body: page.body,
        tags: page.tags,
        comments: [],
        polarization: 0.68,
        captured_at: new Date().toISOString(),
      };
      fetched = true;
    } catch {
      fallback = true;
    }
    if (!snapshot) {
      const builtin = matchCase(target) ?? CASES[hash(target) % CASES.length];
      snapshot = {
        ...builtin,
        source_url: target,
        captured_at: new Date().toISOString(),
        polarization: 0.78,
        note:
          /xiaohongshu\.com|xhslink/i.test(target) && !xhsConfigured()
            ? "未配置小红书登录态（XHS_COOKIE），这一版是示例快照"
            : xhsAttempted
              ? "小红书读取失败：链接里的 xsec_token 可能已过期，从浏览器地址栏重新复制一次完整链接"
              : "平台反爬或网络不可达，使用内置快照",
      };
    }
  } else {
    snapshot = {
      ...CASES[0],
      captured_at: new Date().toISOString(),
      polarization: 0.78,
      note: "示例快照",
    };
  }

  const llmFactions = await factionsFromLLM(snapshot);
  const factions = llmFactions ?? normalizeFactions(snapshot);
  const spec = buildSpec(snapshot, factions, player_faction);

  return {
    ok: true,
    fetched,
    fallback,
    provider,
    faction_source: llmFactions ? "llm" : "archetype",
    snapshot: {
      title: snapshot.title,
      body: snapshot.body,
      tags: snapshot.tags,
      comments: snapshot.comments ?? [],
      source_type: snapshot.source_type,
      source_url: snapshot.source_url,
      polarization: snapshot.polarization ?? 0.7,
      note: snapshot.note,
    },
    factions,
    spec,
  };
}
