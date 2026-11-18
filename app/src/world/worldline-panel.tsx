import { useCallback, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  GitBranch,
  GitMerge,
  History,
  RotateCcw,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import {
  MergeError,
  WorldTree,
  inspectTree,
  slotMean,
  type AuditEntry,
  type WorldNode,
  type WorldTreeData,
} from "./engine";
import {
  WorldFileError,
  exportWorldFile,
  inspectWorldFile,
  parseWorldFile,
  serializeWorldFile,
  type InspectWorldFileReport,
} from "./worldfile";
import styles from "./worldline-panel.module.css";

type Tab = "tree" | "audit" | "file";

export interface WorldlinePanelProps {
  /** 受控的树数据；外部用 WorldTree.fromData 恢复。 */
  data: WorldTreeData;
  onChange: (next: WorldTreeData) => void;
  worldName: string;
  /** 当前所处的世界线节点 id。 */
  currentId: string;
  onCurrentChange: (id: string) => void;
  /** 把某条世界线的状态推给上层（例如让 VN 跳转）。 */
  onPlay?: (node: WorldNode) => void;
}

const KIND_LABEL: Record<WorldNode["kind"], string> = {
  root: "原点",
  observe: "观测",
  set: "设定",
  branch: "分支",
  merge: "合并",
  rollback: "回滚",
};

const ACTION_LABEL: Record<AuditEntry["action"], string> = {
  init: "init",
  observe: "observe",
  set: "set",
  branch: "branch",
  merge: "merge",
  rollback: "rollback",
  forget: "forget",
  import: "import",
};

function fmtTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 按父链顺序把节点拍平成带缩进的列表。 */
function flatten(nodes: WorldNode[], rootId: string): { node: WorldNode; depth: number }[] {
  const byParent = new Map<string | null, WorldNode[]>();
  for (const node of nodes) {
    const key = node.parentId;
    const bucket = byParent.get(key) ?? [];
    bucket.push(node);
    byParent.set(key, bucket);
  }
  for (const bucket of byParent.values()) bucket.sort((a, b) => a.seq - b.seq);

  const out: { node: WorldNode; depth: number }[] = [];
  const walk = (id: string, depth: number, guard: Set<string>) => {
    const node = nodes.find((n) => n.id === id);
    if (!node || guard.has(id)) return;
    guard.add(id);
    out.push({ node, depth });
    for (const child of byParent.get(id) ?? []) walk(child.id, depth + 1, guard);
  };
  walk(rootId, 0, new Set());
  return out;
}

export function WorldlinePanel({
  data,
  onChange,
  worldName,
  currentId,
  onCurrentChange,
  onPlay,
}: WorldlinePanelProps) {
  const [tab, setTab] = useState<Tab>("tree");
  const [selectedId, setSelectedId] = useState(currentId);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; title: string; body: string } | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [branchName, setBranchName] = useState("");
  const [obsKey, setObsKey] = useState("焦虑");
  const [obsValue, setObsValue] = useState("6");
  const [importText, setImportText] = useState("");
  const [report, setReport] = useState<InspectWorldFileReport | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const tree = useMemo(() => WorldTree.fromData(data), [data]);
  const rows = useMemo(() => flatten(tree.nodes, tree.root.id), [tree]);  const selected = tree.node(selectedId) ?? tree.node(currentId) ?? tree.root;
  const current = tree.node(currentId) ?? tree.root;
  const summary = useMemo(() => inspectTree(data), [data]);

  const apply = useCallback(
    (node: WorldNode | undefined) => {
      if (!node) return;
      onChange(tree.toData());
      setSelectedId(node.id);
      onCurrentChange(node.id);
    },
    [onChange, onCurrentChange, tree],
  );

  const handleObserve = () => {
    const value = Number(obsValue);
    if (!Number.isFinite(value)) {
      setNotice({ tone: "error", title: "数值不合法", body: "观测值必须是数字。" });
      return;
    }
    const node = tree.observe(
      current.id,
      { uid: `m-${obsKey}-${Date.now().toString(36)}`, key: obsKey, value },
      `观测 ${obsKey} = ${value}`,
    );
    apply(node);
    setNotice({ tone: "ok", title: "已记下观测", body: `新节点「${node.label}」已追加到当前世界线。` });
  };

  const handleBranch = () => {
    const label = branchName.trim() || `世界线 ${tree.children(current.id).length + 1}`;
    const node = tree.branch(current.id, label);
    apply(node);
    setBranchName("");
    setNotice({ tone: "ok", title: "已开新世界线", body: `「${label}」从「${current.label}」分出。` });
  };

  const handleMerge = () => {
    if (!mergeTarget) {
      setNotice({ tone: "error", title: "还没选目标", body: "先选一条要合并进来的世界线。" });
      return;
    }
    try {
      const node = tree.merge(current.id, mergeTarget);
      if (node.id === current.id) {
        setNotice({
          tone: "info",
          title: "已经合并过了",
          body: "这条世界线已被当前节点吸收，重复合并不会让统计量翻倍。",
        });
        return;
      }
      apply(node);
      setNotice({
        tone: "ok",
        title: "合并完成",
        body: `base 取最近公共祖先「${tree.lca(current.id, mergeTarget)?.label ?? "?"}」，统计量精确相加。`,
      });
    } catch (error) {
      if (error instanceof MergeError) {
        setNotice({
          tone: "error",
          title: `合并被拒绝（${error.conflict.reason}）`,
          body: error.conflict.message,
        });
        return;
      }
      setNotice({
        tone: "error",
        title: "合并失败",
        body: error instanceof Error ? error.message : "未知错误",
      });
    }
  };

  const handleRollback = () => {
    if (!selected) return;
    const node = tree.rollback(current.id, selected.id);
    apply(node);
    setNotice({
      tone: "ok",
      title: "已回滚",
      body: `回到「${selected.label}」的状态，历史节点没有删除，只追加了一条回滚记录。`,
    });
  };

  const handleExport = () => {
    try {
      const file = exportWorldFile(data, { name: worldName, author: "Mirai" });
      const text = serializeWorldFile(file);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${worldName}.world.json`;
      link.click();
      URL.revokeObjectURL(url);
      setReport(inspectWorldFile(file));
      setNotice({
        tone: "ok",
        title: "已导出世界文件",
        body: `checksum ${file.checksum}，${Object.keys(file.tree.nodes).length} 个节点。`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        title: "导出被拒绝",
        body: error instanceof WorldFileError ? error.message : "世界数据不一致",
      });
    }
  };

  const handleInspect = () => {
    try {
      const file = exportWorldFile(data, { name: worldName, author: "Mirai" });
      setReport(inspectWorldFile(file));
    } catch (error) {
      setNotice({
        tone: "error",
        title: "校验失败",
        body: error instanceof Error ? error.message : "未知错误",
      });
    }
  };

  const handleImport = (raw: string) => {
    try {
      const file = parseWorldFile(raw);
      onChange(file.tree);
      setSelectedId(file.tree.rootId);
      onCurrentChange(file.tree.rootId);
      setReport(inspectWorldFile(file));
      setNotice({
        tone: "ok",
        title: "世界文件已载入",
        body: inspectWorldFile(file).message,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        title: "载入失败",
        body: error instanceof WorldFileError ? error.message : "不是合法的世界文件",
      });
    }
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setImportText(text.slice(0, 4000));
    handleImport(text);
  };

  const candidates = tree.nodes.filter((node) => node.id !== current.id && node.id !== selected.id);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h3>世界线</h3>
          <p>
            每次观测、设定、分支、合并、回滚都是一个节点。合并在最近公共祖先上做三路减法，
            所以重复合并不会让统计量翻倍；标量冲突会直接拒绝，不会静默择一。
          </p>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={handleInspect} data-wl-action="inspect">
            <FileJson size={15} strokeWidth={1.75} aria-hidden />
            校验
          </Button>
          <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()} data-wl-action="import">
            <Upload size={15} strokeWidth={1.75} aria-hidden />
            导入
          </Button>
          <Button variant="primary" size="sm" onClick={handleExport} data-wl-action="export">
            <Download size={15} strokeWidth={1.75} aria-hidden />
            导出世界
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              void onPickFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      </div>

      {notice && (
        <div className={styles.notice} data-tone={notice.tone} role="status">
          {notice.tone === "ok" ? (
            <CheckCircle2 size={16} strokeWidth={1.9} aria-hidden />
          ) : (
            <AlertTriangle size={16} strokeWidth={1.9} aria-hidden />
          )}
          <div>
            <div className={styles.noticeTitle}>{notice.title}</div>
            <div>{notice.body}</div>
          </div>
        </div>
      )}

      <div className={styles.body}>
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span>世界线树</span>
            <Badge tone="neutral" size="sm">
              {summary.nodeCount} 节点 · {summary.branches} 分支 · {summary.merges} 合并
            </Badge>
          </div>
          <div className={styles.cardBody}>
            <div className={styles.tree} role="tree" aria-label="世界线">
              {rows.map(({ node, depth }) => (
                <button
                  key={node.id}
                  type="button"
                  role="treeitem"
                  aria-selected={node.id === selectedId}
                  className={styles.row}
                  data-selected={node.id === selectedId}
                  data-current={node.id === currentId}
                  style={{ paddingLeft: 9 + depth * 16 }}
                  onClick={() => setSelectedId(node.id)}
                  title={`${KIND_LABEL[node.kind]} · ${node.stateHash}`}
                >
                  <span className={styles.dot} data-kind={node.kind} aria-hidden />
                  <span className={styles.label}>{node.label}</span>
                  <span className={styles.meta}>{KIND_LABEL[node.kind]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.tabs} role="tablist">
            <button
              type="button"
              role="tab"
              data-wl-tab="detail"
              className={styles.tab}
              data-active={tab === "tree"}
              aria-selected={tab === "tree"}
              onClick={() => setTab("tree")}
            >
              详情与操作
            </button>
            <button
              type="button"
              role="tab"
              data-wl-tab="audit"
              className={styles.tab}
              data-active={tab === "audit"}
              aria-selected={tab === "audit"}
              onClick={() => setTab("audit")}
            >
              审计 ({tree.audit.length})
            </button>
            <button
              type="button"
              role="tab"
              data-wl-tab="file"
              className={styles.tab}
              data-active={tab === "file"}
              aria-selected={tab === "file"}
              onClick={() => setTab("file")}
            >
              世界文件
            </button>
          </div>

          <div className={styles.cardBody}>
            {tab === "tree" && (
              <>
                <dl className={styles.kv}>
                  <dt>当前线</dt>
                  <dd>{current.label}</dd>
                  <dt>选中</dt>
                  <dd>{selected.label}</dd>
                  <dt>状态哈希</dt>
                  <dd>{selected.stateHash}</dd>
                  <dt>记忆槽</dt>
                  <dd>
                    {Object.values(selected.state.numeric).length} 个数值 ·{" "}
                    {Object.values(selected.state.scalars).length} 个标量 ·{" "}
                    {Object.keys(selected.state.tombstones).length} 个墓碑
                  </dd>
                  {Object.values(selected.state.numeric).slice(0, 3).map((slot) => (
                    <div key={slot.uid} style={{ display: "contents" }}>
                      <dt>{slot.key}</dt>
                      <dd>
                        均值 {slotMean(slot).toFixed(2)} · count {slot.count}
                      </dd>
                    </div>
                  ))}
                </dl>

                <div className={styles.inlineRow} style={{ marginBottom: 12 }}>
                  <Button variant="secondary" size="sm" onClick={handleRollback} data-wl-action="rollback">
                    <RotateCcw size={15} strokeWidth={1.75} aria-hidden />
                    回滚到选中
                  </Button>
                  {onPlay && (
                    <Button variant="ghost" size="sm" onClick={() => onPlay(selected)}>
                      在 Stage 里打开
                    </Button>
                  )}
                </div>

                <div className={styles.field}>
                  <label htmlFor="wl-obs-key">记一次观测</label>
                  <div className={styles.inlineRow}>
                    <Input
                      id="wl-obs-key"
                      label="槽名"
                      value={obsKey}
                      onChange={(event) => setObsKey(event.target.value)}
                      placeholder="例如 焦虑"
                      style={{ maxWidth: 180 }}
                    />
                    <Input
                      label="数值"
                      value={obsValue}
                      onChange={(event) => setObsValue(event.target.value)}
                      inputMode="decimal"
                      placeholder="例如 6"
                      style={{ maxWidth: 100 }}
                    />
                    <Button variant="secondary" size="sm" onClick={handleObserve} data-wl-action="observe">
                      <History size={15} strokeWidth={1.75} aria-hidden />
                      记下
                    </Button>
                  </div>
                </div>

                <div className={styles.field}>
                  <label htmlFor="wl-branch">开一条新世界线</label>
                  <div className={styles.inlineRow}>
                    <Input
                      id="wl-branch"
                      label="世界线名称"
                      value={branchName}
                      onChange={(event) => setBranchName(event.target.value)}
                      placeholder="例如：上海线"
                      style={{ maxWidth: 220 }}
                    />
                    <Button variant="secondary" size="sm" onClick={handleBranch} data-wl-action="branch">
                      <GitBranch size={15} strokeWidth={1.75} aria-hidden />
                      分叉
                    </Button>
                  </div>
                </div>

                <div className={styles.field}>
                  <label htmlFor="wl-merge">合并一条世界线进来</label>
                  <div className={styles.inlineRow}>
                    <select
                      id="wl-merge"
                      className={styles.textarea}
                      style={{ minHeight: 38, maxWidth: 260, padding: "8px 10px" }}
                      value={mergeTarget}
                      onChange={(event) => setMergeTarget(event.target.value)}
                    >
                      <option value="">选择世界线…</option>
                      {candidates.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.label}（{KIND_LABEL[node.kind]}）
                        </option>
                      ))}
                    </select>
                    <Button variant="secondary" size="sm" onClick={handleMerge} data-wl-action="merge">
                      <GitMerge size={15} strokeWidth={1.75} aria-hidden />
                      三路合并
                    </Button>
                  </div>
                  <span className={styles.hint}>
                    base 自动取两条线的最近公共祖先。同一枝重复合并不翻倍。
                  </span>
                </div>
              </>
            )}

            {tab === "audit" && (
              <div className={styles.audit}>
                {tree.audit.length === 0 && <div className={styles.empty}>还没有操作。</div>}
                {[...tree.audit].reverse().map((entry) => (
                  <div key={entry.seq} className={styles.auditRow}>
                    <span className={styles.auditSeq}>{entry.seq}</span>
                    <span className={styles.auditAction}>{ACTION_LABEL[entry.action]}</span>
                    <span className={styles.auditDetail}>
                      {entry.detail}
                      <span className={styles.meta}> · {fmtTime(entry.at)} · {entry.stateHash}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {tab === "file" && (
              <>
                {report ? (
                  <div
                    className={styles.notice}
                    data-tone={report.fileOk ? "ok" : "error"}
                    style={{ marginBottom: 12 }}
                  >
                    {report.fileOk ? (
                      <CheckCircle2 size={16} strokeWidth={1.9} aria-hidden />
                    ) : (
                      <AlertTriangle size={16} strokeWidth={1.9} aria-hidden />
                    )}
                    <div>
                      <div className={styles.noticeTitle}>
                        {report.fileOk ? "世界完整" : "世界有问题"}
                      </div>
                      <div>{report.message}</div>
                    </div>
                  </div>
                ) : (
                  <div className={styles.empty}>
                    点「校验」看这棵树能不能被安全导出，或直接「导出世界」。
                  </div>
                )}

                <dl className={styles.kv}>
                  <dt>节点</dt>
                  <dd>{summary.nodeCount}</dd>
                  <dt>世界线</dt>
                  <dd>{report ? report.leafCount : "—"}</dd>
                  <dt>分支/合并</dt>
                  <dd>
                    {summary.branches} / {summary.merges}
                  </dd>
                  <dt>回滚</dt>
                  <dd>{summary.rollbacks}</dd>
                  <dt>墓碑</dt>
                  <dd>{summary.tombstones}</dd>
                  <dt>审计条数</dt>
                  <dd>{summary.auditCount}</dd>
                </dl>

                <div className={styles.field}>
                  <label htmlFor="wl-import">粘贴世界文件内容</label>
                  <textarea
                    id="wl-import"
                    className={styles.textarea}
                    value={importText}
                    onChange={(event) => setImportText(event.target.value)}
                    placeholder='{"magic":"mirai-selene/world", ...}'
                    spellCheck={false}
                  />
                  <div className={styles.inlineRow}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleImport(importText)}
                      data-wl-action="load"
                      disabled={!importText.trim()}
                    >
                      <Upload size={15} strokeWidth={1.75} aria-hidden />
                      载入
                    </Button>
                  </div>
                </div>

                <div className={styles.field}>
                  <label>当前树（只读）</label>
                  <pre className={styles.code}>{JSON.stringify(summary, null, 2)}</pre>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
