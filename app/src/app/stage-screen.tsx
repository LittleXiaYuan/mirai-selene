import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowUp, Download, Volume2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Alert } from "@/components/arc/alert/alert";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Drawer, DrawerContent } from "@/components/arc/drawer/drawer";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Input } from "@/components/arc/input/input";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { Textarea } from "@/components/arc/textarea/textarea";
import { balanceWord, readMood, slotMean, type WorldNode } from "@/world/engine";
import {
  STANCE_EMOTION,
  STANCE_LABEL,
  portraitFor,
  specNodeOf,
  validateWorldSpec,
  type WorldSpec,
} from "@/world/spec";
import { SPEC_SAMPLES } from "@/world/spec-samples";
import { useBeat } from "./use-beat";
import { useSentences } from "./use-sentences";
import { SceneCanvas } from "./scene-canvas";
import { useProsody } from "./use-prosody";
import { paiMerge3, paiStep, type PaiStep, type Stance } from "./pai";
import { STANCE_FACE, stanceFromMood } from "./stance";
import { generateAsset, planAssets, pushSpec, type AssetTask } from "./spec-api";
import { downloadShell, previewShell } from "./game-shell";
import type { SpecSyncState } from "./use-spec-sync";
import { WorldlineGallery, type MergeReport, type SaveSlot } from "./worldline-gallery";
import { VoiceProsodyButton } from "./voice-prosody-button";
import { DEFAULT_CHOICES, type UseWorlds } from "./use-worlds";
import styles from "./stage.module.css";

type Tab = "saves" | "memory" | "history" | "world";

interface Kernel {
  paiId?: string;
  stance?: Stance;
  ruin?: number;
  fingerprint?: string;
  spread?: number;
  commutativity?: number;
}

interface Plan {
  spec: WorldSpec;
  tasks: AssetTask[];
  provider?: string;
}

const ART_MAX = 12;

function placeBucket(place: string): string {
  const p = place ?? "";
  if (/街|路|地铁|车站|广场|城市|商场|公司|楼|机场|车/.test(p)) return "city";
  if (/校|教室|图书|实验|办公室|讲台|导师|系/.test(p)) return "study";
  if (/家|屋|房|厅|室|桌|床|厨房|阳台|窗|门|沙发/.test(p)) return "home";
  if (/海|岸|山|树|公园|田|野|雨里|户外/.test(p)) return "outdoor";
  return p.slice(0, 2) || "unknown";
}

function recall(node: WorldNode | undefined): string {
  if (!node) return "";
  const saved = node.meta?.narration;
  if (saved) return saved;
  if (node.kind === "root") return "一切从这里开始。写一句，她就会有反应。";
  if (node.kind === "branch") return `你走了「${node.label}」这条路。`;
  if (node.kind === "merge") return "两条路在这里接上了。";
  if (node.kind === "rollback") return "你退回来了。";
  return `「${node.label}」之后，世界变了。`;
}

const TITLES: Record<Tab, { title: string; description: string }> = {
  saves: { title: "世界线", description: "十个存档，能回去、能合流、能带走。" },
  memory: { title: "她记得什么", description: "数字越高，她越在意。也可以回到走过的某一步。" },
  history: { title: "这条线做过什么", description: "每次操作都留了记录，倒序排。" },
  world: { title: "世界仓库", description: "换一份 World-Spec，渲染器不用重启。" },
};

export function StageScreen({
  w,
  specSync,
  demoMode,
  onEdit,
  onHome,
  onForge,
  onEnd,
  onCompare,
}: {
  w: UseWorlds;
  specSync: SpecSyncState;
  demoMode?: boolean;
  onEdit: () => void;
  onHome: () => void;
  onForge: () => void;
  onEnd: () => void;
  onCompare: () => void;
}) {
  const reduce = useReducedMotion();
  const { beat, pending, error, run, reset } = useBeat();
  const voice = useProsody();
  // 浏览器自带的语音合成：不依赖任何外部额度，断网也能读。
  const [voiceAuto, setVoiceAuto] = useState(() => {
    try {
      return localStorage.getItem("mirai.voice.auto") === "1";
    } catch {
      return false;
    }
  });
  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || !text.trim()) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text.slice(0, 400));
    utter.lang = "zh-CN";
    utter.rate = 1;
    utter.pitch = 1;
    const zh = synth.getVoices().find((item) => /^zh|Chinese|中文/i.test(`${item.lang} ${item.name}`));
    if (zh) utter.voice = zh;
    synth.speak(utter);
  }, []);

  const [tab, setTab] = useState<Tab | null>(null);
  const [typed, setTyped] = useState("");
  const [input, setInput] = useState("");
  const [forkName, setForkName] = useState("");
  const [importText, setImportText] = useState("");
  const [specText, setSpecText] = useState("");
  const [theme, setTheme] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [assetBusy, setAssetBusy] = useState(false);
  const [assetNote, setAssetNote] = useState<string | null>(null);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [art, setArt] = useState<string | null>(null);
  const [kernel, setKernel] = useState<Record<string, Kernel>>({});
  const [pai, setPai] = useState<PaiStep | null>(null);
  const [probing, setProbing] = useState(false);
  const [report, setReport] = useState<MergeReport | null>(null);
  const [compact, setCompact] = useState(false);
  const [choicesOpen, setChoicesOpen] = useState(true);
  const [replyOpen, setReplyOpen] = useState(Boolean(demoMode));
  const [entered, setEntered] = useState(true);
  const [auto, setAuto] = useState(false);
  const [chapter, setChapter] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const replyRef = useRef<HTMLInputElement | null>(null);
  const paiIds = useRef(new Map<string, string>());
  const pendingKernel = useRef<{ node: Kernel } | null>(null);
  const artRef = useRef("");
  const artCount = useRef(0);
  const artCache = useRef(new Map<string, string>());
  const lastPlace = useRef("");

  const node = w.cursor?.node;
  const path = w.cursor?.path ?? [];
  const viewNode: WorldNode | null = node ?? null;
  const spec = w.active?.spec;
  // 自由对话产生的新节点没有 specNode：沿用路径上最近一幕的资产与场景。
  const inheritedSpecNode = useMemo(() => {
    const own = viewNode?.meta?.specNode;
    if (own) return own;
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const id = path[i]?.meta?.specNode;
      if (id) return id;
    }
    return undefined;
  }, [viewNode?.meta?.specNode, path]);
  const specNode = specNodeOf(spec, inheritedSpecNode);

  // 舞台是影院，其余页面照旧。离开时把主题还给外面。
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = "dark";
    return () => {
      if (previous) root.dataset.theme = previous;
      else delete root.dataset.theme;
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (demoMode) setReplyOpen(true);
  }, [demoMode]);

  useEffect(() => {
    if (!w.notice) return;
    const timer = window.setTimeout(() => w.setNotice(null), 3600);
    return () => window.clearTimeout(timer);
  }, [w.notice, w.setNotice]);

  useEffect(() => {
    if (!voice.error) return;
    w.setNotice({ tone: "error", text: voice.error });
  }, [voice.error, w.setNotice]);

  // 有 Spec 的世界先给一幕标题页；切世界时重新落下幕布。
  useEffect(() => {
    setEntered(!w.active?.spec);
  }, [w.active?.id, w.active?.spec?.id]);

  // 热重载换掉整个世界时，把上一场戏的流式文本、插画与抽屉一起收掉。
  const lastWorldId = useRef(w.active?.id);
  useEffect(() => {
    if (lastWorldId.current === w.active?.id) return;
    lastWorldId.current = w.active?.id;
    reset();
    setArt(null);
    setPai(null);
    setTab(null);
    setReport(null);
    setChoicesOpen(true);
  }, [w.active?.id, reset]);

  const scene = beat.scene
    ? beat.scene
    : viewNode?.meta
      ? {
          place: viewNode.meta.place ?? "",
          time: viewNode.meta.time ?? "",
          mood: viewNode.meta.mood ?? "",
          weather: viewNode.meta.weather ?? "",
        }
      : null;

  const speakerMember = useMemo(() => {
    if (!spec) return null;
    return spec.cast.find((member) => member.name === specNode?.speaker) ?? spec.cast[0] ?? null;
  }, [spec, specNode?.speaker]);

  const suggestions: { text: string; specTo?: string }[] = useMemo(() => {
    if (specNode?.choices?.length) {
      return specNode.choices.map((choice) => ({ text: choice.label, specTo: choice.to }));
    }
    if (beat.suggestions.length) return beat.suggestions.map((s) => ({ text: s.text }));
    if (viewNode?.meta?.suggestions) {
      try {
        const parsed = JSON.parse(viewNode.meta.suggestions);
        if (Array.isArray(parsed) && parsed.length) {
          return parsed.map((x: unknown) =>
            typeof x === "string" ? { text: x } : { text: (x as { text?: string }).text ?? "" },
          );
        }
      } catch {
        // 旧数据没有建议
      }
    }
    if (!viewNode?.meta?.narration) {
      return (w.active?.choices ?? DEFAULT_CHOICES).map((c) => ({ text: c.label }));
    }
    return [];
  }, [specNode, beat.suggestions, viewNode, w.active]);

  /** Spec 选项 → 已经折进世界树的节点 id。点选项是走一步，不是再问一次模型。 */
  const specTargets = useMemo(() => {
    const map = new Map<string, string>();
    if (!specNode?.choices?.length || !w.tree) return map;
    for (const target of w.tree.nodes) {
      const specId = target.meta?.specNode;
      if (specId) map.set(specId, target.id);
    }
    return map;
  }, [specNode, w.tree]);

  const specIndex = spec && specNode ? spec.logic_nodes.findIndex((node) => node.id === specNode.id) : -1;
  const isEnding = Boolean(
    specNode && (!specNode.choices || specNode.choices.length === 0) && !beat.text && !pending,
  );

  const lastForkId = useMemo(() => {
    if (!spec) return null;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const specId = path[index]?.meta?.specNode;
      const node = specId ? spec.logic_nodes.find((item) => item.id === specId) : null;
      if (node?.choices?.length) return path[index].id;
    }
    return null;
  }, [path, spec]);

  const mood = useMemo(() => (viewNode ? readMood(viewNode.state) : null), [viewNode]);
  const localStance = stanceFromMood(mood, voice.tension);
  const stance: Stance = pai?.stance ?? specNode?.stance_goal ?? localStance;
  const face = STANCE_FACE[stance];
  const emotion = specNode?.emotion ?? STANCE_EMOTION[stance];

  const backgroundKey = specNode?.scene.background;
  const backgroundPath = spec && backgroundKey
    ? spec.assets_manifest.backgrounds[backgroundKey]?.path ?? null
    : null;
  const coverPath =
    spec?.assets_manifest.cover?.path ??
    backgroundPath ??
    spec?.assets_manifest.backgrounds[Object.keys(spec.assets_manifest.backgrounds)[0] ?? ""]?.path ??
    null;

  const portraitUrl =
    portraitFor(spec, speakerMember?.portrait, stance, specNode?.emotion) ??
    w.active?.characters[0]?.portrait ??
    "/mirai/linxia.webp";

  const cue = voice.recording
    ? voice.cue
    : pai?.active_probe?.best_probe
      ? `她准备追问：${pai.active_probe.best_probe}`
      : specNode
        ? `${STANCE_LABEL[stance]} · ${specNode.title}`
        : face.hint;

  const prose = beat.text || viewNode?.meta?.narration || specNode?.text || recall(viewNode ?? undefined);
  const sentences = useSentences(prose, beat.text ? `live-${viewNode?.id}` : viewNode?.id);
  const sent = sentences.current;

  // 自动朗读：只有新的一句完整出现时才读，打字过程中不抢。
  useEffect(() => {
    if (!voiceAuto || !sent) return;
    speak(sent);
  }, [voiceAuto, sent, speak]);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!sent) {
      setTyped("");
      return;
    }
    if (reduce) {
      setTyped(sent);
      return;
    }
    setTyped("");
    let i = 0;
    const timer = window.setInterval(() => {
      i += 2;
      setTyped(sent.slice(0, i));
      if (i >= sent.length) window.clearInterval(timer);
    }, 22);
    return () => window.clearInterval(timer);
  }, [sent, reduce]);

  const advanceSentence = () => {
    if (typed.length < sent.length) {
      setTyped(sent);
      return;
    }
    if (!sentences.atEnd) sentences.next();
  };

  useEffect(() => {
    if (!node?.id) return;
    const staged = pendingKernel.current;
    if (!staged) return;
    pendingKernel.current = null;
    const key = `node:${node.id}`;
    setKernel((prev) => ({ ...prev, [key]: { ...prev[key], ...staged.node } }));
    if (staged.node.paiId) paiIds.current.set(node.id, staged.node.paiId);
  }, [node?.id]);

  const stepTo = (targetSpecId: string) => {
    const target = specTargets.get(targetSpecId);
    if (!target) return false;
    reset();
    setPai(null);
    setChoicesOpen(false);
    w.goBackTo(target);
    // Spec 选项是状态机的边，不是「回滚」；不要弹回滚提示打断代入。
    w.setNotice(null);
    return true;
  };

  // 章节卡：每次换幕短暂出现，像 galgame 的幕间。
  useEffect(() => {
    if (!viewNode) return;
    setChapter(
      spec && specNode
        ? `第 ${spec.logic_nodes.findIndex((node) => node.id === specNode.id) + 1} / ${spec.logic_nodes.length} 幕 · ${specNode.title}`
        : `第 ${path.length} 幕 · ${viewNode.label}`,
    );
    const timer = window.setTimeout(() => setChapter(null), 1800);
    return () => window.clearTimeout(timer);
  }, [viewNode?.id]);

  // AUTO：一句读完自动翻到下一句；遇到选项/生成中停下。
  useEffect(() => {
    if (!auto || pending) return;
    if (!sent || typed.length < sent.length) return;
    if (sentences.atEnd) return;
    const timer = window.setTimeout(() => sentences.next(), 1600);
    return () => window.clearTimeout(timer);
  }, [auto, pending, typed, sent, sentences.atEnd, sentences.next]);

  const submit = async (action: string): Promise<boolean> => {
    const text = action.trim();
    if (!text || pending || !node) return false;
    setInput("");

    const memories = Object.values(node.state.numeric)
      .sort((a, b) => slotMean(b) - slotMean(a))
      .slice(0, 8)
      .map((m) => ({ key: m.key, value: Math.round(slotMean(m)) }));

    const stepPromise = paiStep({
      text,
      prosody: voice.vector,
      parent_id: paiIds.current.get(node.id) ?? "root",
      candidate_probes: suggestions.slice(0, 6).map((s) => s.text),
    });

    const final = await run(
      {
        action: text,
        world: { name: w.active?.name, hook: w.active?.hook, characters: w.active?.characters },
        memories,
      },
      { demoFallback: Boolean(demoMode) },
    );
    const step = await stepPromise;

    if (!final) return false;

    if (step) {
      pendingKernel.current = {
        node: {
          paiId: step.node_id,
          stance: step.stance,
          ruin: step.ruin_prob,
          fingerprint: step.state_fingerprint,
          spread: step.quantiles?.spread,
        },
      };
      setPai(step);
    } else {
      setPai(null);
    }

    w.act(text, {
      narration: final.text,
      scene: final.scene,
      suggestions: final.suggestions.map((x) => x.text),
      memory: final.memory,
    });

    const place = placeBucket(final.scene?.place ?? "");
    const weather = final.scene?.weather ?? "";
    const sig = `${place}|${weather}`;
    const cached = artCache.current.get(sig);

    if (cached && sig !== artRef.current) {
      artRef.current = sig;
      lastPlace.current = place;
      setArt(cached);
    } else if (sig !== artRef.current && (place !== lastPlace.current || !art) && artCount.current < ART_MAX) {
      artRef.current = sig;
      lastPlace.current = place;
      artCount.current += 1;
      void fetch("/mirai-api/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          place: final.scene?.place,
          time: final.scene?.time,
          mood: final.scene?.mood,
          weather: final.scene?.weather,
          worldName: w.active?.name,
          characters: w.active?.characters,
          scene: final.text,
        }),
      })
        .then((res) => res.json())
        .then((data: { url?: string }) => {
          if (!data.url) return;
          setArt(data.url);
          artCache.current.set(sig, data.url);
        })
        .catch(() => {
          /* 画不出来就保持实时渲染 */
        });
    }

    return true;
  };

  const choose = (suggestion: { text: string; specTo?: string }) => {
    if (suggestion.specTo && stepTo(suggestion.specTo)) return;
    void submit(suggestion.text);
  };

  /* ---- 画廊数据 ---- */

  const slots: SaveSlot[] = useMemo(() => {
    const tree = w.tree;
    if (!tree) return [];
    const out: SaveSlot[] = [];
    const seen = new Set<string>();

    const fallbackImage =
      spec?.assets_manifest.cover?.path ??
      spec?.assets_manifest.backgrounds[Object.keys(spec.assets_manifest.backgrounds)[0] ?? ""]?.path;

    const describe = (nodeId: string, key: string, label: string, kind: string): SaveSlot | null => {
      const target = tree.node(nodeId);
      if (!target) return null;
      const reading = readMood(target.state);
      const k = kernel[key];
      const kFace = k?.stance ? STANCE_FACE[k.stance] : null;
      const sceneNode = spec
        ? spec.logic_nodes.find((item) => item.id === target.meta?.specNode)
        : null;
      const bgKey = sceneNode?.scene.background;
      return {
        id: key,
        nodeId,
        label,
        kind,
        steps: tree.pathTo(nodeId).length,
        tone:
          kFace?.tone ??
          (reading.balance > 3
            ? "var(--tone-teal)"
            : reading.balance < -3
              ? "var(--tone-amber)"
              : "var(--tone-sky)"),
        moodWord: balanceWord(reading.balance),
        quote: (target.meta?.narration || target.label || "").slice(0, 46),
        image: (bgKey ? spec?.assets_manifest.backgrounds[bgKey]?.path : undefined) ?? fallbackImage,
        stance: k?.stance,
        ruin: k?.ruin,
        fingerprint: k?.fingerprint,
        spread: k?.spread,
        commutativity: k?.commutativity,
      };
    };

    for (const lane of w.lanes) {
      const slot = describe(lane.cursor, `lane:${lane.id}`, lane.label, "lane");
      if (slot) {
        out.push(slot);
        seen.add(lane.cursor);
      }
    }

    const extras = [...(tree.nodes ?? [])]
      .filter((item) => item.kind === "branch" || item.kind === "merge")
      .reverse();
    for (const extra of extras) {
      if (out.length >= 10) break;
      if (seen.has(extra.id)) continue;
      seen.add(extra.id);
      const slot = describe(extra.id, `node:${extra.id}`, extra.label, extra.kind);
      if (slot) out.push(slot);
    }

    return out;
  }, [w.tree, w.lanes, kernel, spec]);

  const openSlot = (slot: SaveSlot) => {
    reset();
    setArt(null);
    setPai(null);
    setTab(null);
    setChoicesOpen(false);
    setEntered(true);
    if (slot.kind === "lane") {
      w.focusLane(slot.id.slice("lane:".length));
    } else {
      w.goBackTo(slot.nodeId);
    }
  };

  const probe = async () => {
    if (!node || probing) return;
    setProbing(true);
    const names = ["探路 · 摊牌", "探路 · 试探", "探路 · 退半步"];
    const fallback = ["把话说到底", "先探一句她的底", "退半步，看她的反应"];
    const acts = suggestions.slice(0, 3).map((s) => s.text);
    const parent = kernel[`node:${node.id}`]?.paiId ?? paiIds.current.get(node.id) ?? "root";
    const laneIds = names.map((name) => w.addLane(name)).filter((id): id is string => Boolean(id));

    const results = await Promise.all(
      names.map((name, index) =>
        paiStep({
          text: acts[index] ?? fallback[index],
          parent_id: parent,
          node_id: `probe-${node.id}-${index}`,
        }),
      ),
    );

    setKernel((prev) => {
      const next = { ...prev };
      laneIds.forEach((laneId, index) => {
        const result = results[index];
        if (!result) return;
        next[`lane:${laneId}`] = {
          paiId: result.node_id,
          stance: result.stance,
          ruin: result.ruin_prob,
          fingerprint: result.state_fingerprint,
          spread: result.quantiles?.spread,
        };
      });
      return next;
    });
    setProbing(false);
  };

  const merge = async (a: SaveSlot, b: SaveSlot) => {
    if (a.nodeId === b.nodeId) {
      setReport({ ok: false, message: "这两张存档已经在同一步上了，换两张再合。" });
      return;
    }
    const left = kernel[a.id]?.paiId;
    const right = kernel[b.id]?.paiId;
    const paiResult = left && right ? await paiMerge3({ left_id: left, right_id: right, base_id: "root" }) : null;
    const result = w.mergeNodes(a.nodeId, b.nodeId);

    if (result.ok && result.nodeId) {
      const laneId = w.addLane("✦ 合流破局");
      if (laneId && paiResult) {
        setKernel((prev) => ({
          ...prev,
          [`lane:${laneId}`]: {
            paiId: paiResult.node_id,
            fingerprint: paiResult.state_fingerprint,
            commutativity: paiResult.commutativity_max_diff,
            stance: "neutral",
          },
        }));
      }
    }

    setReport({
      ok: result.ok,
      message: result.message,
      commutativity: paiResult?.commutativity_max_diff,
    });
  };

  /* ---- 世界仓库 ---- */

  const loadSample = (sample: WorldSpec) => {
    w.loadSpec(sample);
  };

  const publish = async () => {
    if (!spec) {
      w.setNotice({ tone: "info", text: "当前世界不是从 Spec 载入的，先载入一份。" });
      return;
    }
    const result = await pushSpec(spec);
    w.setNotice({
      tone: result.ok ? "ok" : "error",
      text: result.ok
        ? `已发布到服务端 v${result.version ?? "?"}，其他窗口会在 1.5 秒内切过去。`
        : result.errors?.[0] ?? "发布失败",
    });
  };

  const loadPasted = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(specText);
    } catch {
      w.setNotice({ tone: "error", text: "这段不是合法 JSON。" });
      return;
    }
    const check = validateWorldSpec(parsed);
    if (!check.ok || !check.spec) {
      w.setNotice({
        tone: "error",
        text: check.errors[0] ? `${check.errors[0].path}：${check.errors[0].message}` : "Spec 校验失败",
      });
      return;
    }
    w.loadSpec(check.spec);
    setSpecText("");
    setTab(null);
    setEntered(false);
    w.setNotice({
      tone: "ok",
      text: check.warnings.length
        ? `载入了「${check.spec.title}」，有 ${check.warnings.length} 条资源警告。`
        : `载入了「${check.spec.title}」。`,
    });
  };

  const runFactory = async () => {
    setPlanBusy(true);
    const result = await planAssets({ theme: theme.trim() || "一场必须今晚谈完的高利害对话" });
    setPlanBusy(false);
    if (!result.ok || !result.spec) {
      w.setNotice({ tone: "error", text: result.errors?.[0] ?? "工厂没有返回世界骨架" });
      return;
    }
    setPlan({ spec: result.spec, tasks: result.tasks ?? [], provider: result.provider });
    setAssetNote(null);
    setAssetUrl(null);
  };

  const tryAsset = async () => {
    const task = plan?.tasks[0];
    if (!task) return;
    setAssetBusy(true);
    setAssetNote(null);
    const result = await generateAsset(task);
    setAssetBusy(false);
    if (result.ok && result.url) {
      setAssetUrl(result.url);
      setAssetNote("第一张背景已经出片，路径写回 Spec 后这个世界的画面就会换。");
    } else {
      setAssetNote(result.reason ?? "生成失败");
    }
  };

  const loadPlan = () => {
    if (!plan) return;
    w.loadSpec(plan.spec);
    setTab(null);
    setEntered(false);
    setPlan(null);
  };

  /* ---- 渲染 ---- */

  if (!node || !viewNode) {
    return (
      <div className="page">
        <EmptyState
          title="这个世界还没有内容"
          description="先新建一个世界，或者从文件载入一个。"
          action={<Button onClick={onHome}>返回</Button>}
        />
      </div>
    );
  }

  const memories = Object.values(viewNode.state.numeric)
    .sort((a, b) => slotMean(b) - slotMean(a))
    .slice(0, 8);

  const meta = [
    specNode?.scene.place ?? scene?.place,
    specNode?.scene.time ?? scene?.time,
    specNode?.scene.weather ?? scene?.weather,
    specIndex >= 0 && spec ? `第 ${specIndex + 1} / ${spec.logic_nodes.length} 幕` : `${path.length} 步`,
  ]
    .filter(Boolean)
    .join(" · ");

  const drawerTitle = tab ? TITLES[tab] : TITLES.saves;
  const shownPortrait = portraitUrl;

  return (
    <div
      className={styles.shell}
      data-palette={spec?.ui?.palette ?? "warm"}
      data-stance={stance}
      data-choices={choicesOpen && !pending && suggestions.length > 0 ? "" : undefined}
      style={
        {
          "--stage-tone": face.tone,
          "--dialogue-accent": face.tone,
        } as CSSProperties
      }
    >
      <div className={styles.scene} aria-hidden>
        <SceneCanvas
          params={{
            place: scene?.place ?? "",
            time: scene?.time ?? "",
            mood: scene?.mood ?? "",
            weather: scene?.weather ?? "",
            hour: Number(viewNode.meta?.hour ?? "18") || 18,
            memories: memories.slice(0, 6).map((m) => ({
              key: m.key,
              value: Math.round(slotMean(m)),
            })),
          }}
        />
        {backgroundPath ? (
          <div
            key={backgroundPath}
            className={styles.bgArt}
            style={{ backgroundImage: `url(${backgroundPath})` }}
          />
        ) : art ? (
          <div key={art} className={styles.bgArt} style={{ backgroundImage: `url(${art})` }} />
        ) : null}
      </div>
      <div className={styles.tint} aria-hidden />

      <div className={styles.character} aria-hidden>
        <img className={styles.characterImg} src={shownPortrait} alt="" data-emotion={emotion} />
      </div>

      <header className={styles.top}>
        <button
          type="button"
          className="icon-button"
          onClick={onHome}
          aria-label="返回上一页"
        >
          <ArrowLeft size={20} strokeWidth={1.75} aria-hidden />
        </button>
        <span className={styles.topTitle}>{w.active?.name ?? "未命名世界"}</span>
        <span className={styles.topSpacer} />
        <Button variant="ghost" size="sm" onClick={onEdit}>
          编辑
        </Button>
      </header>

      <main className={styles.stage}>
        <AnimatePresence>
          {isEnding && !pending ? (
            <motion.section
              className={styles.endingCard}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}
            >
              <span className={styles.endingKicker}>
                结局 · {specIndex >= 0 && spec ? `${specIndex + 1} / ${spec.logic_nodes.length}` : "THE END"}
              </span>
              <h2>{specNode?.title ?? viewNode.label}</h2>
              <p>这条世界线在这里收束。你可以回到上一个分叉，或者换一条线。</p>
              <div className={styles.endingActions}>
                <Button
                  size="sm"
                  disabled={!lastForkId}
                  onClick={() => {
                    if (!lastForkId) return;
                    reset();
                    setPai(null);
                    setChoicesOpen(true);
                    w.goBackTo(lastForkId);
                  }}
                >
                  回到上一个分叉
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setTab("saves")}>
                  换一条世界线
                </Button>
              </div>
            </motion.section>
          ) : null}
        </AnimatePresence>

        <div className={styles.choices} data-open={choicesOpen && !pending && suggestions.length > 0 ? "" : undefined}>
          {suggestions.slice(0, 4).map((suggestion, index) => (
            <Button
              key={`${suggestion.text}-${index}`}
              className={styles.choice}
              variant="secondary"
              onClick={() => choose(suggestion)}
            >
              {suggestion.text}
            </Button>
          ))}
        </div>

        <div className={styles.textbox} onClick={advanceSentence}>
          {voice.noisy && (
            <div
              className={styles.noiseWarn}
              role="alert"
              onClick={(event) => event.stopPropagation()}
            >
              <span>
                环境较吵闹{voice.noiseDb !== null ? `（当前底噪 ${voice.noiseDb} dB）` : ""}，可能影响声学辨心精度，建议在安静地方使用
              </span>
            </div>
          )}
          <form
            className={styles.replyBar}
            onClick={(event) => event.stopPropagation()}
            data-open={replyOpen ? "" : undefined}
            onSubmit={(event) => {
              event.preventDefault();
              void submit(input);
            }}
          >
            <input
              ref={replyRef}
              className={styles.replyInput}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="像真正在场一样，直接对她说一句（她有自己的脾气，不会顺着你）"
              aria-label="对她说"
            />
            <VoiceProsodyButton
              recording={voice.recording}
              tension={voice.tension}
              energy={voice.energy}
              onStart={() => void voice.start((text) => setInput(text))}
              onStop={voice.stop}
            />
            <Button type="submit" size="sm" disabled={!input.trim() || pending} aria-label="说这一句">
              <ArrowUp size={16} strokeWidth={2} aria-hidden />
            </Button>
          </form>

          <div className={styles.dialogue}>
            <div className={styles.namePlate}>
              <Avatar
                size="sm"
                name={specNode?.speaker ?? w.active?.characters[0]?.name ?? "Selene"}
                src={speakerMember?.portrait ? portraitUrl : w.active?.characters[0]?.portrait}
              />
              <span className={styles.nameText}>
                {specNode?.speaker ?? w.active?.characters[0]?.name ?? "Selene"}
              </span>
              <span className={styles.nameMeta}>{meta || cue}</span>
              <Badge tone={face.badge} size="sm">
                {face.label}
              </Badge>
              <button
                type="button"
                className={styles.speak}
                aria-label="朗读这一句"
                onClick={() => speak(sent || typed)}
              >
                <Volume2 size={14} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
            {pending && !beat.text ? (
              <Skeleton lines={2} label="世界正在回应" />
            ) : (
              <p className={styles.line}>
                {typed || <span className={styles.placeholder}>写一句，或者按住开口。</span>}
                {(typed.length < sent.length || pending) && (
                  <span className={styles.cursor} aria-hidden>
                    ▼
                  </span>
                )}
              </p>
            )}
          </div>

          <nav
            className={styles.sysbar}
            aria-label="舞台操作"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="sm"
              className={styles.sysButton}
              data-on={auto ? "" : undefined}
              onClick={() => setAuto((value) => !value)}
            >
              AUTO
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.sysButton}
              data-on={voiceAuto ? "" : undefined}
              onClick={() => {
                const next = !voiceAuto;
                setVoiceAuto(next);
                try {
                  localStorage.setItem("mirai.voice.auto", next ? "1" : "0");
                } catch {
                  // 隐私模式下存不了，本次会话仍然生效
                }
                if (!next) window.speechSynthesis?.cancel();
              }}
            >
              朗读
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.sysButton}
              onClick={() => {
                setReplyOpen((open) => {
                  const next = !open;
                  if (next) window.setTimeout(() => replyRef.current?.focus(), 40);
                  return next;
                });
              }}
            >
              开口回应
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.sysButton}
              onClick={() => setChoicesOpen((open) => !open)}
            >
              岔路选项
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.sysButton}
              onClick={() => {
                void probe();
                setTab("saves");
              }}
            >
              Agent 探路
            </Button>
            <Button variant="ghost" size="sm" className={styles.sysButton} onClick={() => setTab("world")}>
              世界
            </Button>
            <span className={styles.sysExtra}>
            <span className={styles.sysDivider} aria-hidden />
            <Button variant="ghost" size="sm" className={styles.sysButton} onClick={w.quickSave}>
              Q.Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.sysButton}
              onClick={() => {
                w.quickLoad();
                reset();
                setPai(null);
              }}
            >
              Q.Load
            </Button>
            <Button variant="ghost" size="sm" className={styles.sysButton} onClick={() => setTab("saves")}>
              SAVE
            </Button>
            <Button variant="ghost" size="sm" className={styles.sysButton} onClick={() => setTab("saves")}>
              LOAD
            </Button>
            <Button variant="ghost" size="sm" className={styles.sysButton} onClick={() => setTab("history")}>
              LOG
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.sysButton}
              onClick={() => {
                const previous = path[path.length - 2];
                if (!previous) return;
                reset();
                setPai(null);
                w.goBackTo(previous.id);
              }}
            >
              BACK
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={styles.sysButton}
              onClick={() => (spec ? setEntered(false) : onHome())}
            >
              TITLE
            </Button>
            </span>
          </nav>
        </div>
      </main>

      <AnimatePresence>
        {spec && !entered ? (
          <motion.div
            key={spec.id}
            className={styles.titleCurtain}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: motionTokens.duration.standard } }}
            transition={{ duration: reduce ? 0 : motionTokens.duration.considered }}
          >
            <div
              className={styles.titleArt}
              style={{ backgroundImage: coverPath ? `url(${coverPath})` : undefined }}
              aria-hidden
            />
            <div className={styles.titleBar}>
              <div className={styles.titleBlock}>
                <h1>{spec.title}</h1>
                <p>{spec.subtitle ?? spec.logline ?? ""}</p>
              </div>
              <nav className={styles.titleNav}>
                <Button variant="ghost" onClick={() => setEntered(true)}>
                  开始推演
                </Button>
                <span aria-hidden>·</span>
                <Button variant="ghost" onClick={() => setEntered(true)}>
                  继续
                </Button>
                <span aria-hidden>·</span>
                <Button variant="ghost" onClick={() => setTab("saves")}>
                  世界线画廊
                </Button>
                <span aria-hidden>·</span>
                <Button variant="ghost" onClick={onForge}>
                  换一个世界
                </Button>
              </nav>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Drawer
        open={tab !== null}
        onOpenChange={(open) => {
          if (!open) setTab(null);
        }}
      >
        <DrawerContent
          side={compact ? "bottom" : "right"}
          className={styles.gallerySheet}
          title={drawerTitle.title}
          description={drawerTitle.description}
        >
          <div className={styles.sheet}>
            <div className={styles.tabs}>
              <SegmentedControl
                label="世界线抽屉"
                value={tab ?? "saves"}
                onValueChange={(next) => setTab(next as Tab)}
                options={[
                  { value: "saves", label: "存档" },
                  { value: "memory", label: "记忆" },
                  { value: "history", label: "历史" },
                  { value: "world", label: "世界" },
                ]}
              />
            </div>

            {tab === "saves" || tab === null ? (
              <WorldlineGallery
                slots={slots}
                busy={probing}
                report={report}
                onOpen={openSlot}
                onMerge={merge}
                onProbe={probe}
                onClose={() => setTab(null)}
                onHome={onHome}
                onWorld={() => setTab("world")}
                onEnter={() => {
                  setTab(null);
                  setEntered(true);
                }}
              />
            ) : null}

            {tab === "memory" ? (
              <div className={styles.stack}>
                {memories.length ? (
                  memories.map((m) => (
                    <div key={m.uid} className={styles.memRow}>
                      <span className={styles.memKey}>{m.key}</span>
                      <span className={styles.memBar}>
                        <span
                          className={styles.memFill}
                          style={{ width: `${Math.min(100, (slotMean(m) / 10) * 100)}%` }}
                        />
                      </span>
                      <span className={styles.memValue}>{slotMean(m).toFixed(0)}</span>
                    </div>
                  ))
                ) : (
                  <EmptyState
                    title="还没有记忆"
                    description="写一句让她做的事，这里就会长出来。"
                    action={<Button onClick={() => setTab(null)}>去写一句</Button>}
                  />
                )}

                <p className={styles.lead}>回到走过的某一步</p>
                <div className={styles.row}>
                  {path.slice(-8).map((stop) => (
                    <Button
                      key={stop.id}
                      size="sm"
                      variant={stop.id === viewNode.id ? "primary" : "secondary"}
                      onClick={() => {
                        reset();
                        setPai(null);
                        w.goBackTo(stop.id);
                        setTab(null);
                      }}
                    >
                      {stop.label}
                    </Button>
                  ))}
                </div>

                <div className={styles.stack}>
                  <Input
                    label="分叉名称"
                    value={forkName}
                    onChange={(event) => setForkName(event.target.value)}
                    placeholder="例如：如果她拒绝了"
                  />
                  <Button
                    onClick={() => {
                      w.forkHere(forkName.trim() || `分支 ${(w.tree?.children(node.id).length ?? 0) + 1}`);
                      setForkName("");
                      setTab(null);
                    }}
                  >
                    从这里分一条
                  </Button>
                </div>
              </div>
            ) : null}

            {tab === "history" ? (
              <div>
                {w.audit.length ? (
                  [...w.audit]
                    .reverse()
                    .slice(0, 40)
                    .map((entry) => (
                      <div key={entry.seq} className={styles.historyRow}>
                        <span>{entry.detail}</span>
                        <span className={styles.historyTime}>
                          {new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}
                        </span>
                      </div>
                    ))
                ) : (
                  <EmptyState title="还没有操作" description="写一句让她做的事，历史就开始记录。" />
                )}
              </div>
            ) : null}

            {tab === "world" ? (
              <div className={styles.stack}>
                <div className={styles.specMeta}>
                  <span className={styles.specCell}>
                    当前世界
                    <b>{spec?.title ?? w.active?.name ?? "本地世界"}</b>
                  </span>
                  <span className={styles.specCell}>
                    Spec
                    <b>{spec?.id ?? "未使用"}</b>
                  </span>
                  <span className={styles.specCell}>
                    服务端仓库
                    <b>{specSync.online ? `v${specSync.version}` : "未连接"}</b>
                  </span>
                  <span className={styles.specCell}>
                    资产
                    <b>
                      {spec
                        ? `${Object.keys(spec.assets_manifest.backgrounds).length} 背景 · ${Object.keys(spec.assets_manifest.portraits).length} 立绘`
                        : "实时渲染"}
                    </b>
                  </span>
                </div>

                <p className={styles.lead}>载入一个内置世界，渲染器不会重启。</p>
                <div className={styles.row}>
                  {SPEC_SAMPLES.map((sample) => (
                    <Button
                      key={sample.id}
                      size="sm"
                      variant={spec?.id === sample.id ? "primary" : "secondary"}
                      onClick={() => loadSample(sample)}
                    >
                      {sample.title}
                    </Button>
                  ))}
                  <Button size="sm" variant="secondary" onClick={() => void publish()} disabled={!spec}>
                    发布到服务端
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => spec && void previewShell(spec)} disabled={!spec}>
                    预览游戏壳
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => spec && void downloadShell(spec)} disabled={!spec}>
                    导出 H5
                  </Button>
                </div>

                <Input
                  label="从一个主题拆解世界"
                  value={theme}
                  onChange={(event) => setTheme(event.target.value)}
                  placeholder="例如：合伙人雨夜散伙前的最后一轮谈判"
                />
                <Button variant="secondary" onClick={() => void runFactory()} loading={planBusy}>
                  拆解为 10 个叙事节点
                </Button>

                {plan ? (
                  <div className={styles.stack}>
                    <div className={styles.specMeta}>
                      <span className={styles.specCell}>
                        生成的骨架
                        <b>{plan.spec.title}</b>
                      </span>
                      <span className={styles.specCell}>
                        资产任务
                        <b>
                          {plan.tasks.filter((task) => task.kind === "background").length} 背景 ·{" "}
                          {plan.tasks.filter((task) => task.kind === "portrait").length} 立绘切片
                        </b>
                      </span>
                      <span className={styles.specCell}>
                        图像 provider
                        <b>{plan.provider ?? "未配置"}</b>
                      </span>
                    </div>
                    <div className={styles.nodeList}>
                      {plan.spec.logic_nodes.map((item) => (
                        <span key={item.id} className={styles.nodeChip}>
                          {item.title}
                        </span>
                      ))}
                    </div>
                    <p className={styles.taskSummary}>
                      Prompt 已按 Visual Codebook 写好（统一色温、光位、镜头、饱和度）。
                      生成接口会把 provider 的真实结果原样带回来，余额不足也会照实说。
                    </p>
                    <div className={styles.row}>
                      <Button variant="secondary" onClick={() => void tryAsset()} loading={assetBusy}>
                        生成一张试片
                      </Button>
                      <Button onClick={loadPlan}>载入这个骨架</Button>
                    </div>
                    {assetNote ? (
                      <Alert tone={assetUrl ? "success" : "warning"} title={assetUrl ? "试片完成" : "这次没出片"}>
                        {assetNote}
                      </Alert>
                    ) : null}
                    {assetUrl ? <img className={styles.assetPreview} src={assetUrl} alt="资产工厂试片" /> : null}
                  </div>
                ) : null}

                <Textarea
                  label="粘贴一段 World-Spec"
                  value={specText}
                  onChange={(event) => setSpecText(event.target.value)}
                  placeholder='{"spec_version":"1.0","id":"my-world", ...}'
                />
                <div className={styles.row}>
                  <Button variant="secondary" onClick={loadPasted} disabled={!specText.trim()}>
                    校验并载入
                  </Button>
                  <Button variant="ghost" onClick={() => setSpecText(JSON.stringify(spec ?? SPEC_SAMPLES[0], null, 2))}>
                    填入当前 Spec
                  </Button>
                </div>

                <div className={styles.row}>
                  <Button onClick={w.exportFile}>
                    <Download size={16} strokeWidth={1.75} aria-hidden />
                    导出世界文件
                  </Button>
                  <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                    从文件载入
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      const text = await file.text();
                      setImportText(text.slice(0, 2000));
                      w.importFile(text);
                      event.target.value = "";
                    }}
                  />
                </div>

                <Textarea
                  label="或粘贴世界文件"
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                />
                <Button variant="secondary" onClick={() => w.importFile(importText)} disabled={!importText.trim()}>
                  载入这段内容
                </Button>

                {w.report ? (
                  <Alert
                    tone={w.report.fileOk ? "success" : "danger"}
                    title={w.report.fileOk ? "这个世界是完整的" : "这个世界有问题"}
                  >
                    {w.report.message}
                  </Alert>
                ) : null}
              </div>
            ) : null}
          </div>
        </DrawerContent>
      </Drawer>

      <AnimatePresence>
        {w.notice || error ? (
          <motion.div
            role="status"
            className={styles.notice}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: motionTokens.duration.exit } }}
            transition={reduce ? { duration: 0 } : motionTokens.spring.snappy}
          >
            {error ?? w.notice?.text}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
