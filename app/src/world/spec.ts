/**
 * World-Spec v1.0 —— 世界的唯一真源。
 *
 * 渲染层不认识任何具体故事：它只读这份 JSON。
 *   · assets_manifest：立绘 / 背景 / 情绪切片的路径，交给资产工厂填；
 *   · logic_nodes：状态机节点，每个节点带 stance_goal（这一幕要把博弈推向哪一档）；
 *   · state_injection：进入世界时给 PAI-SSM 的初始偏置与先验记忆。
 *
 * 这里只做「解析 + 校验 + 折进 WorldTree」三件事，不碰渲染。
 */

import { WorldTree, type WorldTreeData } from "./engine";

export const SPEC_VERSION = "1.0";

export type SpecStance =
  | "empathetic"
  | "neutral"
  | "probe_blindspot"
  | "skeptical_push"
  | "counter_bluff"
  | "rupture";

export type Emotion = "neutral" | "warm" | "cold" | "tense" | "broken";

export const STANCE_EMOTION: Record<SpecStance, Emotion> = {
  empathetic: "warm",
  neutral: "neutral",
  probe_blindspot: "tense",
  skeptical_push: "cold",
  counter_bluff: "tense",
  rupture: "broken",
};

export const STANCE_LABEL: Record<SpecStance, string> = {
  empathetic: "信了一点",
  neutral: "平视",
  probe_blindspot: "追问底牌",
  skeptical_push: "听出心虚",
  counter_bluff: "反将一军",
  rupture: "谈崩",
};

export interface SpecAsset {
  /** 站点绝对路径或资产工厂产出的 URL。 */
  path: string;
  /** 画面锚点，渲染器据此决定 object-position。 */
  focus?: "center" | "top" | "left" | "right";
}

export interface SpecPortrait {
  /** 基础立绘；情绪切片缺省时回落到它。 */
  base: string;
  emotions?: Partial<Record<Emotion, string>>;
}

export interface SpecScene {
  background?: string;
  place?: string;
  time?: string;
  weather?: string;
  mood?: string;
}

export interface SpecChoice {
  id?: string;
  label: string;
  /** 目标 logic_node id。 */
  to: string;
  hint?: string;
  memory?: { key: string; value: number };
}

export interface SpecNode {
  id: string;
  title: string;
  scene: SpecScene;
  speaker: string;
  text: string;
  /** 这一幕的博弈目标：驱动 PAI-SSM 的反讨好姿态锁。 */
  stance_goal: SpecStance;
  emotion?: Emotion;
  choices?: SpecChoice[];
  /** 进入这一幕时写入的观测，会成为后续推演的先验。 */
  observe?: { key: string; value: number }[];
}

export interface SpecCastMember {
  id: string;
  name: string;
  role: string;
  traits: string;
  /** assets_manifest.portraits 的键。 */
  portrait: string;
}

export interface SpecStateInjection {
  /** 进入世界时先灌入的记忆。 */
  prior_memories?: { key: string; value: number; weight?: number }[];
  /** 给 PAI-SSM 的姿态先验（只影响语气，不改结局分位数）。 */
  stance_bias?: Partial<Record<SpecStance, number>>;
  /** 温度：越高越容易主动试探。 */
  temperature?: number;
  /** 初始自然参数（可选；不填就由桥用 init_world_state）。 */
  A0?: number[];
  B0?: number[];
}

export interface SpecFaction {
  id: string;
  name: string;
  role: string;
  portrait: string;
  public_claim: string;
  hidden_motive: string;
  initial_bias: { trust: number; friction: number; ruin_threshold: number };
}

export interface SpecSocialPulse {
  comment_sample_count: number;
  polarization_index: number;
  top_ranked_comments: {
    rank: number;
    faction: string;
    text: string;
    inferred_intent: string;
  }[];
}

export interface SpecMeta {
  source_type?: string;
  source_url?: string;
  theme_skin?: string;
  captured_at?: string;
  license?: { mode?: string; author_cut?: number; parent_world_id?: string | null };
}

export interface WorldSpec {
  spec_version: typeof SPEC_VERSION;
  id: string;
  title: string;
  subtitle?: string;
  logline?: string;
  /** 世界自己的视觉基调；渲染器只取色相，不覆盖 Arc 语义。 */
  ui?: {
    palette?: "cream" | "warm" | "noir" | "cold";
    accent?: "rose" | "teal" | "amber" | "violet";
  };
  assets_manifest: {
    /** 标题页用的大图；没有就用入口背景，再没有就用第一位角色的立绘。 */
    cover?: SpecAsset;
    backgrounds: Record<string, SpecAsset>;
    portraits: Record<string, SpecPortrait>;
    audio?: Record<string, string>;
  };
  cast: SpecCastMember[];
  state_injection: SpecStateInjection;
  logic_nodes: SpecNode[];
  entry: string;
  /** v3 社会摄取扩展：阵营 Agent、舆情快照与来源信息；渲染器可忽略。 */
  meta?: SpecMeta;
  factions?: SpecFaction[];
  social_pulse?: SpecSocialPulse;
}

export interface SpecIssue {
  path: string;
  message: string;
}

export interface SpecValidation {
  ok: boolean;
  errors: SpecIssue[];
  warnings: SpecIssue[];
  spec?: WorldSpec;
}

const STANCES: SpecStance[] = [
  "empathetic",
  "neutral",
  "probe_blindspot",
  "skeptical_push",
  "counter_bluff",
  "rupture",
];

const EMOTIONS: Emotion[] = ["neutral", "warm", "cold", "tense", "broken"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * 校验一份 Spec，错误与警告分开：
 * 错误会让世界载不进来；警告只是资源没配齐，渲染器会用兜底色。
 */
export function validateWorldSpec(input: unknown): SpecValidation {
  const errors: SpecIssue[] = [];
  const warnings: SpecIssue[] = [];
  const fail = (path: string, message: string) => errors.push({ path, message });

  if (!isObject(input)) {
    return { ok: false, errors: [{ path: "$", message: "Spec 必须是一个对象" }], warnings };
  }
  const raw = input as Record<string, unknown>;

  if (raw.spec_version !== SPEC_VERSION) {
    fail("$.spec_version", `需要 "1.0"，收到 ${JSON.stringify(raw.spec_version)}`);
  }
  if (!isString(raw.id)) fail("$.id", "缺少世界 id");
  if (!isString(raw.title)) fail("$.title", "缺少标题");
  if (!isString(raw.entry)) fail("$.entry", "缺少入口节点 entry");

  const manifest = raw.assets_manifest;
  let cover: SpecAsset | undefined;
  const backgrounds: Record<string, SpecAsset> = {};
  const portraits: Record<string, SpecPortrait> = {};

  if (!isObject(manifest)) {
    fail("$.assets_manifest", "缺少 assets_manifest");
  } else {
    if (isObject(manifest.cover) && isString(manifest.cover.path)) {
      cover = { path: manifest.cover.path, focus: manifest.cover.focus as SpecAsset["focus"] };
    }
    if (isObject(manifest.backgrounds)) {
      for (const [key, asset] of Object.entries(manifest.backgrounds)) {
        if (!isObject(asset) || !isString(asset.path)) {
          warnings.push({ path: `$.assets_manifest.backgrounds.${key}`, message: "缺少 path，将回落到实时渲染" });
          continue;
        }
        backgrounds[key] = { path: asset.path, focus: asset.focus as SpecAsset["focus"] };
      }
    } else {
      warnings.push({ path: "$.assets_manifest.backgrounds", message: "没有背景清单" });
    }

    if (isObject(manifest.portraits)) {
      for (const [key, portrait] of Object.entries(manifest.portraits)) {
        if (!isObject(portrait) || !isString(portrait.base)) {
          warnings.push({ path: `$.assets_manifest.portraits.${key}`, message: "缺少 base 立绘" });
          continue;
        }
        const emotions: Partial<Record<Emotion, string>> = {};
        if (isObject(portrait.emotions)) {
          for (const emotion of EMOTIONS) {
            const value = portrait.emotions[emotion];
            if (isString(value)) emotions[emotion] = value;
          }
        }
        portraits[key] = { base: portrait.base, emotions };
      }
    } else {
      warnings.push({ path: "$.assets_manifest.portraits", message: "没有立绘清单" });
    }
  }

  const cast: SpecCastMember[] = [];
  if (Array.isArray(raw.cast)) {
    raw.cast.forEach((member, index) => {
      if (!isObject(member) || !isString(member.id) || !isString(member.name)) {
        fail(`$.cast[${index}]`, "角色需要 id 与 name");
        return;
      }
      const portrait = isString(member.portrait) ? member.portrait : member.id;
      cast.push({
        id: member.id,
        name: member.name,
        role: isString(member.role) ? member.role : "",
        traits: isString(member.traits) ? member.traits : "",
        portrait,
      });
      if (!portraits[portrait]) {
        warnings.push({ path: `$.cast[${index}].portrait`, message: `立绘「${portrait}」不在 assets_manifest 里` });
      }
    });
  } else {
    warnings.push({ path: "$.cast", message: "没有角色表，舞台会显示「旁白」" });
  }

  const nodes: SpecNode[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(raw.logic_nodes) || !raw.logic_nodes.length) {
    fail("$.logic_nodes", "至少需要一个叙事节点");
  } else {
    raw.logic_nodes.forEach((node, index) => {
      const at = `$.logic_nodes[${index}]`;
      if (!isObject(node) || !isString(node.id)) {
        fail(at, "节点需要 id");
        return;
      }
      if (ids.has(node.id)) fail(`${at}.id`, `节点 id 重复：${node.id}`);
      ids.add(node.id);
      if (!isString(node.text)) fail(`${at}.text`, "节点需要 text");
      if (!isString(node.speaker)) warnings.push({ path: `${at}.speaker`, message: "没有 speaker，按旁白处理" });
      const stance = node.stance_goal;
      if (!STANCES.includes(stance as SpecStance)) {
        fail(`${at}.stance_goal`, `stance_goal 必须是 ${STANCES.join(" / ")}`);
      }
      const scene = isObject(node.scene) ? node.scene : {};
      if (isString(scene.background) && !backgrounds[scene.background]) {
        warnings.push({ path: `${at}.scene.background`, message: `背景「${scene.background}」不在清单里` });
      }
      const choices: SpecChoice[] = [];
      if (Array.isArray(node.choices)) {
        node.choices.forEach((choice, choiceIndex) => {
          if (!isObject(choice) || !isString(choice.label) || !isString(choice.to)) {
            fail(`${at}.choices[${choiceIndex}]`, "选项需要 label 与 to");
            return;
          }
          choices.push({
            id: isString(choice.id) ? choice.id : undefined,
            label: choice.label,
            to: choice.to,
            hint: isString(choice.hint) ? choice.hint : undefined,
            memory: isObject(choice.memory) && isString(choice.memory.key)
              ? { key: choice.memory.key, value: Number(choice.memory.value ?? 4) }
              : undefined,
          });
        });
      }
      const observe: { key: string; value: number }[] = [];
      if (Array.isArray(node.observe)) {
        node.observe.forEach((item) => {
          if (isObject(item) && isString(item.key)) {
            observe.push({ key: item.key, value: Number(item.value ?? 4) });
          }
        });
      }
      nodes.push({
        id: node.id,
        title: isString(node.title) ? node.title : node.id,
        scene: {
          background: isString(scene.background) ? scene.background : undefined,
          place: isString(scene.place) ? scene.place : undefined,
          time: isString(scene.time) ? scene.time : undefined,
          weather: isString(scene.weather) ? scene.weather : undefined,
          mood: isString(scene.mood) ? scene.mood : undefined,
        },
        speaker: isString(node.speaker) ? node.speaker : "旁白",
        text: node.text as string,
        stance_goal: stance as SpecStance,
        emotion: EMOTIONS.includes(node.emotion as Emotion) ? (node.emotion as Emotion) : undefined,
        choices,
        observe,
      });
    });

    // 引用完整性：entry 与所有 to 都必须落在一个节点上。
    if (isString(raw.entry) && !ids.has(raw.entry)) {
      fail("$.entry", `入口「${raw.entry}」不存在`);
    }
    nodes.forEach((node) => {
      node.choices?.forEach((choice, index) => {
        if (!ids.has(choice.to)) {
          fail(`$.logic_nodes[${node.id}].choices[${index}].to`, `目标「${choice.to}」不存在`);
        }
      });
    });

    const reachable = new Set<string>();
    const walk = (id: string) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      const node = nodes.find((n) => n.id === id);
      node?.choices?.forEach((choice) => walk(choice.to));
    };
    if (isString(raw.entry) && ids.has(raw.entry)) walk(raw.entry);
    nodes.forEach((node) => {
      if (!reachable.has(node.id)) {
        warnings.push({ path: `$.logic_nodes[${node.id}]`, message: "从 entry 走不到这个节点" });
      }
    });
  }

  const injection = isObject(raw.state_injection) ? raw.state_injection : {};
  const prior_memories: { key: string; value: number }[] = [];
  if (Array.isArray(injection.prior_memories)) {
    injection.prior_memories.forEach((item, index) => {
      if (isObject(item) && isString(item.key)) {
        prior_memories.push({ key: item.key, value: Number(item.value ?? 4) });
      } else {
        warnings.push({ path: `$.state_injection.prior_memories[${index}]`, message: "缺少 key" });
      }
    });
  }

  if (errors.length) return { ok: false, errors, warnings };

  const palette =
    isObject(raw.ui) && typeof raw.ui.palette === "string" && ["cream", "warm", "noir", "cold"].includes(raw.ui.palette)
      ? (raw.ui.palette as NonNullable<WorldSpec["ui"]>["palette"])
      : undefined;
  const accent =
    isObject(raw.ui) && typeof raw.ui.accent === "string" && ["rose", "teal", "amber", "violet"].includes(raw.ui.accent)
      ? (raw.ui.accent as NonNullable<WorldSpec["ui"]>["accent"])
      : undefined;

  const spec: WorldSpec = {
    spec_version: SPEC_VERSION,
    id: raw.id as string,
    title: raw.title as string,
    subtitle: isString(raw.subtitle) ? raw.subtitle : undefined,
    logline: isString(raw.logline) ? raw.logline : undefined,
    ui: isObject(raw.ui) ? { palette, accent } : undefined,
    assets_manifest: { cover, backgrounds, portraits },
    cast,
    state_injection: {
      prior_memories,
      stance_bias: isObject(injection.stance_bias) ? (injection.stance_bias as SpecStateInjection["stance_bias"]) : undefined,
      temperature: typeof injection.temperature === "number" ? injection.temperature : undefined,
      A0: Array.isArray(injection.A0) ? (injection.A0 as number[]) : undefined,
      B0: Array.isArray(injection.B0) ? (injection.B0 as number[]) : undefined,
    },
    logic_nodes: nodes,
    entry: raw.entry as string,
  };

  return { ok: true, errors, warnings, spec };
}

export interface BuiltSpecWorld {
  name: string;
  hook: string;
  characters: { id: string; name: string; role: string; traits: string; portrait: string }[];
  tree: WorldTreeData;
  cursor: string;
  choices: { id: string; label: string; key: string; value: number; sub?: string }[];
  spec: WorldSpec;
}

/**
 * 把 Spec 折成一棵真正的 WorldTree。
 *
 * 每个叙事节点是一段 branch + 该幕留下的观测；选项连到下一段 branch。
 * 这样存档、回滚、合流、导出全都沿用已经验证过的引擎，不需要第二套运行时。
 */
export function buildWorldFromSpec(spec: WorldSpec): BuiltSpecWorld {
  const tree = WorldTree.create(spec.title);
  let base = tree.root.id;

  for (const memory of spec.state_injection.prior_memories ?? []) {
    base = tree.observe(
      base,
      { uid: `seed-${memory.key}`, key: memory.key, value: memory.value },
      `进入世界：${memory.key}`,
    ).id;
  }

  const byId = new Map(spec.logic_nodes.map((node) => [node.id, node]));
  // parents 只记「这一幕从哪个树节点长出来」，visited 才是真的处理过的集合。
  // 混用两者会让子节点在入队时就被当成已处理，整棵树只剩入口。
  const parents = new Map<string, string>();
  const visited = new Set<string>();
  const queue: string[] = [spec.entry];
  let entryTreeId = base;
  let guard = 0;

  while (queue.length && guard < 200) {
    guard += 1;
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (!node) continue;
    const parent = parents.get(id) ?? base;

    const scene = tree.branch(parent, node.title || node.id);
    if (id === spec.entry) entryTreeId = scene.id;

    tree.annotate(scene.id, {
      narration: node.text,
      specNode: node.id,
      speaker: node.speaker,
      stanceGoal: node.stance_goal,
      emotion: node.emotion ?? "",
      background: node.scene.background ?? "",
      place: node.scene.place ?? "",
      time: node.scene.time ?? "",
      weather: node.scene.weather ?? "",
      mood: node.scene.mood ?? "",
      suggestions: JSON.stringify((node.choices ?? []).map((choice) => choice.label)),
      specId: spec.id,
    });

    let tip = scene.id;
    for (const observation of node.observe ?? []) {
      tip = tree.observe(
        tip,
        { uid: `obs-${node.id}-${observation.key}`, key: observation.key, value: observation.value },
        `${node.title}：${observation.key}`,
      ).id;
    }

    for (const choice of node.choices ?? []) {
      if (visited.has(choice.to) || parents.has(choice.to)) continue;
      parents.set(choice.to, tip);
      queue.push(choice.to);
    }
  }

  const choices = (byId.get(spec.entry)?.choices ?? []).map((choice, index) => ({
    id: choice.id ?? `c-${index}`,
    label: choice.label,
    key: choice.memory?.key ?? "这一步",
    value: choice.memory?.value ?? 4,
    sub: choice.hint,
  }));

  return {
    name: spec.title,
    hook: spec.logline ?? spec.subtitle ?? "",
    characters: spec.cast.map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      traits: member.traits,
      portrait: spec.assets_manifest.portraits[member.portrait]?.base ?? "",
    })),
    tree: tree.toData(),
    cursor: entryTreeId,
    choices,
    spec,
  };
}

/** 当前这一幕的 Spec 节点（渲染器据此取背景、情绪与 stance 目标）。 */
export function specNodeOf(
  spec: WorldSpec | undefined,
  specNodeId: string | undefined,
): SpecNode | null {
  if (!spec || !specNodeId) return null;
  return spec.logic_nodes.find((node) => node.id === specNodeId) ?? null;
}

export function portraitFor(
  spec: WorldSpec | undefined,
  castPortraitKey: string | undefined,
  stance: SpecStance | undefined,
  explicitEmotion: Emotion | undefined,
): string | null {
  if (!spec) return null;
  const key = castPortraitKey ?? spec.cast[0]?.portrait;
  if (!key) return null;
  const portrait = spec.assets_manifest.portraits[key];
  if (!portrait) return null;
  const emotion = explicitEmotion ?? (stance ? STANCE_EMOTION[stance] : "neutral");
  return portrait.emotions?.[emotion] ?? portrait.emotions?.neutral ?? portrait.base;
}
