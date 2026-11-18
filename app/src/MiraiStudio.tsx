import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Download,
  FileInput,
  GitBranch,
  Globe2,
  Lock,
  Moon,
  Play,
  Plus,
  Sparkles,
  Target,
  TrendingUp,
  Upload,
  UserPlus,
  Users,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Badge } from "@/components/arc/badge/badge";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Input } from "@/components/arc/input/input";
import { Drawer, DrawerContent } from "@/components/arc/drawer/drawer";
import { WorldTree, type WorldTreeData } from "@/world/engine";
import { exportWorldFile, serializeWorldFile } from "@/world/worldfile";
import { WorldlinePanel } from "@/world/worldline-panel";
import styles from "./mirai-studio.module.css";

type Character = {
  id: string;
  name: string;
  role: string;
  traits: string;
  secret: string;
  goal: string;
  portrait: string;
};

type World = {
  id: string;
  name: string;
  summary: string;
  characters: Character[];
  routes: string[];
  createdAt: string;
  /** 世界线版本树。老数据可能没有，载入时补一棵。 */
  tree?: WorldTreeData;
};

type Branch = {
  label: string;
  route: string;
  outcome: string;
  confidence: number;
  assumption: string;
};

type Prediction = {
  id: string;
  worldId: string;
  intervention: string;
  branches: Branch[];
  createdAt: string;
};

const PORTRAITS = ["/mirai/selene.webp", "/mirai/linxia.webp", "/mirai/mother.webp", "/mirai/mentor.webp", "/mirai/mentor.webp"];
const STORAGE = "mirai.studio.v1";

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const today = () => new Date().toLocaleDateString("zh-CN");

const DEFAULT_CHARACTERS: Character[] = [
  { id: "linxia", name: "林夏", role: "你 / 主角", traits: "焦虑、敏锐、想要选择权", secret: "她怕的不是选错，是没有选择", goal: "在 30 岁前拥有选择权", portrait: "/mirai/linxia.webp" },
  { id: "mother", name: "母亲", role: "家人", traits: "担忧、克制、嘴硬心软", secret: "她其实希望女儿留下", goal: "女儿平安、离家近一点", portrait: "/mirai/mother.webp" },
  { id: "mentor", name: "导师", role: "学术", traits: "期待、理性、惜才", secret: "他怕林夏浪费自己的潜力", goal: "把她带进更好的课题组", portrait: "/mirai/mentor.webp" },
  { id: "boss", name: "上海雇主", role: "机会", traits: "观望、职业、耐心有限", secret: "这个岗位的窗口只剩一周", goal: "尽快拿到答复", portrait: "/mirai/mentor.webp" },
];

const DEFAULT_WORLD: World = {
  id: "world-linxia",
  name: "林夏的毕业选择",
  summary: "一个 22 岁的青岛女生，在上海 offer、考研和留在青岛之间，第一次真正面对“选择权”。",
  characters: DEFAULT_CHARACTERS,
  routes: ["主线", "上海线", "考研线", "青岛线"],
  createdAt: today(),
};

const DEFAULT_PREDICTION: Prediction = {
  id: "pred-linxia",
  worldId: DEFAULT_WORLD.id,
  intervention: "如果林夏去上海",
  branches: [
    { label: "上海线", route: "shanghai", outcome: "她去了上海，获得了更大的舞台，但和母亲的距离变远。", confidence: 0.62, assumption: "她更在意成长，而不是稳定。" },
    { label: "考研线", route: "kaoyan", outcome: "她留下来读研，路径更稳，但会反复怀疑自己是不是在躲。", confidence: 0.48, assumption: "导师的支持能抵消她对“逃避”的恐惧。" },
    { label: "青岛线", route: "qingdao", outcome: "她留在青岛，关系更近，但“如果当时”会长期回响。", confidence: 0.55, assumption: "她愿意用可能性换取确定性。" },
  ],
  createdAt: today(),
};

type StudioData = { worlds: World[]; predictions: Prediction[] };

function loadData(): StudioData {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as StudioData;
      if (parsed.worlds?.length) return parsed;
    }
  } catch {
    // ignore a stale draft
  }
  return { worlds: [DEFAULT_WORLD], predictions: [DEFAULT_PREDICTION] };
}

function blankCharacter(): Character {
  return { id: "", name: "", role: "", traits: "", secret: "", goal: "", portrait: PORTRAITS[0] };
}

const TITLES: Record<string, { title: string; subtitle: string }> = {
  worlds: { title: "世界", subtitle: "每个世界都是一个可保存、可分支、可合并、可审计的文件。" },
  worldline: { title: "世界线", subtitle: "真分支、真合并、真回滚。每次操作都进审计日志，可导出成能带走的文件。" },
  characters: { title: "角色", subtitle: "名字、身份、性格、秘密、目标，还有一张立绘。" },
  predictions: { title: "预测", subtitle: "选一个干预，让世界跑三条线。不是预言，是条件推演。" },
  imports: { title: "导入", subtitle: "粘贴一段梗概、剧本或角色设定，抽出角色和世界。" },
};

export function MiraiStudio() {
  const [data, setData] = useState<StudioData>(loadData);
  const [active, setActive] = useState<keyof typeof TITLES>("worlds");
  const [selectedWorld, setSelectedWorld] = useState(() => data.worlds[0]?.id ?? "");
  const [newWorldOpen, setNewWorldOpen] = useState(false);
  const [charOpen, setCharOpen] = useState(false);
  const [worldForm, setWorldForm] = useState({ name: "", summary: "" });
  const [charForm, setCharForm] = useState<Character>(blankCharacter);
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<Character[]>([]);
  const [intervention, setIntervention] = useState("如果林夏去上海");
  const [prediction, setPrediction] = useState<Prediction | null>(DEFAULT_PREDICTION);
  const [predicting, setPredicting] = useState(false);
  const [extracting, setExtracting] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE, JSON.stringify(data));
  }, [data]);

  const world = data.worlds.find((item) => item.id === selectedWorld) ?? data.worlds[0];
  const characters = world?.characters ?? [];

  /** 当前世界的版本树。老数据没有 tree 时补一棵，并把已有角色写成标量槽。 */
  const worldTree = useMemo<WorldTreeData>(() => {
    if (world?.tree) return world.tree;
    const tree = WorldTree.create(world?.name ?? "未命名世界");
    let tipId = tree.root.id;
    for (const character of world?.characters ?? []) {
      const node = tree.setScalar(
        tipId,
        `char-${character.id}`,
        character.name,
        [character.role, character.traits].filter(Boolean).join(" · "),
        `设定角色 ${character.name}`,
      );
      tipId = node.id;
    }
    return tree.toData();
  }, [world]);

  const [currentNodeId, setCurrentNodeId] = useState(() => worldTree.rootId);
  const [exportNotice, setExportNotice] = useState("");

  const addWorld = () => {
    const next: World = {
      id: uid("world"),
      name: worldForm.name.trim() || "未命名世界",
      summary: worldForm.summary.trim() || "一个还没有被写下来的世界。",
      characters: [],
      routes: ["主线", "上海线", "考研线", "青岛线"],
      createdAt: today(),
    };
    setData((current) => ({ ...current, worlds: [next, ...current.worlds] }));
    setSelectedWorld(next.id);
    setNewWorldOpen(false);
    setWorldForm({ name: "", summary: "" });
    setActive("characters");
  };

  const addCharacter = () => {
    if (!world) return;
    const next: Character = {
      ...charForm,
      id: uid("char"),
      name: charForm.name.trim() || "未命名角色",
      role: charForm.role.trim() || "角色",
      traits: charForm.traits.trim() || "待补充",
      secret: charForm.secret.trim(),
      goal: charForm.goal.trim(),
    };
    setData((current) => ({
      ...current,
      worlds: current.worlds.map((item) => item.id === world.id ? { ...item, characters: [next, ...item.characters] } : item),
    }));
    setCharOpen(false);
    setCharForm(blankCharacter());
  };

  const parseImport = async () => {
    setExtracting(true);
    try {
      const response = await fetch("/mirai-api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText }),
      });
      const data = await response.json() as { characters?: { name: string; role: string; traits: string }[] };
      if (Array.isArray(data.characters) && data.characters.length) {
        setImportPreview(data.characters.map((character, index) => ({
          id: uid("char"),
          name: character.name,
          role: character.role,
          traits: character.traits,
          secret: "",
          goal: "",
          portrait: PORTRAITS[index % PORTRAITS.length],
        })));
        return;
      }
    } catch {
      // fall through to the deterministic extractor
    } finally {
      setExtracting(false);
    }
    const lines = importText.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 8);
    const parsed = lines.map((line, index) => {
      const parts = line.replace(/^[-*]\s*/, "").split(/[：:，,]/).map((part) => part.trim()).filter(Boolean);
      return {
        id: uid("char"),
        name: parts[0] || `角色 ${index + 1}`,
        role: parts[1] || "角色",
        traits: parts.slice(2).join("，") || "待补充",
        secret: "",
        goal: "",
        portrait: PORTRAITS[index % PORTRAITS.length],
      } satisfies Character;
    });
    setImportPreview(parsed);
  };

  const createWorldFromImport = () => {
    if (!importPreview.length) return;
    const next: World = {
      id: uid("world"),
      name: `导入世界 · ${importText.slice(0, 10) || "未命名"}`,
      summary: importText.slice(0, 140),
      characters: importPreview,
      routes: ["主线", "上海线", "考研线", "青岛线"],
      createdAt: today(),
    };
    setData((current) => ({ ...current, worlds: [next, ...current.worlds] }));
    setSelectedWorld(next.id);
    setImportText("");
    setImportPreview([]);
    setActive("worlds");
  };

  const runPrediction = async () => {
    if (!world) return;
    setPredicting(true);
    let branches: Branch[] = [
      { label: "上海线", route: "shanghai", outcome: "她去了上海，获得了更大的舞台，但和母亲的距离变远。", confidence: 0.62, assumption: "她更在意成长，而不是稳定。" },
      { label: "考研线", route: "kaoyan", outcome: "她留下来读研，路径更稳，但会反复怀疑自己是不是在躲。", confidence: 0.48, assumption: "导师的支持能抵消她对“逃避”的恐惧。" },
      { label: "青岛线", route: "qingdao", outcome: "她留在青岛，关系更近，但“如果当时”会长期回响。", confidence: 0.55, assumption: "她愿意用可能性换取确定性。" },
    ];
    try {
      const response = await fetch("/mirai-api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ world: { name: world.name, summary: world.summary, characters: world.characters }, intervention }),
      });
      const data = await response.json() as { branches?: Branch[] };
      if (Array.isArray(data.branches) && data.branches.length === 3) branches = data.branches;
    } catch {
      // keep the local fallback
    } finally {
      setPredicting(false);
    }
    const next: Prediction = {
      id: uid("pred"),
      worldId: world.id,
      intervention: intervention.trim() || "如果她做了另一个选择",
      branches,
      createdAt: today(),
    };
    setPrediction(next);
    setData((current) => ({ ...current, predictions: [next, ...current.predictions] }));
  };

  const play = (route?: string) => {
    if (!world) return;
    localStorage.setItem("mirai.world", JSON.stringify({ id: world.id, name: world.name, characters: world.characters }));
    if (route) localStorage.setItem("mirai.branch", route);
    else localStorage.removeItem("mirai.branch");
    window.location.href = `/mirai-vn.html?world=${encodeURIComponent(world.id)}`;
  };

  /**
   * 侧边栏导出必须和世界线面板导出同一种格式，
   * 否则用户会拿到两个后缀相同、内容互不兼容的 .world.json。
   */
  const exportWorld = () => {
    if (!world) return;
    try {
      const file = exportWorldFile(worldTree, {
        name: world.name,
        author: "Mirai",
        summary: world.summary,
      });
      const blob = new Blob([serializeWorldFile(file)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${world.name}.world.json`;
      link.click();
      URL.revokeObjectURL(url);
      setExportNotice(`已导出 World File · checksum ${file.checksum}`);
    } catch (error) {
      setExportNotice(
        error instanceof Error ? `导出被拒绝：${error.message}` : "导出被拒绝：世界数据不一致",
      );
    }
  };

  const copy = TITLES[active];

  return (
    <div className={styles.studio}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMoon}><Moon size={18} strokeWidth={1.75} aria-hidden /></span>
          <div>
            <h1>Mirai-Selene</h1>
            <p>Studio</p>
          </div>
        </div>

        <nav className={styles.nav} aria-label="工作台">
          {([
            ["worlds", "世界", "一个世界，一条时间线。", Globe2],
            ["worldline", "世界线", "分支、合并、回滚、审计。", GitBranch],
            ["characters", "角色", "捏人、写秘密、定目标。", Users],
            ["predictions", "预测", "让世界跑三条线。", Sparkles],
            ["imports", "导入", "把文字变成世界。", FileInput],
          ] as const).map(([key, label, hint, Icon]) => (
            <button key={key} className={styles.navItem} data-active={active === key} onClick={() => setActive(key)}>
              <span><Icon size={16} strokeWidth={1.75} aria-hidden />{label}</span>
              <small>{hint}</small>
            </button>
          ))}
        </nav>

        <div className={styles.sidebarFoot}>
          <Button variant="primary" size="sm" onClick={() => play()}><Play size={15} strokeWidth={1.75} aria-hidden />打开 VN</Button>
          <Button variant="ghost" size="sm" onClick={exportWorld}><Download size={15} strokeWidth={1.75} aria-hidden />导出世界</Button>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.header}>
          <div>
            <h2>{copy.title}</h2>
            <p>{copy.subtitle}</p>
          </div>
          <div className={styles.headerActions}>
            {active === "worlds" && (
              <>
                <Button variant="secondary" size="sm" onClick={() => setActive("imports")}><Upload size={15} strokeWidth={1.75} aria-hidden />导入内容</Button>
                <Button variant="primary" size="sm" onClick={() => setNewWorldOpen(true)}><Plus size={15} strokeWidth={1.75} aria-hidden />新建世界</Button>
              </>
            )}
            {active === "characters" && <Button variant="primary" size="sm" onClick={() => setCharOpen(true)}><UserPlus size={15} strokeWidth={1.75} aria-hidden />捏一个角色</Button>}
            {active === "predictions" && <Button variant="primary" size="sm" onClick={() => void runPrediction()} loading={predicting}><Sparkles size={15} strokeWidth={1.75} aria-hidden />{predicting ? "Selene 正在推演…" : "运行预测"}</Button>}
            {active === "imports" && (
              <>
                <Button variant="secondary" size="sm" onClick={() => void parseImport()} loading={extracting}><Wand2 size={15} strokeWidth={1.75} aria-hidden />{extracting ? "抽取中…" : "抽取角色"}</Button>
                <Button variant="primary" size="sm" onClick={createWorldFromImport} disabled={!importPreview.length}><Globe2 size={15} strokeWidth={1.75} aria-hidden />生成世界</Button>
              </>
            )}
          </div>
        </header>

        <div className={styles.content}>
          {exportNotice && (
            <div
              role="status"
              style={{
                marginBottom: 12,
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--surface-muted)",
                color: "var(--text-secondary)",
                fontSize: 13,
              }}
            >
              {exportNotice}
            </div>
          )}
          {active === "worldline" && world && (
            <WorldlinePanel
              data={worldTree}
              onChange={(next) => {
                setData((current) => ({
                  ...current,
                  worlds: current.worlds.map((item) =>
                    item.id === world.id ? { ...item, tree: next } : item,
                  ),
                }));
              }}
              worldName={world.name}
              currentId={currentNodeId}
              onCurrentChange={(id) => {
                setCurrentNodeId(id);
                const node = WorldTree.fromData(worldTree).node(id);
                if (node) {
                  localStorage.setItem("mirai.world", JSON.stringify({ id: world.id, name: world.name, characters: world.characters }));
                  localStorage.setItem("mirai.node", JSON.stringify({ id: node.id, state: node.state, label: node.label }));
                }
              }}
              onPlay={(node) => {
                localStorage.setItem("mirai.world", JSON.stringify({ id: world.id, name: world.name, characters: world.characters }));
                localStorage.setItem("mirai.node", JSON.stringify({ id: node.id, state: node.state, label: node.label }));
                window.location.href = `/mirai-vn.html?world=${encodeURIComponent(world.id)}`;
              }}
            />
          )}
          {active === "worlds" && (
            <div className={styles.worldsLayout}>
              <div className={styles.worldList}>
                {data.worlds.map((item) => (
                  <div key={item.id} className={styles.worldRow} data-active={item.id === selectedWorld} onClick={() => setSelectedWorld(item.id)}>
                    <div>
                      <h3>{item.name}</h3>
                      <p>{item.summary}</p>
                      <div className={styles.worldMeta}>
                        <Badge size="sm">{item.characters.length} 角色</Badge>
                        <Badge size="sm">{item.routes.length} 世界线</Badge>
                        <span>{item.createdAt}</span>
                      </div>
                    </div>
                    <Button variant="secondary" size="sm" onClick={(event) => { event.stopPropagation(); setSelectedWorld(item.id); play(); }}><Play size={14} strokeWidth={1.75} aria-hidden />Play</Button>
                  </div>
                ))}
              </div>

              <aside className={styles.worldSide}>
                <div className={styles.sideHeader}>
                  <h3>{world?.name ?? "还没有世界"}</h3>
                  <Badge tone="info" size="sm">World file</Badge>
                </div>
                <p className={styles.muted}>{world?.summary}</p>
                <div className={styles.routeRow}>
                  {world?.routes.map((route) => <Badge key={route} size="sm">{route}</Badge>)}
                </div>
                <div className={styles.castRow}>
                  {characters.slice(0, 5).map((character) => <Avatar key={character.id} name={character.name} src={character.portrait} size="md" />)}
                </div>
                <div className={styles.worldSideActions}>
                  <Button variant="primary" size="sm" onClick={() => play()}><ArrowRight size={15} strokeWidth={1.75} aria-hidden />进入这个世界</Button>
                  <Button variant="ghost" size="sm" onClick={() => setActive("characters")}><Users size={15} strokeWidth={1.75} aria-hidden />管理角色</Button>
                </div>
              </aside>
            </div>
          )}

          {active === "characters" && (
            <div className={styles.charGrid}>
              {characters.map((character) => (
                <div key={character.id} className={styles.charCard}>
                  <Avatar name={character.name} src={character.portrait} size="xl" />
                  <div className={styles.charBody}>
                    <h3>{character.name}</h3>
                    <p className={styles.role}><Users size={13} strokeWidth={1.75} aria-hidden />{character.role}</p>
                    <p>{character.traits}</p>
                    {character.secret && <p className={styles.secret}><Lock size={13} strokeWidth={1.75} aria-hidden />秘密：{character.secret}</p>}
                    {character.goal && <p className={styles.goal}><Target size={13} strokeWidth={1.75} aria-hidden />目标：{character.goal}</p>}
                  </div>
                </div>
              ))}
              <button className={styles.addChar} onClick={() => setCharOpen(true)}>
                <UserPlus size={20} strokeWidth={1.75} aria-hidden />
                <small>捏一个角色</small>
              </button>
            </div>
          )}

          {active === "predictions" && (
            <div className={styles.predictLayout}>
              <div className={styles.predictForm}>
                <label className={styles.label} htmlFor="world-pick">世界</label>
                <select id="world-pick" className={styles.select} value={selectedWorld} onChange={(event) => setSelectedWorld(event.target.value)}>
                  {data.worlds.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <Input label="干预" value={intervention} onChange={(event) => setIntervention(event.target.value)} placeholder="如果林夏去上海" />
                <Button variant="primary" onClick={runPrediction}>运行预测</Button>
                <p className={styles.muted}>这是条件推演，不是预言。每个分支都带着假设和置信度。</p>
              </div>

              <div className={styles.predictResults}>
                {prediction ? prediction.branches.map((branch) => (
                  <div key={branch.label} className={styles.branchCard}>
                    <div className={styles.branchHead}>
                      <Badge tone="info" size="sm" icon={<GitBranch size={13} strokeWidth={1.75} aria-hidden />}>{branch.label}</Badge>
                      <span className={styles.confidence}><TrendingUp size={13} strokeWidth={1.75} aria-hidden />{Math.round(branch.confidence * 100)}%</span>
                    </div>
                    <p>{branch.outcome}</p>
                    <div className={styles.bar}><i style={{ width: `${branch.confidence * 100}%` }} /></div>
                    <p className={styles.assumption}>假设：{branch.assumption}</p>
                    <Button variant="secondary" size="sm" onClick={() => play(branch.route)}><Play size={14} strokeWidth={1.75} aria-hidden />Play this branch</Button>
                  </div>
                )) : <p className={styles.empty}>还没有预测。写一个“如果…”，让世界跑三条线。</p>}
              </div>
            </div>
          )}

          {active === "imports" && (
            <div className={styles.importLayout}>
              <div className={styles.importBox}>
                <label className={styles.label} htmlFor="import-text">粘贴梗概、剧本或角色设定</label>
                <textarea
                  id="import-text"
                  className={styles.textarea}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  placeholder={"例如：\n林夏：22岁，应届生，拿到上海 offer，也在准备考研。\n母亲：50岁，希望女儿留在青岛。\n导师：40岁，建议林夏读研。"}
                />
                <div className={styles.importActions}>
                  <Button variant="secondary" size="sm" onClick={() => void parseImport()} loading={extracting}><Wand2 size={15} strokeWidth={1.75} aria-hidden />{extracting ? "抽取中…" : "抽取角色"}</Button>
                  <Button variant="primary" size="sm" onClick={createWorldFromImport} disabled={!importPreview.length}><Globe2 size={15} strokeWidth={1.75} aria-hidden />生成世界</Button>
                </div>
                <p className={styles.muted}>当前是确定性抽取；下一步接 LLM，把关系、规则和场景一起抽出来。</p>
              </div>

              <div className={styles.importPreview}>
                <div className={styles.sideHeader}><h3>抽取结果</h3><Badge size="sm">{importPreview.length} 角色</Badge></div>
                {importPreview.length ? importPreview.map((character) => (
                  <div key={character.id} className={styles.importRow}>
                    <Avatar name={character.name} src={character.portrait} size="md" />
                    <div>
                      <b>{character.name}</b>
                      <p>{character.role} · {character.traits}</p>
                    </div>
                  </div>
                )) : <p className={styles.empty}>抽取结果会出现在这里。</p>}
              </div>
            </div>
          )}
        </div>
      </main>

      <Drawer open={newWorldOpen} onOpenChange={setNewWorldOpen}>
        <DrawerContent title="新建世界" description="先给世界一个名字和一句话，角色可以慢慢加。">
          <div className={styles.form}>
            <Input label="世界名" value={worldForm.name} onChange={(event) => setWorldForm((form) => ({ ...form, name: event.target.value }))} placeholder="例如：2030 年的青岛" />
            <label className={styles.label} htmlFor="world-summary">一句话</label>
            <textarea id="world-summary" className={styles.textarea} value={worldForm.summary} onChange={(event) => setWorldForm((form) => ({ ...form, summary: event.target.value }))} placeholder="一个还没有被写下来的世界。" />
            <Button variant="primary" onClick={addWorld}><Plus size={15} strokeWidth={1.75} aria-hidden />创建世界</Button>
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer open={charOpen} onOpenChange={setCharOpen}>
        <DrawerContent title="捏一个角色" description="名字、身份、性格、秘密、目标，还有一张立绘。">
          <div className={styles.form}>
            <Input label="名字" value={charForm.name} onChange={(event) => setCharForm((form) => ({ ...form, name: event.target.value }))} placeholder="林夏" />
            <Input label="身份" value={charForm.role} onChange={(event) => setCharForm((form) => ({ ...form, role: event.target.value }))} placeholder="应届生 / 主角" />
            <Input label="性格关键词" value={charForm.traits} onChange={(event) => setCharForm((form) => ({ ...form, traits: event.target.value }))} placeholder="焦虑、敏锐、想要选择权" />
            <Input label="秘密" value={charForm.secret} onChange={(event) => setCharForm((form) => ({ ...form, secret: event.target.value }))} placeholder="她怕的不是选错，是没有选择" />
            <Input label="目标" value={charForm.goal} onChange={(event) => setCharForm((form) => ({ ...form, goal: event.target.value }))} placeholder="在 30 岁前拥有选择权" />
            <div>
              <div className={styles.label}>立绘</div>
              <div className={styles.portraitPicker}>
                {PORTRAITS.map((portrait) => (
                  <button key={portrait} className={styles.portraitButton} data-active={charForm.portrait === portrait} onClick={() => setCharForm((form) => ({ ...form, portrait }))}>
                    <Avatar name={charForm.name || "角色"} src={portrait} size="lg" />
                  </button>
                ))}
              </div>
            </div>
            <Button variant="primary" onClick={addCharacter}><UserPlus size={15} strokeWidth={1.75} aria-hidden />创建角色</Button>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
