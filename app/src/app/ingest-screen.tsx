import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Link2,
  Lock,
  MessageSquare,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { AppTopBar } from "./app-topbar";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Input } from "@/components/arc/input/input";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { Textarea } from "@/components/arc/textarea/textarea";
import {
  getAgentRun,
  ingestSocial,
  loadAgentRuns,
  loadSocialCases,
  simulateAgents,
  type AgentRun,
  type FactionAgent,
  type IngestResult,
  type SimResult,
} from "./ingest-api";
import styles from "./ingest.module.css";

type Mode = "link" | "text";

/** 回放历史作业时不一定带着 spec，页面只用快照与阵营。 */
type IngestView = Omit<IngestResult, "spec"> & { spec?: IngestResult["spec"] };

/**
 * 现实吞噬器：一条热帖 → 快照 → 阵营 Agent → 上帝视角推演 / 选一个身份走进去。
 * 模型层未接时不伪造矩阵：推演标注为本地策略沙盘。
 */
export function IngestScreen({
  onHome,
  onEnter,
  onWorlds,
  onForge,
  onAuth,
  onWorkspace,
  signedInName,
  autoRunDemo,
}: {
  onHome: () => void;
  onEnter: (spec: IngestResult["spec"]) => void;
  onWorlds: () => void;
  onForge: () => void;
  onAuth: () => void;
  onWorkspace: () => void;
  signedInName?: string;
  autoRunDemo?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("link");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);
  const [result, setResult] = useState<IngestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cases, setCases] = useState<{ id: string; title: string; source_url: string }[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);

  // 窄屏下 .layout 自己滚，载入/回放后把视线带回快照顶部
  const toTop = () => {
    layoutRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const [intervention, setIntervention] = useState("官方深夜发了一封没有公章的致歉信");
  const [simBusy, setSimBusy] = useState(false);
  const [sim, setSim] = useState<SimResult | null>(null);

  const demoRanRef = useRef(false);

  useEffect(() => {
    void loadSocialCases().then((items) => {
      const top = items.slice(0, 4);
      setCases(top);
      if (autoRunDemo && !demoRanRef.current) {
        demoRanRef.current = true;
        const first = top[0];
        if (first?.source_url) {
          setMode("link");
          setUrl(first.source_url);
          void runIngest({ url: first.source_url });
        } else {
          const sampleText =
            "凌晨三点写完辞职信：连续三个月通宵赶大版本上线，结果年终评定部门负责人把核心功劳划给了刚空降的汇报线，还私下劝我「再忍半年等期权池调整」。我现在该直接把辞职信抄送全员，还是先找 CTO 私下摊牌？";
          setMode("text");
          setText(sampleText);
          void runIngest({ text: sampleText });
        }
      }
    });
    void loadAgentRuns().then(setRuns);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunDemo]);

  const source = useMemo(
    () => ({ url: mode === "link" ? url : undefined, text: mode === "text" ? text : undefined }),
    [mode, url, text],
  );

  const runIngest = async (override?: { url?: string; text?: string }) => {
    const payload = override ?? source;
    if (!payload.url?.trim() && !payload.text?.trim()) {
      setError("给一条链接，或者粘贴一段正文。");
      return;
    }
    setBusy(true);
    setError(null);
    setSim(null);
    const res = await ingestSocial(payload);
    setBusy(false);
    if (!res?.ok) {
      setError("没有拆出可用的世界，换一条再试。");
      return;
    }
    setResult(res);
    setSelected(res.factions[0]?.id ?? null);
    setIntervention(`针对「${res.snapshot.title}」，官方发了一封没有公章的道歉信`);
    toTop();
    void loadAgentRuns().then(setRuns);
  };

  const runSim = async (nextIntervention?: string) => {
    if (!result) return;
    const said = nextIntervention ?? intervention;
    setSimBusy(true);
    const res = await simulateAgents({
      factions: result.factions,
      intervention: { text: said },
      rounds: 3,
      ingest_run_id: result.run_id,
    });
    setSimBusy(false);
    if (res?.ok) {
      setSim(res);
      void loadAgentRuns().then(setRuns);
    }
  };

  const openRun = async (run: AgentRun) => {
    const saved = await getAgentRun(run.id);
    if (!saved) return;
    if (saved.kind === "ingest") {
      const output = saved.output as IngestResult;
      if (!output?.ok) return;
      setResult(output);
      setSelected(output.factions[0]?.id ?? null);
      setSim(null);
      setIntervention(`针对「${output.snapshot.title}」，官方发了一封没有公章的道歉信`);
      toTop();
    } else if (saved.kind === "simulate") {
      const output = saved.output as SimResult;
      if (!output?.ok) return;
      setError(null);
      if (!result) {
        const input = saved.input as {
          factions?: FactionAgent[];
          intervention?: string | { text?: string };
          ingest_run_id?: string;
        };
        let restored: IngestView | null = null;
        if (input.ingest_run_id) {
          const parent = await getAgentRun(input.ingest_run_id);
          const parentOutput = parent?.output as IngestResult | undefined;
          if (parentOutput?.ok) restored = parentOutput;
        }
        if (!restored && input.factions?.length) {
          restored = {
            ok: true,
            fetched: false,
            fallback: false,
            provider: "replay",
            snapshot: {
              title: output.intervention,
              body: "这次推演的热帖快照没有随作业保存，下面是当时投入的干预和阵营时间线。想找回原帖，请回放同一时间附近的摄取作业。",
              tags: [],
              comments: [],
              source_type: "replay",
              source_url: "",
              polarization: 0.5,
            },
            factions: input.factions,
          };
        }
        if (!restored) {
          setError("这次推演没有留下可回放的阵营。");
          return;
        }
        setResult(restored);
        setSelected(restored.factions[0]?.id ?? null);
      }
      setSim(output);
      setIntervention(output.intervention);
      if (!result) toTop();
    } else if (saved.kind === "forge") {
      const output = saved.output as { spec?: IngestResult["spec"] };
      if (output?.spec) onEnter(output.spec);
    }
  };

  const enterAs = async (faction: FactionAgent) => {
    setEntering(faction.id);
    const res = await ingestSocial({ ...source, player_faction: faction.id });
    setEntering(null);
    if (res?.spec) onEnter(res.spec);
  };

  const selectedFaction = result?.factions.find((faction) => faction.id === selected) ?? null;

  return (
    <div className={styles.page}>
      <AppTopBar
        onBack={onWorlds}
        onHome={onHome}
        onAuth={onAuth}
        onWorkspace={onWorkspace}
        signedInName={signedInName}
      >
        <Button variant="ghost" size="sm" onClick={onForge}>
          <Sparkles size={14} strokeWidth={1.75} aria-hidden />
          用对话造
        </Button>
      </AppTopBar>

      <div className={styles.layout} ref={layoutRef}>
        <section className={styles.left}>
          <div className={styles.inputCard}>
            <div className={styles.inputHead}>
              <span className={styles.kicker}>现实吞噬器</span>
              <SegmentedControl
                label="输入方式"
                value={mode}
                onValueChange={(next) => setMode(next as Mode)}
                options={[
                  { value: "link", label: "小红书 / 抖音链接" },
                  { value: "text", label: "粘贴正文" },
                ]}
              />
            </div>

            {mode === "link" ? (
              <Input
                label="热帖链接"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://www.xiaohongshu.com/explore/..."
              />
            ) : (
              <Textarea
                label="粘贴正文、评论或一段处境"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="把帖子正文、最高赞评论、你看到的争议点贴进来…"
                rows={5}
              />
            )}

            <div className={styles.inputActions}>
              <Button onClick={() => void runIngest()} loading={busy}>
                <Link2 size={15} strokeWidth={1.75} aria-hidden />
                拆解阵营
              </Button>
              {error ? <span className={styles.error}>{error}</span> : null}
            </div>

            {cases.length ? (
              <div className={styles.cases}>
                <span className={styles.caseLabel}>或者试一条内置快照</span>
                <div className={styles.caseRow}>
                  {cases.map((item) => (
                    <Button
                      key={item.id}
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setMode("link");
                        setUrl(item.source_url);
                        void runIngest({ url: item.source_url });
                      }}
                    >
                      {item.title}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {busy && !result ? <Skeleton lines={6} label="正在拆解评论与阵营" /> : null}

          {result ? (
            <>
              <article className={styles.snapshot}>
                <div className={styles.snapshotHead}>
                  <Badge tone={result.fallback || result.provider === "replay" ? "warning" : "info"} size="sm">
                    {result.provider === "fetch"
                      ? "实时抓取"
                      : result.provider === "replay"
                        ? "作业回放"
                        : result.fallback
                          ? "内置快照 · 反爬兜底"
                          : "快照"}
                  </Badge>
                  <span className={styles.snapshotMeta}>
                    {result.snapshot.source_type} · 样本 {result.snapshot.comments.length} 条
                  </span>
                </div>
                <h2>{result.snapshot.title}</h2>
                <p>{result.snapshot.body}</p>
                <div className={styles.tags}>
                  {result.snapshot.tags.map((tag) => (
                    <span key={tag} className={styles.tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                {result.snapshot.comments.length ? (
                  <div className={styles.comments}>
                    <span className={styles.kicker}>
                      <MessageSquare size={12} strokeWidth={1.75} aria-hidden />
                      高赞评论
                    </span>
                    {result.snapshot.comments.slice(0, 3).map((comment, index) => (
                      <div key={`${comment.text}-${index}`} className={styles.comment}>
                        <span>{comment.text}</span>
                        <b>{comment.likes ?? 0}</b>
                      </div>
                    ))}
                  </div>
                ) : null}
                {result.snapshot.note ? <p className={styles.note}>{result.snapshot.note}</p> : null}
              </article>

              <section className={styles.factions}>
                <div className={styles.sectionHead}>
                  <h2>
                    <Users size={16} strokeWidth={1.75} aria-hidden />
                    拆出的 {result.factions.length} 个阵营 Agent
                  </h2>
                  <span>表层话术 + 隐秘底牌</span>
                </div>
                <div className={styles.factionGrid}>
                  {result.factions.map((faction) => (
                    <button
                      key={faction.id}
                      type="button"
                      className={styles.faction}
                      data-active={selected === faction.id ? "" : undefined}
                      onClick={() => setSelected(faction.id)}
                    >
                      <div className={styles.factionHead}>
                        <Avatar size="md" name={faction.name} src={`/mirai/${faction.portrait}.webp`} />
                        <span className={styles.factionName}>
                          <b>{faction.name}</b>
                          <span>{faction.role}</span>
                        </span>
                      </div>
                      <p className={styles.claim}>{faction.public_claim}</p>
                      <p className={styles.motive}>
                        <Lock size={12} strokeWidth={1.75} aria-hidden />
                        底牌：{faction.hidden_motive}
                      </p>
                      <div className={styles.bias}>
                        <span>
                          信任 <b>{faction.initial_bias.trust.toFixed(1)}</b>
                        </span>
                        <span>
                          摩擦 <b>{faction.initial_bias.friction.toFixed(1)}</b>
                        </span>
                        <span>
                          死穴 <b>{faction.initial_bias.ruin_threshold.toFixed(1)}</b>
                        </span>
                      </div>
                      <span className={styles.playAs}>
                        {entering === faction.id ? "正在进入…" : "扮演 TA"}
                        <ArrowRight size={13} strokeWidth={2} aria-hidden />
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </>
          ) : null}
        </section>

        <aside className={styles.right}>
          {!result ? (
            <div className={styles.intro}>
              <EmptyState
                title="一条热帖，拆成一个可扮演的世界"
                description="抓正文与高赞评论，拆出 3–5 个阵营；你可以当上帝推演，也可以选一个身份走进去。"
              />
            </div>
          ) : (
            <>
              <div className={styles.simCard}>
                <div className={styles.sectionHead}>
                  <h2>
                    <Activity size={16} strokeWidth={1.75} aria-hidden />
                    上帝视角 · 多 Agent 推演
                  </h2>
                  <Badge tone="neutral" size="sm">
                    {sim?.provider === "local-policy" ? "本地策略沙盘" : "待推演"}
                  </Badge>
                </div>

                <Textarea
                  label="投入一个干预事件"
                  value={intervention}
                  onChange={(event) => setIntervention(event.target.value)}
                  rows={3}
                  placeholder="例如：官方深夜发道歉信，但避谈赔偿"
                />

                <div className={styles.simActions}>
                  <Button onClick={() => void runSim()} loading={simBusy}>
                    <ShieldAlert size={15} strokeWidth={1.75} aria-hidden />
                    跑三轮
                  </Button>
                  {selectedFaction ? (
                    <Button variant="secondary" onClick={() => void enterAs(selectedFaction)} loading={entering === selectedFaction.id}>
                      以 {selectedFaction.name.split("·")[0]} 的身份走进去
                    </Button>
                  ) : null}
                </div>

                {sim?.branches.length ? (
                  <div className={styles.branches}>
                    {sim.branches.map((branch) => (
                      <button
                        key={branch.id}
                        type="button"
                        className={styles.branch}
                        onClick={() => {
                          setIntervention(branch.text);
                          void runSim(branch.text);
                        }}
                      >
                        <span>{branch.label}</span>
                        <b>失控 {Math.round(branch.projected_ruin * 100)}%</b>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {sim ? (
                <div className={styles.metrics}>
                  <div>
                    <span>失控概率</span>
                    <b>{Math.round(sim.metrics.ruin_prob * 100)}%</b>
                  </div>
                  <div>
                    <span>极化</span>
                    <b>{sim.metrics.polarization.toFixed(2)}</b>
                  </div>
                  <div>
                    <span>决裂</span>
                    <b>{sim.metrics.rupture_actors.length}</b>
                  </div>
                </div>
              ) : null}

              {sim ? (
                <div className={styles.timeline}>
                  {Array.from(new Set(sim.timeline.map((event) => event.round))).map((round) => (
                    <div key={round} className={styles.round}>
                      <span className={styles.kicker}>第 {round} 轮</span>
                      {sim.timeline
                        .filter((event) => event.round === round)
                        .map((event) => (
                          <div key={`${event.round}-${event.faction_id}`} className={styles.event}>
                            <Avatar size="sm" name={event.faction_name} src={`/mirai/${event.portrait}.webp`} />
                            <span className={styles.eventBody}>
                              <span className={styles.eventHead}>
                                <b>{event.faction_name}</b>
                                <Badge
                                  size="sm"
                                  tone={
                                    event.stance === "rupture"
                                      ? "danger"
                                      : event.stance === "empathetic"
                                        ? "success"
                                        : event.stance === "skeptical_push"
                                          ? "warning"
                                          : "neutral"
                                  }
                                >
                                  {event.stance_label}
                                </Badge>
                                <span className={styles.eventMeta}>
                                  信任 {event.trust} · 摩擦 {event.friction}
                                </span>
                              </span>
                              <p>{event.message}</p>
                            </span>
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}

          {runs.filter((run) => run.kind !== "forge" || Boolean(result)).length ? (
            <div className={styles.history}>
              <span className={styles.kicker}>最近的作业</span>
              {runs
                .filter((run) => run.kind !== "forge" || Boolean(result))
                .slice(0, 6)
                .map((run) => (
                <button key={run.id} type="button" className={styles.run} onClick={() => void openRun(run)}>
                  <Badge size="sm" tone={run.kind === "simulate" ? "info" : "neutral"}>
                    {run.kind === "simulate" ? "推演" : run.kind === "forge" ? "铸造" : "摄取"}
                  </Badge>
                  <span>{run.title}</span>
                  <small>{new Date(run.created_at).toLocaleString("zh-CN", { hour12: false })}</small>
                </button>
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
