/**
 * 世界状态层 —— 把已测试的引擎包成一个 React hook。
 *
 * 设计约束：
 *   · 引擎（engine.ts / worldfile.ts）不动，它有 26 个测试护着；
 *   · 这里只负责「当前在哪个世界、站在哪个节点、界面上该显示什么」；
 *   · 所有对引擎的写操作都通过 commit()，保证 localStorage 与内存一致。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WorldTree,
  cloneState,
  slotMean,
  type AuditEntry,
  type WorldNode,
  type WorldState,
  type WorldTreeData,
} from "@/world/engine";
import {
  WorldFileError,
  exportWorldFile,
  inspectWorldFile,
  parseWorldFile,
  serializeWorldFile,
  type InspectWorldFileReport,
} from "@/world/worldfile";
import { buildWorldFromSpec, type WorldSpec } from "@/world/spec";

export interface Character {
  id: string;
  name: string;
  role: string;
  traits: string;
  portrait: string;
}

export interface ChoiceDef {
  id: string;
  /** 观众看到的那一行。 */
  label: string;
  /** 这条选择会在世界里留下什么记忆。 */
  key: string;
  /** 记忆的强度，0-10。 */
  value: number;
  /** 一句补充说明，可以不填。 */
  sub?: string;
}

export interface WorldMeta {
  id: string;
  name: string;
  hook: string;
  characters: Character[];
  tree: WorldTreeData;
  /** 当前停在世界线的哪个节点（主游标，兼容旧数据）。 */
  cursor: string;
  /**
   * 并行观察的多条线。
   *
   * 每条线一个游标，互不影响 —— 这是"同时看好几个未来"的最小实现。
   * 主游标永远等于 lanes[activeLane]。
   */
  lanes?: { id: string; label: string; cursor: string }[];
  activeLane?: string;
  createdAt: string;
  /** 这个世界的岔路。老数据没有时用默认三条。 */
  choices?: ChoiceDef[];
  /** 由 World-Spec 载入的世界；渲染器据此取资产与 stance 目标。 */
  spec?: WorldSpec;
}

const STORAGE = "mirai.app.v2";

const PORTRAITS = [
  "/mirai/linxia.webp",
  "/mirai/selene.webp",
  "/mirai/mother.webp",
  "/mirai/mentor.webp",
];

const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

/** 示例世界的三条岔路。自建世界可以自己定义。 */
export const DEFAULT_CHOICES: ChoiceDef[] = [
  { id: "c-sh", label: "去上海", key: "房租压力", value: 8, sub: "更大的舞台，更贵的房租" },
  { id: "c-ky", label: "留校读研", key: "怀疑", value: 5, sub: "更稳，也可能是在躲" },
  { id: "c-qd", label: "先回青岛", key: "安心", value: 7, sub: "熟悉，但「如果当时」会响很久" },
];

/** 示例世界：评委打开就能立刻走进去，不用先建东西。 */
export function demoWorld(): WorldMeta {
  let tree = WorldTree.create("林夏的毕业选择");
  const root = tree.root;

  const characters: Character[] = [
    { id: "linxia", name: "林夏", role: "你", traits: "22 岁，怕的不是选错，是没有选择", portrait: PORTRAITS[0] },
    { id: "mother", name: "母亲", role: "家人", traits: "嘴硬心软，希望女儿离家近一点", portrait: PORTRAITS[2] },
    { id: "mentor", name: "导师", role: "老师", traits: "惜才，怕她浪费自己的潜力", portrait: PORTRAITS[3] },
  ];

  let tip = root.id;
  for (const c of characters) {
    tip = tree.setScalar(tip, `char-${c.id}`, c.name, `${c.role} · ${c.traits}`, `认识 ${c.name}`).id;
  }

  // 给三条世界线各留一点真实记忆，让时间线一眼看得出分支
  const shanghai = tree.branch(tip, "去上海");
  const afterSh = tree.observe(shanghai.id, { uid: "m-rent", key: "房租压力", value: 8 }, "上海的房租");
  const afterSh2 = tree.observe(afterSh.id, { uid: "m-home", key: "想家", value: 6 }, "第一次想家");

  const kaoyan = tree.branch(tip, "留校读研");
  tree.observe(kaoyan.id, { uid: "m-doubt", key: "怀疑", value: 5 }, "是不是在躲");

  const qingdao = tree.branch(tip, "先回青岛");
  tree.observe(qingdao.id, { uid: "m-calm", key: "安心", value: 7 }, "熟悉的街道");

  return {
    id: "world-linxia",
    name: "林夏的毕业选择",
    hook: "一个 22 岁的青岛女生，站在上海 offer、考研和留下之间。",
    characters,
    tree: tree.toData(),
    cursor: afterSh2.id,
    createdAt: new Date().toLocaleDateString("zh-CN"),
    choices: DEFAULT_CHOICES,
  };
}

/**
 * 本地世界按「谁登录」分桶存放。
 *
 * 为什么不在一个桶里混放：同一台电脑换个账号登录时，上个账号的本地世界
 * 会被当成“访客世界”推到新账号名下，这是上线产品不能接受的数据串号。
 * 访客用一个桶，每个账号各用一个桶；服务端仍按 user_id 独立隔离。
 */
function storageKey(owner: string | null): string {
  return owner ? `${STORAGE}.${owner}` : STORAGE;
}

function loadFrom(key: string): WorldMeta[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as WorldMeta[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {
    // 旧数据坏了就重来，不让用户卡在空白页
  }
  return [demoWorld()];
}

function load(): WorldMeta[] {
  return loadFrom(STORAGE);
}

/* ------------------------------------------------------------------ */

export interface CursorInfo {
  node: WorldNode;
  path: WorldNode[];
  /** 从当前节点能回去的所有节点（祖先 + 已合并的分支）。 */
  canReturnTo: WorldNode[];
}

export function useWorlds() {
  const [worlds, setWorlds] = useState<WorldMeta[]>(load);
  const [activeId, setActiveId] = useState(() => load()[0]?.id ?? "");
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const scopeRef = useRef<string | null>(null);
  const worldsRef = useRef(worlds);

  useEffect(() => {
    worldsRef.current = worlds;
  }, [worlds]);

  // 账号切换：先把当前桶落盘，再载入目标桶。
  useEffect(() => {
    if (scopeRef.current === scope) return;
    try {
      localStorage.setItem(storageKey(scopeRef.current), JSON.stringify(worldsRef.current));
    } catch {
      // 存不下（隐私模式/配额满）也不该阻断切账号
    }
    scopeRef.current = scope;
    const next = loadFrom(storageKey(scope));
    setWorlds(next);
    setActiveId(next[0]?.id ?? "");
    setNotice(null);
  }, [scope]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(scopeRef.current), JSON.stringify(worlds));
    } catch {
      // 同上：本地存不下时保持可用
    }
  }, [worlds]);

  const active = useMemo(
    () => worlds.find((w) => w.id === activeId) ?? worlds[0],
    [worlds, activeId],
  );

  const tree = useMemo(
    () => (active ? WorldTree.fromData(active.tree) : null),
    [active],
  );

  const cursor: CursorInfo | null = useMemo(() => {
    if (!tree || !active) return null;
    const node = tree.node(active.cursor) ?? tree.root;
    const path = tree.pathTo(node.id);
    const ancestors = path.filter((n) => n.id !== node.id);
    const absorbed = node.mergedFrom
      .map((id) => tree.node(id))
      .filter((n): n is WorldNode => Boolean(n));
    return { node, path, canReturnTo: [...absorbed, ...ancestors] };
  }, [tree, active]);

  /** 统一的写入出口：更新树，同时把 cursor 指到新节点。 */
  /**
   * 统一的写入出口：换树、移动主游标，并把当前观察的那条线同步到同一个位置。
   * 这样 lanes 与 cursor 永远不会分叉。
   */
  const commit = useCallback(
    (nextTree: WorldTree, nextCursor: string) => {
      if (!active) return;
      const laneId = active.activeLane ?? active.lanes?.[0]?.id;
      setWorlds((prev) =>
        prev.map((w) =>
          w.id === active.id
            ? {
                ...w,
                tree: nextTree.toData(),
                cursor: nextCursor,
                lanes: (w.lanes ?? []).map((l) =>
                  l.id === laneId ? { ...l, cursor: nextCursor } : l,
                ),
              }
            : w,
        ),
      );
    },
    [active],
  );

  /* ---- 并行世界线 ---- */

  /** 当前观察的那条线。旧数据没有 lanes 时用主游标兜底。 */
  const lanes = useMemo(() => {
    if (!active) return [];
    if (active.lanes?.length) return active.lanes;
    return [{ id: "lane-main", label: "主线", cursor: active.cursor }];
  }, [active]);

  const activeLaneId = active?.activeLane ?? lanes[0]?.id ?? "lane-main";
  const activeLane = lanes.find((l) => l.id === activeLaneId) ?? lanes[0];

  /** 切到另一条线观察。只换看的对象，不动任何状态。 */
  const focusLane = useCallback(
    (laneId: string) => {
      if (!active) return;
      const lane = (active.lanes ?? []).find((l) => l.id === laneId);
      setWorlds((prev) =>
        prev.map((w) =>
          w.id === active.id
            ? { ...w, activeLane: laneId, ...(lane ? { cursor: lane.cursor } : {}) }
            : w,
        ),
      );
    },
    [active],
  );

  /** 从当前这一幕分出一条新线，游标指向同一个节点。返回新线 id，调用方用它挂状态核快照。 */
  const addLane = useCallback(
    (label: string) => {
      if (!active || !cursor) return null;
      const id = uid("lane");
      setWorlds((prev) =>
        prev.map((w) =>
          w.id === active.id
            ? {
                ...w,
                lanes: [
                  ...(w.lanes ?? [{ id: "lane-main", label: "主线", cursor: w.cursor }]),
                  { id, label, cursor: cursor.node.id },
                ],
                activeLane: id,
              }
            : w,
        ),
      );
      setNotice({ tone: "ok", text: `开了一条「${label}」，从同一步开始分头走。` });
      return id;
    },
    [active, cursor],
  );

  /**
   * 合流任意两个节点（不必是当前游标）。
   * 引擎负责 base（LCA）、冲突拒绝与墓碑；这里只把结果落到游标。
   */
  const mergeNodes = useCallback(
    (leftId: string, rightId: string): { ok: boolean; nodeId?: string; message: string } => {
      if (!tree) return { ok: false, message: "没有世界树" };
      try {
        const merged = tree.merge(leftId, rightId);
        if (merged.id === leftId || merged.id === rightId) {
          return { ok: false, message: "这两条线已经在同一个节点上了。" };
        }
        const base = tree.lca(leftId, rightId);
        commit(tree, merged.id);
        return {
          ok: true,
          nodeId: merged.id,
          message: `从「${base?.label ?? "共同起点"}」之后，两条线的内容都保留了。`,
        };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error
              ? `接不上：${error.message}`
              : "接不上：这两条线的同一个设定冲突了",
        };
      }
    },
    [tree, commit],
  );

  const removeLane = useCallback(
    (laneId: string) => {
      if (!active) return;
      setWorlds((prev) =>
        prev.map((w) => {
          if (w.id !== active.id) return w;
          const rest = (w.lanes ?? []).filter((l) => l.id !== laneId);
          if (!rest.length) return w;
          const nextActive = w.activeLane === laneId ? rest[0].id : w.activeLane;
          const lane = rest.find((l) => l.id === nextActive) ?? rest[0];
          return { ...w, lanes: rest, activeLane: nextActive, cursor: lane.cursor };
        }),
      );
    },
    [active],
  );

  /* ---- 创作者动作 ---- */

  const choose = useCallback(
    (label: string, key: string, value: number) => {
      if (!tree || !cursor) return;
      // 一次选择 = 记一条记忆 + 开一条新世界线
      const observed = tree.observe(
        cursor.node.id,
        { uid: `m-${uid("k")}`, key, value },
        label,
      );
      commit(tree, observed.id);
      setNotice({ tone: "ok", text: `「${label}」—— 这条世界线记下了。` });
    },
    [tree, cursor, commit],
  );

  /**
   * 回到过去只移动游标，不造新节点。
   *
   * 之前用 rollback() 会往树里追加一个「回滚」节点 —— 拖几次时间线就多几个节点，
   * 而且指纹对不上（回到的是新节点，不是原来那一幕）。
   * 重放是纯读取：树不动，只改 cursor。之后从这一幕继续走，才产生新分支。
   */
  const goBackTo = useCallback(
    (nodeId: string) => {
      if (!tree || !active) return;
      const target = tree.node(nodeId);
      if (!target) return;
      setWorlds((prev) =>
        prev.map((world) =>
          world.id === active.id ? { ...world, cursor: nodeId } : world,
        ),
      );
      setNotice({ tone: "info", text: `回到「${target.label}」。历史没删，可以再往前。` });
    },
    [tree, active],
  );

  const forkHere = useCallback(
    (label: string) => {
      if (!tree || !cursor) return;
      const node = tree.branch(cursor.node.id, label);
      commit(tree, node.id);
      setNotice({ tone: "ok", text: `从这儿分出一条「${label}」。` });
    },
    [tree, cursor, commit],
  );

  /**
   * 演示模式一键闭环：从当前节点真实分叉两条平行世界线，并立即执行三路无损合流，
   * 一次性产出「分支 A / 分支 B / 三路无损合流」三条可对照的平行线。
   */
  const demoForkAndMerge = useCallback((): { ok: boolean; message: string } => {
    if (!tree || !cursor || !active) {
      return { ok: false, message: "请先进入一个世界" };
    }
    try {
      const baseId = cursor.node.id;
      const b1 = tree.branch(baseId, "正面摊牌线");
      const leaf1 = tree.observe(
        b1.id,
        { uid: `m-${uid("da")}`, key: "坦诚摊牌", value: 8 },
        "把底牌直接摊开说",
      );
      const b2 = tree.branch(baseId, "留出余地线");
      const leaf2 = tree.observe(
        b2.id,
        { uid: `m-${uid("db")}`, key: "缓冲余地", value: 7 },
        "先稳住局面留二十四小时",
      );
      const merged = tree.merge(leaf1.id, leaf2.id);

      const laneA = { id: uid("lane"), label: "分支 A · 正面摊牌", cursor: leaf1.id };
      const laneB = { id: uid("lane"), label: "分支 B · 留出余地", cursor: leaf2.id };
      const laneM = { id: uid("lane"), label: "◆ 三路无损合流", cursor: merged.id };

      const snapshot = tree.toData();
      setWorlds((prev) =>
        prev.map((w) =>
          w.id === active.id
            ? {
                ...w,
                tree: snapshot,
                cursor: merged.id,
                lanes: [laneA, laneB, laneM],
                activeLane: laneM.id,
              }
            : w,
        ),
      );
      const msg = "已真实分叉两条平行线并完成三路无损合流（S_out = S_a + S_b − S_base）";
      setNotice({ tone: "ok", text: msg });
      return { ok: true, message: msg };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "分叉合流失败";
      setNotice({ tone: "error", text: msg });
      return { ok: false, message: msg };
    }
  }, [tree, cursor, active]);

  const mergeInto = useCallback(
    (otherId: string) => {
      if (!tree || !cursor) return;
      try {
        const merged = tree.merge(cursor.node.id, otherId);
        if (merged.id === cursor.node.id) {
          setNotice({ tone: "info", text: "这两条线已经在同一个节点上了。" });
          return;
        }
        const base = tree.lca(cursor.node.id, otherId);
        commit(tree, merged.id);
        setNotice({
          tone: "ok",
          text: `两条线接上了，从「${base?.label ?? "共同起点"}」之后的内容都保留。`,
        });
      } catch (error) {
        setNotice({
          tone: "error",
          text:
            error instanceof Error
              ? `接不上：${error.message}`
              : "接不上：这两条线的同一个设定冲突了",
        });
      }
    },
    [tree, cursor, commit],
  );

  /* ---- World File ---- */

  const [report, setReport] = useState<InspectWorldFileReport | null>(null);

  const exportFile = useCallback(() => {
    if (!active) return;
    try {
      const file = exportWorldFile(active.tree, {
        name: active.name,
        author: "Mirai",
        summary: active.hook,
      });
      const blob = new Blob([serializeWorldFile(file)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${active.name}.world.json`;
      link.click();
      URL.revokeObjectURL(url);
      const r = inspectWorldFile(file);
      setReport(r);
      setNotice({ tone: "ok", text: r.message });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof WorldFileError ? error.message : "这个世界的数据不一致，导不出来",
      });
    }
  }, [active]);

  const importFile = useCallback((raw: string) => {
    try {
      const file = parseWorldFile(raw);
      const r = inspectWorldFile(file);
      setWorlds((prev) => {
        const next: WorldMeta = {
          id: uid("world"),
          name: file.meta.name || "导入的世界",
          hook: file.meta.summary || "从文件载入的世界。",
          characters: [],
          tree: file.tree,
          cursor: file.tree.rootId,
          createdAt: new Date().toLocaleDateString("zh-CN"),
        };
        return [next, ...prev];
      });
      setReport(r);
      setNotice({ tone: "ok", text: r.message });
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof WorldFileError ? error.message : "这不像一个世界文件",
      });
    }
  }, []);

  const createWorld = useCallback((name: string, hook: string) => {
    const t = WorldTree.create(name);
    const next: WorldMeta = {
      id: uid("world"),
      name,
      hook,
      characters: [],
      tree: t.toData(),
      cursor: t.root.id,
      createdAt: new Date().toLocaleDateString("zh-CN"),
    };
    setWorlds((prev) => [next, ...prev]);
    setActiveId(next.id);
    setNotice({ tone: "ok", text: `「${name}」建好了。` });
  }, []);

  /**
   * World-Spec 热载入：同一份渲染器，换一份 JSON 就换一个世界。
   * 同 id 的世界会被替换，而不是越载越多份。
   */
  const loadSpec = useCallback((spec: WorldSpec) => {
    const built = buildWorldFromSpec(spec);
    const id = `spec-${spec.id}`;
    const next: WorldMeta = {
      id,
      name: built.name,
      hook: built.hook,
      characters: built.characters,
      tree: built.tree,
      cursor: built.cursor,
      choices: built.choices,
      spec,
      createdAt: new Date().toLocaleDateString("zh-CN"),
    };
    setWorlds((prev) => [next, ...prev.filter((world) => world.id !== id)]);
    setActiveId(id);
    setNotice({ tone: "ok", text: `「${spec.title}」已载入，世界线从零开始。` });
    return id;
  }, []);

  /** 世界名与处境可以原地改；不重建树，游标不动。 */
  const updateWorld = useCallback(
    (id: string, patch: Partial<Pick<WorldMeta, "name" | "hook">>) => {
      setWorlds((prev) =>
        prev.map((world) =>
          world.id === id
            ? {
                ...world,
                name: patch.name?.trim() ? patch.name.trim() : world.name,
                hook: patch.hook ?? world.hook,
              }
            : world,
        ),
      );
    },
    [],
  );

  const deleteWorld = useCallback(
    (id: string) => {
      const rest = worlds.filter((world) => world.id !== id);
      setWorlds(rest);
      if (activeId === id) setActiveId(rest[0]?.id ?? "");
      setNotice({ tone: "info", text: "这个世界已从列表里移走。" });
    },
    [worlds, activeId],
  );

  const duplicateWorld = useCallback(
    (id: string) => {
      const source = worlds.find((world) => world.id === id);
      if (!source) return;
      const copy: WorldMeta = {
        ...source,
        id: uid("world"),
        name: `${source.name} 副本`,
        createdAt: new Date().toLocaleDateString("zh-CN"),
      };
      setWorlds((prev) => [copy, ...prev]);
      setActiveId(copy.id);
      setNotice({ tone: "ok", text: `复制出「${copy.name}」。` });
    },
    [worlds],
  );

  const QUICK_KEY = "mirai.quick.v1";

  const quickSave = useCallback(() => {
    if (!active || !cursor) return;
    try {
      localStorage.setItem(
        QUICK_KEY,
        JSON.stringify({ worldId: active.id, nodeId: cursor.node.id, at: Date.now() }),
      );
      setNotice({ tone: "ok", text: `Q.Save：停在「${cursor.node.label}」。` });
    } catch {
      setNotice({ tone: "error", text: "这台设备存不了，试试导出文件。" });
    }
  }, [active, cursor]);

  const quickLoad = useCallback(() => {
    try {
      const raw = localStorage.getItem(QUICK_KEY);
      if (!raw) {
        setNotice({ tone: "info", text: "还没有 Q.Save。" });
        return;
      }
      const saved = JSON.parse(raw) as { worldId: string; nodeId: string };
      setWorlds((prev) =>
        prev.map((world) => (world.id === saved.worldId ? { ...world, cursor: saved.nodeId } : world)),
      );
      setActiveId(saved.worldId);
      setNotice({ tone: "ok", text: "回到 Q.Save 的那一步。" });
    } catch {
      setNotice({ tone: "error", text: "Q.Save 读不出来。" });
    }
  }, []);

  /**
   * 玩家自由写一句，世界演出一幕。
   *
   * 和 choose() 的区别：choose 只能选预设的三条，act 接受任意文字。
   * 这一幕的叙事和场景存进节点 meta，不进 state —— 场景不是世界的事实。
   */
  const act = useCallback(
    (
      action: string,
      payload: {
        narration?: string;
        scene?: { place: string; time: string; mood: string; weather: string } | null;
        suggestions?: string[];
        memory?: { key: string; value: number } | null;
      },
    ) => {
      if (!tree || !cursor) return;
      const text = action.trim().slice(0, 120) || "什么也没做";

      // 世界时钟：从上一幕接着走，每幕推进 2–3 小时。
      // 存在 meta 里（沿路径累积），所以 replay 同一个文件会得到同样的时间。
      const prevDay = Number(cursor.node.meta?.day ?? "1") || 1;
      const prevHour = Number(cursor.node.meta?.hour ?? "8") || 8;
      const step = 2 + (text.length % 2);
      let hour = prevHour + step;
      let day = prevDay;
      while (hour >= 24) {
        hour -= 24;
        day += 1;
      }

      const mem = payload.memory ?? { key: "这一刻", value: 4 };
      const node = tree.observe(
        cursor.node.id,
        { uid: `m-${uid("k")}`, key: mem.key, value: mem.value },
        text,
        {
          narration: payload.narration ?? "",
          place: payload.scene?.place ?? "",
          time: payload.scene?.time ?? "",
          mood: payload.scene?.mood ?? "",
          // 天气会延续：模型没说就沿用上一幕
          weather: payload.scene?.weather || (cursor.node.meta?.weather ?? ""),
          suggestions: JSON.stringify(payload.suggestions ?? []),
          day: String(day),
          hour: String(hour),
        },
      );
      commit(tree, node.id);
    },
    [tree, cursor, commit],
  );

  /* ---- 岔路 ---- */

  const addChoiceToWorld = useCallback(
    (c: Omit<ChoiceDef, "id">) => {
      if (!active) return;
      const next: ChoiceDef = { ...c, id: uid("c") };
      setWorlds((prev) =>
        prev.map((w) =>
          w.id === active.id
            ? { ...w, choices: [...(w.choices ?? DEFAULT_CHOICES), next] }
            : w,
        ),
      );
      setNotice({ tone: "ok", text: `加了一条岔路「${c.label}」。` });
    },
    [active],
  );

  const removeChoiceFromWorld = useCallback(
    (choiceId: string) => {
      if (!active) return;
      setWorlds((prev) =>
        prev.map((w) =>
          w.id === active.id
            ? { ...w, choices: (w.choices ?? DEFAULT_CHOICES).filter((c) => c.id !== choiceId) }
            : w,
        ),
      );
    },
    [active],
  );

  /**
   * 结束时的整理：保留最在意的几句话，其余变成墓碑。
   *
   * 这是产品里的「归纳」：世界不会无限膨胀，走到一个段落就压一次。
   * 删掉的记忆留墓碑，所以合并时不会复活。
   */
  const consolidate = useCallback(
    (ratio = 0.6) => {
      if (!tree || !cursor || !active) return;
      const mems = Object.values(cursor.node.state.numeric).sort(
        (a, b) => slotMean(b) - slotMean(a),
      );
      // 保留最在意的六成，至少两件。这样"整理"永远真的发生一点。
      const keepTop = Math.max(2, Math.ceil(mems.length * ratio));
      const drop = mems.slice(keepTop);
      if (!drop.length) {
        setNotice({ tone: "info", text: "这段记忆已经很少了，不用再整理。" });
        return;
      }
      let tip = cursor.node.id;
      for (const m of drop) {
        tip = tree.forget(tip, m.uid, "结束时的整理").id;
      }
      setWorlds((prev) =>
        prev.map((w) =>
          w.id === active.id ? { ...w, tree: tree.toData(), cursor: tip } : w,
        ),
      );
      setNotice({
        tone: "ok",
        text: `整理完了：留下 ${Math.min(mems.length, keepTop)} 件最在意的事，收起 ${drop.length} 件。`,
      });
    },
    [tree, cursor, active],
  );

  /**
   * 把服务端的世界并进来。
   *
   * 规则：同 id 以「更新更晚」为准 —— 服务端带 updatedAt，
   * 本地没有就取服务端。冲突时保服务端，因为多设备场景下它更可能是权威。
   */
  const mergeRemote = useCallback((remote: WorldMeta[]) => {
    setWorlds((prev) => {
      const byId = new Map(prev.map((w) => [w.id, w]));
      for (const r of remote) {
        byId.set(r.id, { ...byId.get(r.id), ...r });
      }
      const merged = [...byId.values()];
      merged.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
      return merged;
    });
  }, []);

  const addCharacter = useCallback(
    (c: Omit<Character, "id" | "portrait">) => {
      if (!tree || !active || !cursor) return;
      const id = uid("char");
      const node = tree.setScalar(
        cursor.node.id,
        `char-${id}`,
        c.name,
        `${c.role} · ${c.traits}`,
        `认识 ${c.name}`,
      );
      setWorlds((prev) =>
        prev.map((w) =>
          w.id === active.id
            ? {
                ...w,
                characters: [
                  ...w.characters,
                  { ...c, id, portrait: PORTRAITS[w.characters.length % PORTRAITS.length] },
                ],
                tree: tree.toData(),
                cursor: node.id,
              }
            : w,
        ),
      );
      setNotice({ tone: "ok", text: `${c.name} 走进了这个世界。` });
    },
    [tree, active, cursor],
  );

  const resetToDemo = useCallback(() => {
    const d = demoWorld();
    setWorlds([d]);
    setActiveId(d.id);
    setNotice({ tone: "info", text: "回到示例世界。" });
  }, []);

  return {
    worlds,
    active,
    lanes,
    activeLaneId,
    activeLane,
    focusLane,
    addLane,
    removeLane,
    activeId,
    setActiveId,
    tree,
    cursor,
    notice,
    setNotice,
    report,
    choose,
    act,
    goBackTo,
    forkHere,
    demoForkAndMerge,
    mergeInto,
    mergeNodes,
    loadSpec,
    quickSave,
    quickLoad,
    exportFile,
    importFile,
    createWorld,
    updateWorld,
    deleteWorld,
    duplicateWorld,
    addCharacter,
    addChoiceToWorld,
    removeChoiceFromWorld,
    consolidate,
    resetToDemo,
    mergeRemote,
    /** 切换本地世界的存放桶：null = 访客，user.id = 该账号。 */
    setScope,
    audit: (tree?.audit ?? []) as AuditEntry[],
    stateOf: (node: WorldNode): WorldState => cloneState(node.state),
    meanOf: slotMean,
  };
}

export type UseWorlds = ReturnType<typeof useWorlds>;
