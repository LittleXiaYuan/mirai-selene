import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronRight, Download, GitBranch, History, Map, Moon, RotateCcw, Save, Send } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Badge } from "@/components/arc/badge/badge";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Input } from "@/components/arc/input/input";
import { Kbd } from "@/components/arc/kbd/kbd";
import { Drawer, DrawerContent } from "@/components/arc/drawer/drawer";
import { slotMean, type WorldState } from "@/world/engine";
import styles from "./mirai-vn.module.css";

type Choice = {
  label: string;
  next?: string;
  route?: string;
  action?: "routes" | "backlog" | "save" | "rollback" | "reset";
};

type Scene = {
  id: string;
  day: number;
  bg: string;
  speaker: string;
  lines: string[];
  choices?: Choice[];
  night?: boolean;
};

type HistoryItem = { speaker: string; text: string; route: string };

type SavePoint = {
  id: string;
  label: string;
  sceneId: string;
  lineIndex: number;
  route: string;
  day: number;
  history: HistoryItem[];
  createdAt: string;
};

const ROUTES: Record<string, string> = {
  main: "主线",
  shanghai: "上海线",
  kaoyan: "考研线",
  qingdao: "青岛线",
};

const SCENES: Record<string, Scene> = {
  start: {
    id: "start",
    day: 1,
    bg: "01-cover.webp",
    speaker: "Selene",
    lines: [
      "第 1 天。青岛的海风把窗户吹得作响。",
      "林夏坐在桌前，面前是两封信：一封来自上海，一封来自学校。",
      "她还没有拆开任何一封。",
    ],
    choices: [
      { label: "去上海", next: "shanghai", route: "shanghai" },
      { label: "留下来考研", next: "kaoyan", route: "kaoyan" },
      { label: "先回青岛", next: "qingdao", route: "qingdao" },
    ],
  },
  shanghai: {
    id: "shanghai",
    day: 1,
    bg: "07-market.webp",
    speaker: "Selene",
    lines: [
      "你替她拆开了上海的信。",
      "那座城市在信里亮着，像一条没有回头路的河。",
      "母亲在身后问：“你真的要去吗？”",
    ],
    choices: [
      { label: "告诉她：我想去", next: "night", route: "shanghai" },
      { label: "说：我再想想", next: "night", route: "shanghai" },
    ],
  },
  kaoyan: {
    id: "kaoyan",
    day: 1,
    bg: "03-insight.webp",
    speaker: "Selene",
    lines: [
      "你把上海的信放回桌上，打开了考研资料。",
      "导师说：“你适合做研究。”可你知道，适合不等于想要。",
      "窗外的海还是那片海。",
    ],
    choices: [
      { label: "告诉导师：我想试试", next: "night", route: "kaoyan" },
      { label: "什么也不说", next: "night", route: "kaoyan" },
    ],
  },
  qingdao: {
    id: "qingdao",
    day: 1,
    bg: "04-world.webp",
    speaker: "Selene",
    lines: [
      "你选择先回青岛。",
      "城市很小，小到每一条街都记得你。",
      "母亲做了一桌菜，没有问任何问题。",
    ],
    choices: [
      { label: "告诉她：我还没想好", next: "night", route: "qingdao" },
      { label: "告诉她：我决定留下", next: "night", route: "qingdao" },
    ],
  },
  night: {
    id: "night",
    day: 1,
    bg: "05-sleep.webp",
    speaker: "Selene",
    night: true,
    lines: [
      "夜深了，世界开始整理记忆。",
      "重复的焦虑被合并，低显著度的噪声被删除。",
      "在梦里，世界替你跑了两条反事实。",
      "如果那天没有接电话，如果母亲先说“你去吧”。",
      "醒来时，只留下一个洞察：你怕的不是选错，而是没有选择权。",
    ],
  },
  wake: {
    id: "wake",
    day: 2,
    bg: "01-cover.webp",
    speaker: "Selene",
    lines: [
      "第 2 天。世界比昨天干净了一点。",
      "记忆面板里，昨天的一条噪声已经变成墓碑。",
      "你可以继续推演，也可以打开路线图，看看另一条世界线。",
    ],
    choices: [
      { label: "继续推演", next: "end" },
      { label: "打开路线图", action: "routes" },
      { label: "合并回主线", next: "merge" },
      { label: "回滚到上一个存档", action: "rollback" },
    ],
  },
  merge: {
    id: "merge",
    day: 2,
    bg: "08-closing.webp",
    speaker: "Selene",
    lines: [
      "两条世界线在同一个岔口收束。",
      "她记得你留下，也记得你离开。",
      "这不是矛盾，这是她拥有的全部世界。",
    ],
    choices: [
      { label: "重新开始", action: "reset" },
      { label: "打开路线图", action: "routes" },
    ],
  },
  end: {
    id: "end",
    day: 2,
    bg: "08-closing.webp",
    speaker: "Selene",
    lines: ["世界继续向前。", "下一个岔路，还在等你。"],
    choices: [
      { label: "重新开始", action: "reset" },
      { label: "打开路线图", action: "routes" },
    ],
  },
};

function answerFor(question: string, route: string, day: number) {
  if (question.includes("上海")) {
    return `上海线在第 ${day} 天留下了“房租”和“母亲”两个高显著度记忆。你想让我推演它，还是回滚它？`;
  }
  if (question.includes("母亲")) {
    return "她不是反对，她只是害怕。她记得你从小到大没离开过青岛。";
  }
  if (question.includes("晚安") || question.includes("睡")) {
    return "晚安后，世界会合并重复记忆、删除噪声，并在梦里跑两个反事实。醒来只保留洞察，不保留假事实。";
  }
  if (question.includes("你是谁") || question.includes("Selene")) {
    return "我是 Selene，这个世界的声音。我不替她选，我只把每条世界线摊开给你看。";
  }
  if (question.includes("路线") || question.includes("世界线")) {
    return `现在是「${ROUTES[route] ?? route}」，第 ${day} 天。打开路线图，你能看到另外三条。`;
  }
  return "我在。你可以问我：如果林夏去上海，母亲会怎么反应？或者，先做一次晚安整理。";
}

export function MiraiVN() {
  const [worldName] = useState(() => {
    try {
      const raw = localStorage.getItem("mirai.world");
      if (raw) return (JSON.parse(raw) as { name?: string }).name ?? "林夏的毕业选择";
    } catch {
      // fall through to the default world
    }
    return "林夏的毕业选择";
  });
  /** Studio 里选中的世界线节点 —— Stage 读它的状态，而不是一份独立的假存档。 */
  const [node] = useState<{ id: string; label: string; state: WorldState } | null>(() => {
    try {
      const raw = localStorage.getItem("mirai.node");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { id?: string; label?: string; state?: WorldState };
      if (!parsed.id || !parsed.state) return null;
      return { id: parsed.id, label: parsed.label ?? parsed.id, state: parsed.state };
    } catch {
      return null;
    }
  });
  const initial = (() => {
    const branch = localStorage.getItem("mirai.branch");
    if (branch === "shanghai") return { scene: "shanghai", route: "shanghai" };
    if (branch === "kaoyan") return { scene: "kaoyan", route: "kaoyan" };
    if (branch === "qingdao") return { scene: "qingdao", route: "qingdao" };
    // 从世界线节点进入时，按节点标签猜场景，猜不到就从原点开始
    if (node?.label) {
      if (node.label.includes("上海")) return { scene: "shanghai", route: "shanghai" };
      if (node.label.includes("考研")) return { scene: "kaoyan", route: "kaoyan" };
      if (node.label.includes("青岛")) return { scene: "qingdao", route: "qingdao" };
    }
    return { scene: "start", route: "main" };
  })();
  const [sceneId, setSceneId] = useState(initial.scene);
  const [lineIndex, setLineIndex] = useState(0);
  const [route, setRoute] = useState(initial.route);
  const [day, setDay] = useState(SCENES[initial.scene]?.day ?? 1);
  const [typed, setTyped] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [savepoints, setSavepoints] = useState<SavePoint[]>([]);
  const [night, setNight] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [talk, setTalk] = useState("");
  const [reply, setReply] = useState("");
  const [thinking, setThinking] = useState(false);

  const scene = SCENES[sceneId] ?? SCENES.start;
  const line = scene.lines[lineIndex] ?? "";
  const advanceRef = useRef<() => void>(() => {});

  useEffect(() => {
    const text = line;
    setTyped("");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTyped(text);
      return;
    }
    let i = 0;
    const timer = window.setInterval(() => {
      i += 2;
      setTyped(text.slice(0, i));
      if (i >= text.length) window.clearInterval(timer);
    }, 22);
    return () => window.clearInterval(timer);
  }, [line]);

  useEffect(() => {
    if (!line) return;
    setHistory((prev) => [...prev, { speaker: scene.speaker, text: line, route }]);
  }, [scene.id, lineIndex]);

  const saveNow = (label: string): SavePoint => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    sceneId,
    lineIndex,
    route,
    day,
    history: [...history],
    createdAt: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  });

  const go = (id: string, nextRoute = route) => {
    const next = SCENES[id];
    if (!next) return;
    setSavepoints((prev) => [...prev.slice(-9), saveNow(`${next.day} 天 · ${ROUTES[nextRoute] ?? nextRoute} · ${id}`)]);
    setSceneId(id);
    setLineIndex(0);
    setRoute(nextRoute);
    setDay(next.day);
    setNight(Boolean(next.night));
    setReply("");
  };

  const rollback = () => {
    if (!savepoints.length) {
      setReply("还没有可回滚的存档。先做一次选择，世界会替你存一个点。");
      return;
    }
    const snapshot = savepoints[savepoints.length - 1];
    setSavepoints((prev) => prev.slice(0, -1));
    setSceneId(snapshot.sceneId);
    setLineIndex(snapshot.lineIndex);
    setRoute(snapshot.route);
    setDay(snapshot.day);
    setHistory(snapshot.history);
    setNight(Boolean(SCENES[snapshot.sceneId]?.night));
    setReply(`已回滚到 ${snapshot.label}。`);
  };

  const choose = (choice: Choice) => {
    if (choice.action === "routes") {
      setRoutesOpen(true);
      return;
    }
    if (choice.action === "backlog") {
      setBacklogOpen(true);
      return;
    }
    if (choice.action === "save") {
      setSaveOpen(true);
      return;
    }
    if (choice.action === "rollback") {
      rollback();
      return;
    }
    if (choice.action === "reset") {
      reset();
      return;
    }
    if (choice.next) go(choice.next, choice.route ?? route);
  };

  const advance = () => {
    if (typed.length < line.length) {
      setTyped(line);
      return;
    }
    if (lineIndex < scene.lines.length - 1) {
      setLineIndex((index) => index + 1);
      return;
    }
    if (scene.choices) return;
    if (scene.night) {
      const nextDay = day + 1;
      setDay(nextDay);
      go("wake");
      return;
    }
  };
  advanceRef.current = advance;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.code === "Space" || event.key === "Enter") {
        event.preventDefault();
        advanceRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ask = async () => {
    const question = talk.trim();
    if (!question) return;
    setTalk("");
    setThinking(true);
    setReply("Selene 正在想…");
    try {
      const response = await fetch("/mirai-api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: `你是 Mirai-Selene 的叙述者 Selene。当前世界：${worldName}。当前世界线：${ROUTES[route] ?? route}。第 ${day} 天。你冷静、简短、具体；不要编造未发生的事实；回答控制在三句话内。` },
            { role: "user", content: question },
          ],
        }),
      });
      const data = await response.json() as { content?: string };
      setReply(data.content || answerFor(question, route, day));
    } catch {
      setReply(answerFor(question, route, day));
    } finally {
      setThinking(false);
    }
  };

  const reset = () => {
    setSceneId("start");
    setLineIndex(0);
    setRoute("main");
    setDay(1);
    setHistory([]);
    setSavepoints([]);
    setNight(false);
    setReply("");
    setTyped("");
  };

  const exportWorld = () => {
    const data = {
      format: "mirai-selene/world@0.1",
      world: "林夏的毕业选择",
      sceneId,
      lineIndex,
      route,
      day,
      history,
      savepoints,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "linxia.world.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`${styles.stage} ${night ? styles.night : ""}`}>
      <div key={scene.id} className={styles.bg} style={{ backgroundImage: `url(/mirai/${scene.bg})` }} />
      <div className={styles.vignette} />
      {night && <div className={styles.nightVeil} />}

      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.brandMoon}><Moon size={18} strokeWidth={1.75} aria-hidden /></span>
          <div>
            <h1>Mirai-Selene</h1>
            <p>{worldName} · 视觉小说原型</p>
          </div>
        </div>
        <div className={styles.meta}>
          <Badge tone="info" size="sm">DAY {day}</Badge>
          <Badge size="sm">{ROUTES[route] ?? route}</Badge>
          <Button variant="ghost" size="sm" onClick={() => setRoutesOpen(true)}><Map size={15} strokeWidth={1.75} aria-hidden />路线</Button>
          <Button variant="ghost" size="sm" onClick={() => setBacklogOpen(true)}><History size={15} strokeWidth={1.75} aria-hidden />记录</Button>
          <Button variant="ghost" size="sm" onClick={() => setSaveOpen(true)}><Save size={15} strokeWidth={1.75} aria-hidden />存档</Button>
        </div>
      </header>

      <div key={`${scene.id}-chapter`} className={styles.chapter}>
        第 {scene.day} 天 · {ROUTES[route] ?? route}
      </div>

      <section className={styles.dialogue} onClick={advance} role="button" tabIndex={0} aria-label="继续对话">
        <div className={styles.speaker}>
          <Avatar name="Selene" src="/mirai/selene.webp" size="xl" />
          <div>
            <div className={styles.name}>{scene.speaker}</div>
            <div className={styles.role}>世界的叙述者</div>
          </div>
        </div>

        <p className={styles.text}>{typed || "\u00a0"}</p>

        {reply && <div className={styles.reply}>{reply}</div>}

        <div className={styles.talkRow} onClick={(event) => event.stopPropagation()}>
          <Input
            label="和 Selene 说话"
            value={talk}
            onChange={(event) => setTalk(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void ask();
              }
            }}
            placeholder="和 Selene 说话：她记得什么？如果当时…？"
          />
          <Button variant="secondary" size="sm" onClick={() => void ask()} loading={thinking}><Send size={14} strokeWidth={1.75} aria-hidden />{thinking ? "想…" : "说"}</Button>
        </div>

        {scene.choices && (
          <div className={styles.choices} onClick={(event) => event.stopPropagation()}>
            {scene.choices.map((choice) => (
              <Button key={choice.label} variant="secondary" className={styles.choice} onClick={() => choose(choice)}>
                <ArrowRight size={15} strokeWidth={1.75} aria-hidden />{choice.label}
              </Button>
            ))}
          </div>
        )}

        {!scene.choices && (
          <div className={styles.continue}>
            <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
            <span>点击继续</span>
            <Kbd keys="space" size="sm" />
          </div>
        )}
      </section>

      <Drawer open={routesOpen} onOpenChange={setRoutesOpen}>
        <DrawerContent title="世界线" description="每一条选择都是一条世界线。当前线会被高亮。">
          <svg viewBox="0 0 320 280" className={styles.tree} aria-label="世界线图">
            <line x1="160" y1="34" x2="60" y2="120" className={route === "shanghai" ? styles.currentLine : styles.line} />
            <line x1="160" y1="34" x2="160" y2="120" className={route === "kaoyan" ? styles.currentLine : styles.line} />
            <line x1="160" y1="34" x2="260" y2="120" className={route === "qingdao" ? styles.currentLine : styles.line} />
            <line x1="60" y1="120" x2="160" y2="214" className={styles.line} />
            <line x1="160" y1="120" x2="160" y2="214" className={styles.line} />
            <line x1="260" y1="120" x2="160" y2="214" className={styles.line} />
            <circle cx="160" cy="34" r="9" className={route === "main" ? styles.currentNode : styles.node} />
            <circle cx="60" cy="120" r="9" className={route === "shanghai" ? styles.currentNode : styles.node} />
            <circle cx="160" cy="120" r="9" className={route === "kaoyan" ? styles.currentNode : styles.node} />
            <circle cx="260" cy="120" r="9" className={route === "qingdao" ? styles.currentNode : styles.node} />
            <circle cx="160" cy="214" r="9" className={styles.nightNode} />
            <text x="160" y="20" textAnchor="middle" className={styles.treeText}>主线</text>
            <text x="60" y="108" textAnchor="middle" className={styles.treeText}>上海线</text>
            <text x="160" y="108" textAnchor="middle" className={styles.treeText}>考研线</text>
            <text x="260" y="108" textAnchor="middle" className={styles.treeText}>青岛线</text>
            <text x="160" y="244" textAnchor="middle" className={styles.treeText}>晚安 · 整理</text>
          </svg>
          <div className={styles.drawerActions}>
            <Button variant="primary" size="sm" onClick={() => { setRoutesOpen(false); go("merge", "main"); }}><GitBranch size={15} strokeWidth={1.75} aria-hidden />合并回主线</Button>
            <Button variant="secondary" size="sm" onClick={rollback}><RotateCcw size={15} strokeWidth={1.75} aria-hidden />回滚到上一个存档</Button>
            <Button variant="ghost" size="sm" onClick={exportWorld}><Download size={15} strokeWidth={1.75} aria-hidden />导出 .world</Button>
          </div>
          <p className={styles.drawerHint}>合并会带祖先；同 uid 冲突会拒绝，不瞎平均。</p>

          {node && (
            <div className={styles.nodeState}>
              <div className={styles.nodeStateHead}>
                <span>来自 Studio 的世界线</span>
                <span className={styles.nodeStateId}>{node.id}</span>
              </div>
              <p className={styles.nodeStateLabel}>{node.label}</p>
              {Object.values(node.state.numeric).length === 0 && (
                <p className={styles.drawerHint}>这条线上还没有记忆槽。</p>
              )}
              {Object.values(node.state.numeric)
                .sort((a, b) => slotMean(b) - slotMean(a))
                .slice(0, 6)
                .map((slot) => (
                  <div key={slot.uid} className={styles.nodeStateRow}>
                    <span>{slot.key}</span>
                    <span>
                      均值 {slotMean(slot).toFixed(2)} · count {slot.count}
                    </span>
                  </div>
                ))}
              {Object.keys(node.state.tombstones).length > 0 && (
                <p className={styles.drawerHint}>
                  {Object.keys(node.state.tombstones).length} 个墓碑：删掉的记忆不会被合并复活。
                </p>
              )}
            </div>
          )}
        </DrawerContent>
      </Drawer>

      <Drawer open={backlogOpen} onOpenChange={setBacklogOpen}>
        <DrawerContent title="世界记录" description="这个世界发生过什么。">
          <div className={styles.backlog}>
            {history.length ? history.slice(-80).reverse().map((item, index) => (
              <div key={index} className={styles.backlogRow}>
                <span className={styles.backlogMeta}>{ROUTES[item.route] ?? item.route}</span>
                <span><b>{item.speaker}</b>：{item.text}</span>
              </div>
            )) : <p className={styles.drawerHint}>还没有记录。</p>}
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer open={saveOpen} onOpenChange={setSaveOpen}>
        <DrawerContent title="存档" description="世界文件可以保存、回滚、导出。">
          <div className={styles.drawerActions}>
            <Button variant="primary" size="sm" onClick={() => setSavepoints((prev) => [...prev, saveNow(`手动存档 · 第 ${day} 天`)] )}><Save size={15} strokeWidth={1.75} aria-hidden />保存当前世界</Button>
            <Button variant="secondary" size="sm" onClick={rollback}><RotateCcw size={15} strokeWidth={1.75} aria-hidden />回滚</Button>
            <Button variant="ghost" size="sm" onClick={exportWorld}><Download size={15} strokeWidth={1.75} aria-hidden />导出 .world</Button>
          </div>
          <div className={styles.saveList}>
            {savepoints.length ? savepoints.slice().reverse().map((save) => (
              <div key={save.id} className={styles.saveRow}>
                <div>
                  <div className={styles.saveLabel}>{save.label}</div>
                  <div className={styles.saveMeta}>{save.createdAt} · {ROUTES[save.route] ?? save.route}</div>
                </div>
                <Button variant="secondary" size="sm" onClick={() => {
                  setSceneId(save.sceneId);
                  setLineIndex(save.lineIndex);
                  setRoute(save.route);
                  setDay(save.day);
                  setHistory(save.history);
                  setNight(Boolean(SCENES[save.sceneId]?.night));
                  setSaveOpen(false);
                }}>读取</Button>
              </div>
            )) : <p className={styles.drawerHint}>还没有存档。做一次选择，世界会替你存一个点。</p>}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
