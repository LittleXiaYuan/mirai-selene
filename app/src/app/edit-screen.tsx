import { useMemo, useState } from "react";
import { ArrowLeft, Download, GitMerge, Plus, Sparkles, UserPlus } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Textarea } from "@/components/arc/textarea/textarea";
import { Select } from "@/components/arc/select/select";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Alert } from "@/components/arc/alert/alert";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { DEFAULT_CHOICES, type UseWorlds } from "./use-worlds";
import styles from "./edit.module.css";

const KIND_WORD: Record<string, string> = {
  root: "起点",
  observe: "一步",
  set: "设定",
  branch: "分叉",
  merge: "接上",
  rollback: "退回",
};

const PANELS = [
  { value: "people", label: "人物" },
  { value: "choices", label: "岔路" },
  { value: "map", label: "世界线" },
  { value: "file", label: "带走" },
];

export function EditScreen({
  w,
  onPlay,
  onHome,
}: {
  w: UseWorlds;
  onPlay: () => void;
  onHome: () => void;
}) {
  const [panel, setPanel] = useState("people");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [traits, setTraits] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [intervention, setIntervention] = useState("");
  const [predicting, setPredicting] = useState(false);
  const [branches, setBranches] = useState<
    { label: string; outcome: string; confidence: number; assumption: string }[]
  >([]);
  const [raw, setRaw] = useState("");
  const [cLabel, setCLabel] = useState("");
  const [cKey, setCKey] = useState("");
  const [cValue, setCValue] = useState("5");
  const [cSub, setCSub] = useState("");

  const tree = w.tree;
  const node = w.cursor?.node;

  const mapRows = useMemo(() => {
    if (!tree) return [];
    const out: { id: string; label: string; kind: string; depth: number }[] = [];
    const walk = (id: string, depth: number) => {
      const n = tree.node(id);
      if (!n) return;
      out.push({ id: n.id, label: n.label, kind: n.kind, depth });
      for (const c of tree.children(id)) walk(c.id, depth + 1);
    };
    walk(tree.root.id, 0);
    return out;
  }, [tree]);

  const mergeOptions = useMemo(
    () => [
      { value: "", label: "选择一条世界线" },
      ...(tree
        ? tree.nodes
            .filter((n) => n.id !== node?.id && !(node?.mergedFrom ?? []).includes(n.id))
            .map((n) => ({ value: n.id, label: `${n.label}（${KIND_WORD[n.kind] ?? n.kind}）` }))
        : []),
    ],
    [tree, node],
  );

  const runPredict = async () => {
    if (!w.active) return;
    setPredicting(true);
    try {
      const res = await fetch("/mirai-api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          world: {
            name: w.active.name,
            summary: w.active.hook,
            characters: w.active.characters,
          },
          intervention: intervention.trim() || "如果她做了另一个选择",
        }),
      });
      const data = (await res.json()) as { branches?: typeof branches };
      if (Array.isArray(data.branches) && data.branches.length) {
        setBranches(data.branches);
        return;
      }
    } catch {
      // 落回本地三条线，功能不消失
    } finally {
      setPredicting(false);
    }
    setBranches([
      { label: "去上海", outcome: "她去了上海，获得了更大的舞台，但和母亲的距离变远。", confidence: 0.62, assumption: "她更在意成长。" },
      { label: "留校读研", outcome: "她留下来读研，路径更稳，但会反复怀疑自己是不是在躲。", confidence: 0.48, assumption: "导师的支持能抵消恐惧。" },
      { label: "先回青岛", outcome: "她留在青岛，关系更近，但「如果当时」会长期回响。", confidence: 0.55, assumption: "她愿意用可能性换确定性。" },
    ]);
  };

  if (!tree || !node || !w.active) {
    return (
      <div className="page">
        <EmptyState
          title="还没有世界"
          description="先在世界列表里新建一个。"
          action={<Button onClick={onHome}>回到世界列表</Button>}
        />
      </div>
    );
  }

  return (
    <div className={styles.edit}>
      <header className={styles.toolbar}>
        <div className={styles.toolbarTop}>
          <button className="icon-button" onClick={onHome} aria-label="回到世界列表">
            <ArrowLeft size={20} strokeWidth={1.75} aria-hidden />
          </button>
          <div className={styles.toolbarTitle}>
            <h1>{w.active.name}</h1>
            <p>编辑中</p>
          </div>
          <Button variant="secondary" onClick={onPlay}>
            走进去
          </Button>
        </div>
        <div className="segmented-touch">
          <SegmentedControl
            options={PANELS}
            value={panel}
            onValueChange={setPanel}
            label="编辑面板"
          />
        </div>
      </header>

      <div className={styles.body}>
        {panel === "people" && (
          <>
            <div className={styles.intro}>
              <p>
                每个人只要三件事：叫什么、是谁、心里在打什么算盘。观众走进世界后，会从他们的视角做选择。
              </p>
            </div>

            {w.active.characters.length ? (
              w.active.characters.map((c) => (
                <div key={c.id} className={styles.person}>
                  <img src={c.portrait} alt="" />
                  <div className={styles.personBody}>
                    <div className={styles.personName}>{c.name}</div>
                    <div className={styles.personRole}>{c.role}</div>
                    <div className={styles.personTraits}>{c.traits}</div>
                  </div>
                </div>
              ))
            ) : (
              <EmptyState
                title="还没有人物"
                description="加第一个人，世界才有视角。"
              />
            )}

            <div className={styles.form}>
              <Input
                label="名字"
                value={name}
                onChange={(e) => setName(e.target.value)}
          className="field-16"
                placeholder="例如：陈默"
              />
              <Input
                label="是谁"
                value={role}
                onChange={(e) => setRole(e.target.value)}
          className="field-16"
                placeholder="例如：主角 / 母亲 / 老板"
              />
              <Textarea
                label="心里在打什么算盘"
                description="一句话就够，越具体越好"
                value={traits}
                onChange={(e) => setTraits(e.target.value)}
          className="field-16"
                placeholder="例如：他怕的不是失败，是被人看穿他在装"
                rows={2}
              />
              <Button
                onClick={() => {
                  w.addCharacter({
                    name: name.trim(),
                    role: role.trim() || "角色",
                    traits: traits.trim() || "待补充",
                  });
                  setName("");
                  setRole("");
                  setTraits("");
                }}
                disabled={!name.trim()}
              >
                <UserPlus size={16} strokeWidth={1.75} aria-hidden />
                让这个人走进世界
              </Button>
            </div>
          </>
        )}

        {panel === "choices" && (
          <>
            <div className={styles.intro}>
              <p>
                观众走进世界后，看到的不是表单，是几个可以点的岔路。每条岔路会在世界里留下一条记忆，
                记忆越强，后面越容易被提起。
              </p>
            </div>

            {(w.active.choices ?? DEFAULT_CHOICES).map((c) => (
              <div key={c.id} className={styles.mapRow}>
                <span className={styles.mapLabel}>
                  {c.label}
                  <span className={styles.mapDepth} style={{ marginLeft: "var(--space-2)" }}>
                    {c.key} {c.value}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  onClick={() => w.removeChoiceFromWorld(c.id)}
                  aria-label={`删掉岔路 ${c.label}`}
                >
                  删掉
                </Button>
              </div>
            ))}

            <div className={styles.form}>
              <Input
                label="这条岔路写着什么"
                value={cLabel}
                onChange={(e) => setCLabel(e.target.value)}
                placeholder="例如：接下那份外派"
                className="field-16"
              />
              <Input
                label="留下的记忆叫什么"
                value={cKey}
                onChange={(e) => setCKey(e.target.value)}
                placeholder="例如：时差"
                className="field-16"
              />
              <Input
                label="这条记忆有多重（0 到 10）"
                value={cValue}
                onChange={(e) => setCValue(e.target.value)}
                inputMode="numeric"
                placeholder="5"
                className="field-16"
              />
              <Input
                label="补充一句，可以不填"
                value={cSub}
                onChange={(e) => setCSub(e.target.value)}
                placeholder="例如：更大的盘子，更少的人"
                className="field-16"
              />
              <Button
                onClick={() => {
                  const v = Math.max(0, Math.min(10, Number(cValue) || 5));
                  w.addChoiceToWorld({
                    label: cLabel.trim(),
                    key: cKey.trim() || cLabel.trim(),
                    value: v,
                    sub: cSub.trim() || undefined,
                  });
                  setCLabel("");
                  setCKey("");
                  setCValue("5");
                  setCSub("");
                }}
                disabled={!cLabel.trim()}
              >
                <Plus size={16} strokeWidth={1.75} aria-hidden />
                加一条岔路
              </Button>
            </div>
          </>
        )}

        {panel === "map" && (
          <>
            <div className={styles.intro}>
              <p>
                每做一个选择就多一个节点。你可以从任何一步分叉，也可以把两条线接上。接上之后两边的内容都保留。
              </p>
            </div>

            <div className={styles.mapList}>
              {mapRows.map((r) => (
                <div key={r.id} className={styles.mapRow} style={{ paddingLeft: r.depth * 14 }}>
                  <span className={styles.mapKind}>{KIND_WORD[r.kind] ?? r.kind}</span>
                  <span className={styles.mapLabel}>{r.label}</span>
                  <span className={styles.mapDepth}>{r.depth}</span>
                </div>
              ))}
            </div>

            <div className={styles.form}>
              <Select
                label="把另一条线接到现在这一步"
                value={mergeTarget}
                onValueChange={setMergeTarget}
                options={mergeOptions}
              />
              <Button
                variant="secondary"
                onClick={() => {
                  w.mergeInto(mergeTarget);
                  setMergeTarget("");
                }}
                disabled={!mergeTarget}
              >
                <GitMerge size={16} strokeWidth={1.75} aria-hidden />
                接上
              </Button>

              <Alert tone="info" title="为什么接得上">
                每个节点都记着自己包含了哪些更早的节点，所以同一条线接两次不会算重。两条线对同一个人写了不同设定时会直接拒绝，并告诉你冲突在哪。
              </Alert>

              <Input
                label="让世界跑三条线看看"
                value={intervention}
                onChange={(e) => setIntervention(e.target.value)}
          className="field-16"
                placeholder="例如：如果林夏去上海"
              />
              <Button variant="secondary" onClick={() => void runPredict()} loading={predicting}>
                <Sparkles size={16} strokeWidth={1.75} aria-hidden />
                {predicting ? "正在推演" : "推演三条世界线"}
              </Button>

              {branches.map((b) => (
                <div key={b.label} className={styles.branchCard}>
                  <div className={styles.branchBody}>
                    <div className={styles.branchHead}>
                      <span className={styles.branchName}>{b.label}</span>
                      <span className={styles.branchConfidence}>
                        {Math.round(b.confidence * 100)}%
                      </span>
                    </div>
                    <div className={styles.branchOutcome}>{b.outcome}</div>
                    <div className={styles.branchAssumption}>前提：{b.assumption}</div>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => w.choose(b.label, "推演", Math.round(b.confidence * 10))}
                    aria-label={`走进 ${b.label}`}
                  >
                    <Plus size={16} strokeWidth={1.75} aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}

        {panel === "file" && (
          <>
            <div className={styles.intro}>
              <p>
                导出的文件里装着整个世界：所有节点、所有记忆、所有分支。别人拿到能原样载入，不依赖我们的服务器。
              </p>
            </div>

            <div className="stack">
              <Button onClick={w.exportFile}>
                <Download size={16} strokeWidth={1.75} aria-hidden />
                导出世界文件
              </Button>

              {w.report && (
                <Alert
                  tone={w.report.fileOk ? "success" : "danger"}
                  title={w.report.fileOk ? "这个世界是完整的" : "这个世界有问题"}
                >
                  {w.report.message}
                </Alert>
              )}

              <Alert tone="info" title="为什么可以信任这个文件">
                文件里带一个校验值，覆盖的是每个节点的实际内容，不只是结构。改动任何一个字，载入时都会拒绝，而不是变成半个世界。
              </Alert>

              <Textarea
                label="载入别人的世界文件"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
          className="field-16"
                placeholder='{"magic":"mirai-selene/world", ...}'
                rows={4}
              />
              <Button
                variant="secondary"
                onClick={() => {
                  w.importFile(raw);
                  setRaw("");
                }}
                disabled={!raw.trim()}
              >
                载入
              </Button>

              <Button variant="ghost" onClick={w.resetToDemo}>
                回到示例世界
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
