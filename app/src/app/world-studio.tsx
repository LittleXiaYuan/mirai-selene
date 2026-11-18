import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, Copy, Download, FileUp, Layers, Link2, LogOut, Pencil, Plus, Sparkles, Store, Trash2 } from "lucide-react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Drawer, DrawerContent } from "@/components/arc/drawer/drawer";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Input } from "@/components/arc/input/input";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Textarea } from "@/components/arc/textarea/textarea";
import { ScreenShell, ScreenShellButton } from "@/components/arc/screen-shell/screen-shell";
import { WorldTree } from "@/world/engine";
import type { WorldSpec } from "@/world/spec";
import { SPEC_SAMPLES } from "@/world/spec-samples";
import { downloadShell, previewShell } from "./game-shell";
import { pushSpec } from "./spec-api";
import type { UseSession } from "./use-session";
import type { UseWorlds, WorldMeta } from "./use-worlds";
import styles from "./world-studio.module.css";

type Filter = "all" | "draft" | "live" | "spec";
type DrawerKind = "create" | "import" | "details" | "list" | "edit" | null;

function statusOf(world: WorldMeta): "draft" | "live" {
  if (world.spec) return "live";
  const count = Object.keys(world.tree.nodes).length;
  return count > 3 ? "live" : "draft";
}

function nodesOf(world: WorldMeta) {
  const nodes = Object.values(world.tree.nodes);
  return {
    nodes: nodes.length,
    branches: nodes.filter((node) => node.kind === "branch" || node.kind === "merge").length,
    lanes: world.lanes?.length ?? 1,
  };
}

function depthOf(world: WorldMeta) {
  const nodes = world.tree.nodes;
  let id = world.cursor;
  let depth = 0;
  const guard = new Set<string>();
  while (id && nodes[id] && !guard.has(id)) {
    guard.add(id);
    depth += 1;
    id = nodes[id].parentId ?? "";
  }
  return depth;
}

function coverOf(world: WorldMeta | undefined) {
  if (!world) return "/mirai/01-cover.webp";
  const spec = world.spec;
  if (spec) {
    return (
      spec.assets_manifest.cover?.path ??
      spec.assets_manifest.backgrounds[Object.keys(spec.assets_manifest.backgrounds)[0] ?? ""]?.path ??
      spec.assets_manifest.portraits[spec.cast[0]?.portrait ?? ""]?.base ??
      "/mirai/01-cover.webp"
    );
  }
  return world.characters[0]?.portrait ?? "/mirai/01-cover.webp";
}

function bannerOf(world: WorldMeta | undefined) {
  if (!world) return "/mirai/01-cover.webp";
  if (world.spec) {
    const spec = world.spec;
    return (
      spec.assets_manifest.backgrounds[Object.keys(spec.assets_manifest.backgrounds)[0] ?? ""]?.path ??
      coverOf(world)
    );
  }
  return "/mirai/01-cover.webp";
}

function playStats(world: WorldMeta | undefined) {
  if (!world) return { minutes: 0, branches: 0, endings: 0 };
  if (world.spec) {
    const nodes = world.spec.logic_nodes;
    const branches = nodes.filter((node) => (node.choices?.length ?? 0) > 1).length;
    const endings = nodes.filter((node) => !(node.choices?.length)).length;
    return { minutes: Math.max(3, Math.round(nodes.length * 1.3)), branches, endings };
  }
  const nodes = Object.values(world.tree.nodes);
  const endings = nodes.filter((node) => !nodes.some((child) => child.parentId === node.id)).length;
  const branches = nodes.filter(
    (node) => nodes.filter((child) => child.parentId === node.id).length > 1,
  ).length;
  return { minutes: Math.max(2, Math.round(nodes.length * 1.2)), branches, endings };
}

function formatWhen(value: string | number | undefined) {
  if (value === undefined || value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** 面板里只说「多久以前」，完整时间放 tooltip。 */
function relativeWhen(value: string | number | undefined) {
  if (value === undefined || value === "") return "—";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return String(value);
  const diff = Date.now() - time;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function shortWhen(value: string | number | undefined) {
  if (value === undefined || value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return sameYear
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
    : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

/** 审计条目按语义分色，圆点靠 CSS 画，不在文案里加前缀。 */
function auditKind(detail: string): "memory" | "branch" | "merge" | "action" {
  if (detail.includes("分出世界线") || detail.startsWith("从")) return "branch";
  if (detail.includes("合并")) return "merge";
  if (detail.includes("记一次")) return "memory";
  return "action";
}

function lastActiveAt(world: WorldMeta | undefined) {
  if (!world) return undefined;
  const audit = world.tree.audit ?? [];
  return audit[audit.length - 1]?.at ?? world.createdAt;
}

/**
 * 世界管理台：Invoice Studio 式的三栏 dashboard。
 * 左：按状态分组的搜索列表；中：选中的世界页（就地编辑）；右：详情/角色/动作。
 */
export function WorldStudio({
  w,
  session,
  onOpen,
  onForge,
  onMarket,
  onIngest,
  onAuth,
  onLogout,
  onGuide,
  onAbout,
}: {
  w: UseWorlds;
  session: UseSession;
  onOpen: () => void;
  onForge: () => void;
  onMarket: () => void;
  onIngest: () => void;
  onAuth: () => void;
  onLogout: () => void;
  onGuide: () => void;
  onAbout: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [compact, setCompact] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createHook, setCreateHook] = useState("");
  const [importText, setImportText] = useState("");
  const [armed, setArmed] = useState(false);
  const [title, setTitle] = useState("");
  const [hook, setHook] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const active = w.active;

  useEffect(() => {
    setTitle(active?.name ?? "");
    setHook(active?.hook ?? "");
    setArmed(false);
  }, [active?.id]);

  useEffect(() => {
    if (!active) return;
    const nextName = title.trim();
    if (!nextName) return;
    if (nextName === active.name && hook === active.hook) return;
    const timer = window.setTimeout(() => w.updateWorld(active.id, { name: nextName, hook }), 700);
    return () => window.clearTimeout(timer);
  }, [title, hook, active?.id, active?.name, active?.hook, w.updateWorld]);

  const tree = useMemo(() => {
    if (!active) return null;
    try {
      return WorldTree.fromData(active.tree);
    } catch {
      return null;
    }
  }, [active]);

  const path = active && tree ? tree.pathTo(active.cursor) : [];
  const audit = tree?.audit ?? [];

  const stats = useMemo(() => {
    const base = { all: w.worlds.length, draft: 0, live: 0, spec: 0 };
    for (const world of w.worlds) {
      if (world.spec) base.spec += 1;
      else if (statusOf(world) === "draft") base.draft += 1;
      else base.live += 1;
    }
    return base;
  }, [w.worlds]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return w.worlds.filter((world) => {
      if (filter === "draft" && (world.spec || statusOf(world) !== "draft")) return false;
      if (filter === "live" && (world.spec || statusOf(world) !== "live")) return false;
      if (filter === "spec" && !world.spec) return false;
      if (!needle) return true;
      return `${world.name} ${world.hook}`.toLowerCase().includes(needle);
    });
  }, [w.worlds, filter, query]);

  const groups = useMemo(() => {
    const live = filtered.filter((world) => !world.spec && statusOf(world) === "live");
    const draft = filtered.filter((world) => !world.spec && statusOf(world) === "draft");
    const spec = filtered.filter((world) => Boolean(world.spec));
    return [
      { key: "live", label: "进行中", items: live },
      { key: "draft", label: "草稿", items: draft },
      { key: "spec", label: "World-Spec", items: spec },
    ].filter((group) => group.items.length > 0);
  }, [filtered]);

  const saving = Boolean(active && (title.trim() !== active.name || hook !== active.hook));

  const saveNow = () => {
    if (!active) return;
    const nextName = title.trim();
    if (!nextName) return;
    if (nextName === active.name && hook === active.hook) return;
    w.updateWorld(active.id, { name: nextName, hook });
  };

  const select = (world: WorldMeta) => {
    saveNow();
    w.setActiveId(world.id);
    setDrawer(null);
  };

  const create = () => {
    if (!createName.trim()) return;
    w.createWorld(createName.trim(), createHook.trim() || "一个还没有被写下来的世界。");
    setCreateName("");
    setCreateHook("");
    setDrawer(null);
    onOpen();
  };

  const doImport = () => {
    if (!importText.trim()) return;
    w.importFile(importText);
    setImportText("");
    setDrawer(null);
  };

  const loadSample = (spec: WorldSpec) => {
    w.loadSpec(spec);
    setDrawer(null);
    onOpen();
  };

  const publish = async () => {
    if (!active?.spec) return;
    const result = await pushSpec(active.spec);
    w.setNotice({
      tone: result.ok ? "ok" : "error",
      text: result.ok
        ? `已发布到服务端 v${result.version ?? "?"}。`
        : result.errors?.[0] ?? "发布失败",
    });
  };

  const statusBadge = (world: WorldMeta) =>
    world.spec ? (
      <Badge size="sm" tone="info">Spec</Badge>
    ) : statusOf(world) === "draft" ? (
      <Badge size="sm" tone="neutral">草稿</Badge>
    ) : (
      <Badge size="sm" tone="success">进行中</Badge>
    );

  const sidebar = (inDrawer = false) => (
    <>
      {!inDrawer ? (
        <div className={styles.brandRow}>
          <span className={styles.brand}>
            Mirai<span>·</span>Selene
          </span>
          {session.user ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void session.logout();
                onLogout();
              }}
            >
              <LogOut size={13} strokeWidth={1.75} aria-hidden />
              {session.user.name}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onAuth}>
              登录
            </Button>
          )}
        </div>
      ) : null}

      {!inDrawer && session.user ? (
        <div
          style={{
            display: "grid",
            gap: 2,
            margin: "0 0 var(--space-3)",
            padding: "10px 12px",
            border: "1px solid color-mix(in oklab, var(--border) 55%, transparent)",
            borderRadius: "var(--radius-control)",
            background: "color-mix(in oklab, var(--surface) 46%, transparent)",
            fontSize: "var(--text-xs)",
            color: "var(--text-muted)",
          }}
          title="账号档案与数据隔离"
        >
          <strong style={{ color: "var(--foreground)", fontWeight: 500 }}>
            {session.user.name}
          </strong>
          <span>{session.user.email}</span>
          <span>
            {session.user.createdAt
              ? `加入于 ${new Date(session.user.createdAt).toLocaleDateString("zh-CN")}`
              : "个人档案"}
            {" · "}世界与档案仅本账号可见
          </span>
        </div>
      ) : null}

      <div className={styles.search}>
        <Input
          label="搜索世界"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="名字或一句处境"
        />
      </div>

      <div className={styles.filters}>
        <SegmentedControl
          label="世界筛选"
          value={filter}
          onValueChange={(next) => setFilter(next as Filter)}
          options={[
            { value: "all", label: "全部" },
            { value: "live", label: "进行" },
            { value: "draft", label: "草稿" },
            { value: "spec", label: "Spec" },
          ]}
        />
      </div>

      <div className={styles.list} role="listbox" aria-label="世界列表">
        {groups.map((group) => (
          <div key={group.key}>
            <div className={styles.groupHead}>
              <span>{group.label}</span>
              <span>{group.items.length}</span>
            </div>
            {group.items.map((world) => (
              <button
                key={world.id}
                type="button"
                role="option"
                aria-selected={world.id === active?.id}
                className={styles.row}
                data-active={world.id === active?.id ? "" : undefined}
                onClick={() => select(world)}
              >
                <img className={styles.thumb} src={coverOf(world)} alt="" loading="lazy" />
                <span className={styles.rowText}>
                  <b>{world.name}</b>
                  <span>
                    {nodesOf(world).nodes} 节点 · {depthOf(world)} 步
                  </span>
                </span>
                {statusBadge(world)}
              </button>
            ))}
          </div>
        ))}
        {!groups.length ? (
          <p className={styles.listEmpty}>没有匹配的世界。</p>
        ) : null}
      </div>

      <div className={styles.sideFoot}>
        <Button onClick={() => setDrawer("create")}>
          <Plus size={16} strokeWidth={1.75} aria-hidden />
          新建世界
        </Button>
        <div className={styles.sideRow}>
          <Button variant="secondary" size="sm" onClick={onForge}>
            <Sparkles size={14} strokeWidth={1.75} aria-hidden />
            用对话造
          </Button>
          <Button variant="ghost" size="sm" onClick={onMarket}>
            世界市场
          </Button>
        </div>
        <div className={styles.links}>
          <Button variant="ghost" size="sm" onClick={onGuide}>
            看一遍引导
          </Button>
          <Button variant="ghost" size="sm" onClick={onAbout}>
            边界与基准
          </Button>
        </div>
      </div>
    </>
  );

  const details = () => {
    if (!active) return null;
    const metrics = nodesOf(active);
    return (
      <div className={styles.details}>
        <header className={styles.detailHead}>
          <div className={styles.detailTitleRow}>
            <h2 className={styles.detailTitle}>世界详情</h2>
            {statusBadge(active)}
          </div>
          <p className={styles.detailSpec} title={active.spec?.id}>
            {active.spec ? `World-Spec · ${active.spec.id}` : "未绑定 World-Spec，走本地世界树"}
          </p>
        </header>

        <div className={styles.statRow}>
          <div className={styles.stat}>
            <b>{metrics.nodes}</b>
            <span>节点</span>
          </div>
          <div className={styles.stat}>
            <b>{metrics.branches}</b>
            <span>分支</span>
          </div>
          <div className={styles.stat}>
            <b>{metrics.lanes}</b>
            <span>世界线</span>
          </div>
          <div className={styles.stat}>
            <b>{playStats(active).endings}</b>
            <span>结局</span>
          </div>
        </div>

        <p className={styles.metaLine}>
          <span title={formatWhen(active.createdAt)}>创建于 {shortWhen(active.createdAt)}</span>
          <span aria-hidden>·</span>
          <span title={formatWhen(lastActiveAt(active))}>最近 {relativeWhen(lastActiveAt(active))}</span>
          <span aria-hidden>·</span>
          <span>约 {playStats(active).minutes} 分钟</span>
        </p>

        <h2 className={styles.sectionLabel}>
          角色
          {active.characters.length ? (
            <span className={styles.sectionCount}>{active.characters.length}</span>
          ) : null}
        </h2>
        <div className={styles.chars}>
          {active.characters.length ? (
            active.characters.map((character) => (
              <div key={character.id} className={styles.char}>
                <Avatar size="sm" name={character.name} src={character.portrait} />
                <span className={styles.charText}>
                  <b>{character.name}</b>
                  <span>{character.role}</span>
                </span>
              </div>
            ))
          ) : (
            <p className={styles.detailEmpty}>还没有角色。用对话造世界时会一起生成。</p>
          )}
        </div>

        <h2 className={styles.sectionLabel}>
          最近动作
          {audit.length ? <span className={styles.sectionCount}>{audit.length}</span> : null}
        </h2>
        <ol className={styles.timeline}>
          {audit.length ? (
            (() => {
              const recent = audit.slice(-6).reverse();
              return recent.map((entry, index) => {
                // 同一批动作时间戳相同，只在变化处标一次，避免六行「5 小时前」
                const label = relativeWhen(entry.at);
                const showTime = index === 0 || label !== relativeWhen(recent[index - 1].at);
                return (
                  <li
                    key={entry.seq}
                    className={styles.timelineItem}
                    data-kind={auditKind(entry.detail)}
                    title={formatWhen(entry.at)}
                  >
                    <span className={styles.timelineDot} aria-hidden />
                    <span className={styles.timelineBody}>
                      <span className={styles.timelineText}>{entry.detail}</span>
                      {showTime ? (
                        <time
                          className={styles.timelineTime}
                          dateTime={new Date(entry.at).toISOString()}
                        >
                          {label}
                        </time>
                      ) : null}
                    </span>
                  </li>
                );
              });
            })()
          ) : (
            <li className={styles.detailEmpty}>还没有操作。</li>
          )}
        </ol>

        {active.spec ? (
          <>
            <h2>资产与发布</h2>
            <div className={styles.detailActions}>
              <Button size="sm" variant="secondary" onClick={() => void publish()}>
                发布到服务端
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void previewShell(active.spec!)}>
                预览游戏壳
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void downloadShell(active.spec!)}>
                导出 H5
              </Button>
            </div>
          </>
        ) : null}

        <h2>整理</h2>
        <div className={styles.detailActions}>
          <Button size="sm" variant="secondary" onClick={() => w.duplicateWorld(active.id)}>
            <Copy size={14} strokeWidth={1.75} aria-hidden />
            复制一个
          </Button>
          <Button size="sm" variant="secondary" onClick={w.exportFile}>
            <Download size={14} strokeWidth={1.75} aria-hidden />
            导出 .world
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDrawer("import")}>
            <FileUp size={14} strokeWidth={1.75} aria-hidden />
            导入世界
          </Button>
        </div>

        <div className={styles.danger}>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (!armed) {
                setArmed(true);
                return;
              }
              w.deleteWorld(active.id);
              setArmed(false);
            }}
          >
            <Trash2 size={14} strokeWidth={1.75} aria-hidden />
            {armed ? "再点一次确认删除" : "删除这个世界"}
          </Button>
          <span className={styles.dangerNote}>删除只影响这份本地存档，导出过的 .world 不受影响。</span>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className={styles.shellWrap}>
        <ScreenShell
        workspace={{ name: "Mirai Selene", detail: "世界管理台", tone: "violet" }}
        nav={[
          { id: "worlds", label: "世界", icon: Layers, count: w.worlds.length },
          { id: "market", label: "世界市场", icon: Store },
          { id: "ingest", label: "舆情摄取", icon: Link2 },
          { id: "forge", label: "用对话造", icon: Sparkles },
        ]}
        sections={groups.map((group) => ({
          id: group.key,
          label: group.label,
          items: group.items.map((world) => ({
            id: `world:${world.id}`,
            label: world.name,
            avatar: coverOf(world),
            count: depthOf(world),
          })),
        }))}
        activeId={active ? `world:${active.id}` : undefined}
        onNavigate={(id) => {
          if (id.startsWith("world:")) {
            const next = w.worlds.find((world) => world.id === id.slice("world:".length));
            if (next) w.setActiveId(next.id);
            return;
          }
          if (id === "market") onMarket();
          if (id === "ingest") onIngest();
          if (id === "forge") onForge();
        }}
        account={{
          name: session.user?.name ?? "访客",
          detail: session.user?.email ?? "未登录",
          menu: session.user
            ? [{ id: "logout", label: "退出登录", icon: LogOut, danger: true, onSelect: onLogout }]
            : undefined,
        }}
        header={
          active
            ? {
                title: active.name,
                meta: `${nodesOf(active).nodes} 节点 · ${playStats(active).branches} 分支 · ${playStats(active).endings} 结局 · 约 ${playStats(active).minutes} 分钟`,
                actions: (
                  <>
                    <ScreenShellButton variant="primary" onClick={onOpen}>
                      {compact ? "进入" : "走进世界"}
                    </ScreenShellButton>
                    <ScreenShellButton
                      iconOnly
                      icon={Pencil}
                      aria-label="编辑世界"
                      title="编辑世界"
                      onClick={() => setDrawer("edit")}
                    />
                    <ScreenShellButton
                      iconOnly
                      icon={Download}
                      aria-label="导出世界"
                      title="导出世界"
                      onClick={w.exportFile}
                    />
                  </>
                ),
              }
            : {
                title: "世界",
                actions: (
                  <ScreenShellButton onClick={() => setDrawer("create")}>
                    新建世界
                  </ScreenShellButton>
                ),
              }
        }
        rightPanel={{
          content: details(),
          label: "世界详情",
          defaultWidth: 400,
          minWidth: 320,
          maxWidth: 520,
          defaultOpen: true,
        }}
        sidebarFooter={
          <div className={styles.sideActions}>
            <Button size="sm" onClick={() => setDrawer("create")}>
              <Plus size={14} strokeWidth={1.75} aria-hidden />
              新建世界
            </Button>
            <Button size="sm" variant="secondary" onClick={onForge}>
              <Sparkles size={14} strokeWidth={1.75} aria-hidden />
              用对话造
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDrawer("import")}>
              <FileUp size={14} strokeWidth={1.75} aria-hidden />
              导入世界
            </Button>
          </div>
        }
        search={{ placeholder: "搜索世界" }}
        variant="inset"
        className={styles.shell}
        style={{
          "--ss-canvas": "color-mix(in oklab, var(--surface) 46%, transparent)",
          "--ss-main": "color-mix(in oklab, var(--background) 24%, transparent)",
          "--ss-raised": "color-mix(in oklab, var(--surface) 56%, transparent)",
          "--ss-field": "color-mix(in oklab, var(--background) 42%, transparent)",
          "--ss-panel-sheet": "color-mix(in oklab, var(--background) 96%, var(--surface))",
        } as CSSProperties}
      >
        {!active ? (
          <div className={styles.empty}>
            <EmptyState
              title="还没有世界"
              description="从一个处境开始，或者让 Selene 问你六个问题。"
              action={
                <div className={styles.emptyActions}>
                  <Button onClick={() => setDrawer("create")}>新建世界</Button>
                  <Button variant="secondary" onClick={onForge}>用对话造一个</Button>
                </div>
              }
            />
          </div>
        ) : (
          <>
            <div
              className={styles.cover}
              style={{ backgroundImage: `url(${bannerOf(active)})` }}
              aria-hidden
            >
              <div className={styles.coverShade} />
              <div className={styles.coverText}>
                {statusBadge(active)}
                <p>{active.hook || "还没有写处境。"}</p>
              </div>
            </div>


            <section className={styles.metrics} aria-label="世界指标">
              <div className={styles.metric}><span>节点</span><b>{nodesOf(active).nodes}</b></div>
              <div className={styles.metric}><span>分支</span><b>{nodesOf(active).branches}</b></div>
              <div className={styles.metric}><span>世界线</span><b>{nodesOf(active).lanes}</b></div>
              <div className={styles.metric}><span>当前步</span><b>{path.length}</b></div>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h2>这条世界线</h2>
                <span>{path.length} 步</span>
              </div>
              <div className={styles.pathList}>
                {path.slice(-8).map((node) => (
                  <div key={node.id} className={styles.pathRow} data-current={node.id === active.cursor ? "" : undefined}>
                    <span className={styles.pathKind}>{node.kind}</span>
                    <span className={styles.pathLabel}>{node.label}</span>
                  </div>
                ))}
                {!path.length ? <p className={styles.detailEmpty}>这条线还没有走过。</p> : null}
              </div>
            </section>

            <section className={styles.specBlock}>
              {active.spec ? (
                <>
                  <div className={styles.sectionHead}>
                    <h2>World-Spec</h2>
                    <span>{active.spec.id}</span>
                  </div>
                  <div className={styles.specGrid}>
                    <span className={styles.specCell}>
                      背景
                      <b>{Object.keys(active.spec.assets_manifest.backgrounds).length}</b>
                    </span>
                    <span className={styles.specCell}>
                      立绘
                      <b>{Object.keys(active.spec.assets_manifest.portraits).length}</b>
                    </span>
                    <span className={styles.specCell}>
                      叙事节点
                      <b>{active.spec.logic_nodes.length}</b>
                    </span>
                    <span className={styles.specCell}>
                      温度
                      <b>{active.spec.state_injection.temperature ?? "默认"}</b>
                    </span>
                    <span className={styles.specCell}>
                      调色
                      <b>{active.spec.ui?.palette ?? "warm"}</b>
                    </span>
                    <span className={styles.specCell}>
                      入口
                      <b>{active.spec.entry}</b>
                    </span>
                  </div>
                  <div className={styles.row2}>
                    <Button size="sm" onClick={publish}>发布到服务端</Button>
                    <Button size="sm" variant="secondary" onClick={() => void previewShell(active.spec!)}>
                      预览游戏壳
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void downloadShell(active.spec!)}>
                      导出 H5
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.sectionHead}>
                    <h2>还没有 World-Spec</h2>
                    <span>可绑定</span>
                  </div>
                  <p className={styles.detailEmpty}>
                    用对话造一个，或者在铸造台里粘贴一份 Spec；绑定后就能导出 H5 游戏壳。
                  </p>
                  <div className={styles.row2}>
                    <Button size="sm" variant="secondary" onClick={onForge}>用对话造一个</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDrawer("import")}>从文件载入</Button>
                  </div>
                </>
              )}
            </section>
          </>
        )}
        </ScreenShell>
      </div>

      <Drawer
        open={drawer === "edit"}
        onOpenChange={(open) => {
          if (open) return;
          saveNow();
          setDrawer(null);
        }}
      >
        <DrawerContent
          side={compact ? "bottom" : "right"}
          title="编辑世界"
          description="改世界名和一句处境；停止输入 700ms 后自动保存。"
        >
          <div className={styles.stack}>
            <Input
              label="世界名"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：周三之前"
            />
            <Textarea
              label="一句话说清这个世界的处境"
              value={hook}
              onChange={(event) => setHook(event.target.value)}
              placeholder="例如：母亲的复查报告在周三出，上海的 offer 要你在周二答复。"
              rows={4}
            />
            <span className={styles.saveState}>{saving ? "正在保存…" : "已自动保存"}</span>
            <Button
              onClick={() => {
                saveNow();
                setDrawer(null);
              }}
            >
              完成
            </Button>
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer open={drawer === "create"} onOpenChange={(open) => !open && setDrawer(null)}>
        <DrawerContent
          side={compact ? "bottom" : "right"}
          title="新建世界"
          description="先给一个名字和一句处境，之后可以继续改。"
        >
          <div className={styles.stack}>
            <Input
              label="世界叫什么"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="例如：陈默的第三次面试"
            />
            <Textarea
              label="一句话说清这个世界的处境"
              value={createHook}
              onChange={(event) => setCreateHook(event.target.value)}
              placeholder="例如：他手上有一份不喜欢的 offer，和一个不敢答应的邀请。"
              rows={3}
            />
            <Button onClick={create} disabled={!createName.trim()}>
              建好，走进去
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setDrawer(null);
                onForge();
              }}
            >
              用对话造一个世界
            </Button>
            <div className={styles.templateBlock}>
              <span className={styles.templateLabel}>或从模板开始</span>
              <div className={styles.row2}>
                {SPEC_SAMPLES.map((sample) => (
                  <Button key={sample.id} size="sm" variant="ghost" onClick={() => loadSample(sample)}>
                    {sample.title}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </DrawerContent>
      </Drawer>

      <Drawer open={drawer === "import"} onOpenChange={(open) => !open && setDrawer(null)}>
        <DrawerContent
          side={compact ? "bottom" : "right"}
          title="导入世界"
          description="载入一份 .world 文件，或粘贴 World-Spec / 世界文件内容。"
        >
          <div className={styles.stack}>
            <Button variant="secondary" onClick={() => fileRef.current?.click()}>
              <FileUp size={16} strokeWidth={1.75} aria-hidden />
              选择世界文件
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
                event.target.value = "";
              }}
            />
            <Textarea
              label="或粘贴内容"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder='{"magic":"mirai-selene/world", ...}'
              rows={6}
            />
            <Button onClick={doImport} disabled={!importText.trim()}>
              载入
            </Button>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
