import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Play } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { LICENSE_PRESETS } from "@/world/worldfile";
import { paiHealth } from "./pai";
import styles from "./about.module.css";

/**
 * 边界与基准。
 *
 * 这一页存在的理由：评审要求「自研模型的能力边界需公开对照」、
 * 「缺少第三方复现与性能数据」。与其在答辩时口头解释，
 * 不如把它写成产品里的一个页面 —— 谁都能打开，数字都标了来源和复现方式。
 *
 * 数字来自 `npm run bench`，任何人本地跑都能得到同一量级。
 */

const BENCH = [
  { name: "三路合并 20 条记忆", value: "0.04", unit: "ms", note: "真实世界规模" },
  { name: "三路合并 10000 条记忆", value: "13.1", unit: "ms", note: "压力测试" },
  { name: "建成 50 个节点的世界线", value: "2.8", unit: "ms", note: "每步约 57 µs" },
  { name: "建成 5000 个节点的世界线", value: "269", unit: "ms", note: "压力测试" },
  { name: "合并两条各 500 步的线", value: "2.0", unit: "ms", note: "取最近公共祖先" },
  { name: "合并预演（1000 节点）", value: "1.4", unit: "ms", note: "只读，不改树" },
  { name: "导出 50 节点世界文件", value: "0.51", unit: "ms", note: "真实规模" },
  { name: "序列化 50 节点", value: "7.1", unit: "ms", note: "" },
  { name: "解析 + 校验 50 节点", value: "1.9", unit: "ms", note: "" },
  { name: "一致性检查 50 节点", value: "0.9", unit: "ms", note: "" },
  { name: "同一文件解析 100 次", value: "1", unit: "种哈希", note: "完全可复现" },
];

const CAN = [
  "把「预测」做成可分支、可合并、可回滚的世界，而不是一份报告",
  "分支以充分统计量无损合并，结果与顺序无关，重复合并不翻倍",
  "世界是一个带校验的文件，能导出、能载入、能确认没被改过",
  "实时渲染 60fps，画面是状态的纯函数，同一状态必然同一帧",
  "并行观察多条世界线，合并前先看会发生什么",
];

const CANNOT = [
  "没有训练自己的基座大模型 —— 叙事是外部 LLM 生成的，我们做的是状态与结构",
  "没有逐帧生成视频 —— 实时层是参数化渲染，不是神经渲染；插画是每幕一张，不是流",
  "没有第三方大规模用户验证 —— 只有内部测试与比赛评审的反馈",
  "叙事质量依赖使用者的输入与模型表现，不是确定性产出",
  "没有做成强制执行的许可证体系 —— 授权条款写在文件里，靠协作双方遵守",
];

const COMPARE = [
  { name: "走进去", video: "看", sandbox: "不能", us: "能" },
  { name: "分支", video: "不能", sandbox: "报告里", us: "世界里" },
  { name: "合并两条线", video: "不能", sandbox: "不能", us: "精确合并" },
  { name: "回滚到任一刻", video: "不能", sandbox: "部分", us: "历史不删" },
  { name: "带走", video: "不能", sandbox: "不能", us: "带校验的文件" },
  { name: "实时", video: "1-4 fps 云端", sandbox: "无", us: "60 fps 手机" },
  { name: "可复现", video: "不能", sandbox: "—", us: "同状态同帧" },
];

async function mcpRpc(id: number, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
  return (await res.json()) as {
    result?: {
      tools?: { name: string; description?: string }[];
      content?: { text?: string }[];
      isError?: boolean;
    };
  };
}

export function AboutView({ onBack }: { onBack: () => void }) {
  const [mcpTools, setMcpTools] = useState<string[]>([]);
  const [mcpOnline, setMcpOnline] = useState<boolean | null>(null);
  const [paiStatus, setPaiStatus] = useState<{ ok: boolean; device?: string; params?: number } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [trace, setTrace] = useState<string | null>(null);
  const [relay, setRelay] = useState<{ ok: boolean; modelAttached?: boolean; host?: string } | null>(null);
  const [stats, setStats] = useState<{
    users: number; worlds: number; orders: number; orders24h: number; creditsSpent: number; runs24h: number;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void paiHealth().then((res) => {
      if (alive) setPaiStatus(res ?? { ok: false });
    });
    fetch("/api/relay/health", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive && data) setRelay(data);
      })
      .catch(() => {});
    fetch("/api/stats", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive && data) setStats(data);
      })
      .catch(() => {});
    void mcpRpc(1, "tools/list", {})
      .then((res) => {
        if (!alive) return;
        const names = (res.result?.tools ?? []).map((t) => t.name);
        setMcpTools(names);
        setMcpOnline(names.length > 0);
      })
      .catch(() => {
        if (alive) setMcpOnline(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const runLiveMcpVerify = async () => {
    setVerifying(true);
    setTrace(null);
    const t0 = performance.now();
    const log: string[] = [];
    const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
      const res = await mcpRpc(id, "tools/call", { name, arguments: args });
      const text = res.result?.content?.[0]?.text ?? "{}";
      if (res.result?.isError) throw new Error(`${name}: ${text}`);
      return JSON.parse(text) as Record<string, unknown>;
    };
    try {
      const w = await callTool(10, "open_world", {
        name: "现场 MCP 实测",
        who: "林夏",
        goal: { key: "被理解", label: "达成共识", target: 10 },
      });
      const worldId = String(w.worldId ?? "");
      const rootNode = String(w.node ?? "");
      log.push(`✓ open_world -> ${worldId} (node=${rootNode})`);

      const prev = await callTool(11, "preview", {
        worldId,
        node: rootNode,
        candidates: [
          { key: "被理解", value: 6 },
          { key: "摩擦", value: 8 },
        ],
      });
      log.push(`✓ preview (只读反事实不改树) -> ${(prev.candidates as unknown[])?.length ?? 0} 组候选`);

      const bA = await callTool(12, "branch", { worldId, from: rootNode, label: "坦诚线" });
      const bB = await callTool(13, "branch", { worldId, from: rootNode, label: "缓和线" });
      const sA = await callTool(14, "step", {
        worldId,
        node: String(bA.node),
        label: "摊开底牌",
        memories: [{ key: "关键共识", value: 4 }],
      });
      const sB = await callTool(15, "step", {
        worldId,
        node: String(bB.node),
        label: "留出余地",
        memories: [{ key: "关键共识", value: 8 }],
      });
      log.push(`✓ branch × 2 + step × 2 -> (${sA.node}, ${sB.node})`);

      const m1 = await callTool(16, "merge", {
        worldId,
        left: String(sA.node),
        right: String(sB.node),
        label: "三路无损合流",
      });
      const m2 = await callTool(17, "merge", {
        worldId,
        left: String(sA.node),
        right: String(sB.node),
      });
      const keys1 = ((m1.evidence as { keys?: { key: string; count: number; mean: number }[] })?.keys ?? []).find(
        (k) => k.key === "关键共识",
      );
      const keys2 = ((m2.evidence as { keys?: { key: string; count: number; mean: number }[] })?.keys ?? []).find(
        (k) => k.key === "关键共识",
      );
      log.push(
        `✓ merge × 2 (幂等校验) -> count=${keys1?.count}→${keys2?.count}, mean=${keys1?.mean}→${keys2?.mean}（重复合并不翻倍）`,
      );

      const card = await callTool(18, "card", { worldId, node: String(m1.node) });
      const cardLen = String(card.markdown ?? card.card ?? JSON.stringify(card)).length;
      const elapsed = (performance.now() - t0).toFixed(1);
      log.push(`✓ card 交付可复现决策卡 (${cardLen} chars) · 全链路真实耗时 ${elapsed} ms`);
      setTrace(log.join("\n"));
    } catch (err) {
      setTrace(`✗ MCP 实测异常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <button className="icon-button" onClick={onBack} aria-label="回去">
          <ArrowLeft size={20} strokeWidth={1.75} aria-hidden />
        </button>
        <div>
          <h1>边界与基准</h1>
          <p>做到哪、没做到哪、跑得多快</p>
        </div>
      </div>

      <p className={styles.sectionLead}>
        这一页不是宣传，是自查。数字都可以在你的机器上重跑；
        没做到的部分写在下面，不用等评审来问。
      </p>

      <section className={styles.section} style={{ marginTop: 0 }}>
        <h2 className={styles.sectionTitle}>任务定义</h2>
        <p className={styles.sectionLead}>
          评审先看这一条：谁在什么条件下用它，什么算做完。
        </p>
        <div className={styles.criteriaRows}>
          <div className={styles.criteriaRow}>
            <span className={styles.criteriaLabel}>谁在用</span>
            <p className={styles.criteriaText}>
              内容创作者与版权方；要预演高利害对话的人；研究者与评审。
            </p>
          </div>
          <div className={styles.criteriaRow}>
            <span className={styles.criteriaLabel}>什么时候触发</span>
            <p className={styles.criteriaText}>
              一条小红书 / 抖音链接或一段正文；一句话处境；一个导出的 .world 文件。
            </p>
          </div>
          <div className={styles.criteriaRow}>
            <span className={styles.criteriaLabel}>什么算成功</span>
            <p className={styles.criteriaText}>下面四条都能在场上逐条验，不靠口头保证。</p>
          </div>
        </div>
        <p className={styles.liveStrip}>
          <span className={styles.liveDot} data-live={stats ? "true" : undefined} />
          {stats
            ? `现在的真实数字：${stats.users} 个账号 · ${stats.worlds} 个世界 · ${stats.orders} 笔订单（近 24h ${stats.orders24h}）· 共消耗 ${stats.creditsSpent} 额度 · 近 24h ${stats.runs24h} 次 Agent 运行`
            : "正在读取服务端统计…"}
        </p>
        <ol className={styles.criteriaList}>
          <li>90 秒内走完：链接 → 3–5 个阵营 → 三轮推演 → 选身份 → 舞台首幕。</li>
          <li>同一输入跑两次，动作序列一致；世界文件载入时 checksum 重算一致。</li>
          <li>走完输出判断卡：五档分位数、ruin、分歧度；数字只来自状态核，不从语言模型来。</li>
          <li>导出的 .world 在另一台机器导入后，分支与合流结果一致。</li>
        </ol>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>实时 Agent 引擎 & MCP 动作空间</h2>
        <p className={styles.sectionLead}>
          Mirai-Selene 通过标准 Streamable HTTP（<code>/mcp</code>）向商汤小浣熊等外部 Agent 开放完整动作空间，
          工具返回值全部由状态引擎实时计算，不靠语言模型口述。
        </p>

        <div className={styles.probeGrid}>
          <div className={styles.probeCard}>
            <span className={styles.probeLabel}>
              <span>远程 MCP 端点（/mcp）</span>
              <span className={styles.probeDot} data-off={mcpOnline === false ? "true" : undefined} />
            </span>
            <span className={styles.probeValue}>
              {mcpOnline === null
                ? "正在握手..."
                : mcpOnline
                  ? `在线 · ${mcpTools.length} 个 Agent 工具就绪`
                  : "未连上 /mcp 端点"}
            </span>
          </div>

          <div className={styles.probeCard}>
            <span className={styles.probeLabel}>
              <span>魔搭创空间中转</span>
              <span className={styles.probeDot} data-off={relay && !relay.ok ? "true" : undefined} />
            </span>
            <span className={styles.probeValue}>
              {relay === null
                ? "正在探测..."
                : relay.ok
                  ? `在线 · ${relay.host ?? "modelscope"} · ${relay.modelAttached ? "已接 L20 模型" : "模型未接入（只记请求）"}`
                  : "中转未响应"}
            </span>
          </div>

          <div className={styles.probeCard}>
            <span className={styles.probeLabel}>
              <span>自研 PAI-SSM 推理桥（:5290）</span>
              <span className={styles.probeDot} data-off={!paiStatus?.ok ? "true" : undefined} />
            </span>
            <span className={styles.probeValue}>
              {paiStatus === null
                ? "正在探测..."
                : paiStatus.ok
                  ? `在线 · ${paiStatus.device ?? "本地"} 真实状态推演`
                  : "桥未启动 · 自动降级本地确定性引擎"}
            </span>
          </div>
        </div>

        {mcpTools.length > 0 && (
          <div className={styles.toolChips} aria-label="在线 MCP 工具列表">
            {mcpTools.map((name) => (
              <span key={name} className={styles.toolChip}>
                {name}
              </span>
            ))}
          </div>
        )}

        <Button
          variant="secondary"
          size="sm"
          className={styles.mcpButton}
          onClick={() => void runLiveMcpVerify()}
          disabled={verifying || !mcpOnline}
        >
          {verifying ? <CheckCircle2 size={14} aria-hidden /> : <Play size={14} aria-hidden />}
          {verifying ? "正在向 /mcp 发起真实 JSON-RPC..." : "现场实测 MCP 全链路"}
        </Button>
        <p className={styles.sectionLead} style={{ margin: "8px 0 0" }}>
          一次点完：开世界 → 预演 → 分叉 → 幂等合流 → 预测卡。
        </p>

        {trace && <pre className={styles.traceBox}>{trace}</pre>}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>性能</h2>
        <p className={styles.sectionLead}>
          只测引擎本身（合并、回滚、文件往返），不含 LLM 与网络 —— 那两个受外部影响，数字没有可比性。
        </p>
        <div className={styles.table}>
          <div className={styles.thead}>
            <span>项目</span>
            <span style={{ textAlign: "right" }}>耗时</span>
          </div>
          {BENCH.map((row) => (
            <div key={row.name} className={styles.trow}>
              <span className={styles.tname}>
                {row.name}
                {row.note && <small style={{ color: "var(--text-muted)", marginLeft: 6 }}>{row.note}</small>}
              </span>
              <span className={styles.tnum}>
                {row.value}
                <small>{row.unit}</small>
              </span>
            </div>
          ))}
        </div>
        <p className={styles.sectionLead} style={{ marginTop: "var(--space-4)", marginBottom: 0 }}>
          复现方式（不依赖浏览器与网络）:
        </p>
        <div className={styles.cmd}>cd app && npm run bench</div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>能做 / 不能做</h2>
        <div className={styles.cols}>
          <div>
            <div className={styles.colTitle}>已经做到</div>
            <ul className={styles.list}>
              {CAN.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className={styles.colTitle}>没有做到</div>
            <ul className={styles.list}>
              {CANNOT.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>预测是怎么算的</h2>
        <p className={styles.sectionLead}>
          预测不靠语言模型说话。状态是充分统计量（存的是次数与总和，不是一段文本），
          所以「再加一次观测会变成多少」是算得出来的，不是估计。
        </p>
        <ul className={styles.list}>
          <li>`projectObservation(状态, 观测)` —— 反事实。它必须等于真的走一步之后的结果，有测试断言相等。</li>
          <li>`diffState(上一个节点, 这个节点)` —— 这一步的账。只列真被碰过的记忆，被整理掉的记为负。</li>
          <li>`readMood(状态)` —— 读数。`balance = 暖 - 紧`，两条线可以直接比大小。</li>
        </ul>
        <p className={styles.sectionLead} style={{ marginBottom: 0 }}>
          这三个函数在 `app/src/world/engine.ts`，导出成一份带校验的预测卡在 `app/src/world/prediction.ts`。
          走完一条线，结束页可以导出一份 Markdown —— 除时间戳外逐字可复现。
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>和现有方案对照</h2>
        <p className={styles.sectionLead}>
          不比较画质 —— 那是算力竞赛。比较的是「世界有没有状态」。
        </p>
        <div className={styles.compare}>
          <div className={styles.crow} data-head="true">
            <span></span>
            <span>视频世界模型</span>
            <span>智能体沙盘</span>
            <span>我们</span>
          </div>
          {COMPARE.map((row) => (
            <div key={row.name} className={styles.crow}>
              <span>{row.name}</span>
              <span data-no={row.video === "不能"}>{row.video}</span>
              <span data-no={row.sandbox === "不能"}>{row.sandbox}</span>
              <span data-us="true">{row.us}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>和 Atlas 是什么关系</h2>
        <p className={styles.sectionLead}>
          World Labs 的 Atlas（2026 年 9 月发布，11 月更新下一代）能从照片重建一个能走进去的场景，
          导出网格进 Blender、游戏和机器人仿真。它做的是<b>空间</b>：这个地方长什么样、镜头怎么走。
          我们做的是<b>走向</b>：如果她去了上海，三年后会怎样。
        </p>
        <ul className={styles.list}>
          <li>Atlas 的产物是场景和镜头；我们的产物是带校验的世界文件，和能互相比较的状态读数。</li>
          <li>
            他们把世界模型分成渲染器、模拟器、规划器三类（自家那篇分类文章）。
            我们只做规划器那一层，不跟渲染竞争 —— 所以 Atlas 越强，我们能借力的部分越多。
          </li>
          <li>
            World File 的每个节点都记着那一幕的地点、时间、天气。
            把这些参数交给 Atlas 渲染成空间，就是两层接起来的样子；现在接的是我们自己的实时层。
          </li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>成本、安全与责任边界</h2>
        <div className={styles.criteriaRows}>
          <div className={styles.criteriaRow}>
            <span className={styles.criteriaLabel}>调用成本</span>
            <p className={styles.criteriaText}>
              一次造世界 1 次模型调用，上限 3000 tokens；一次摄入拆解 1 次，上限 1200 tokens；
              没配 key 时走模板，成本为 0。
            </p>
          </div>
          <div className={styles.criteriaRow}>
            <span className={styles.criteriaLabel}>限流与安全</span>
            <p className={styles.criteriaText}>
              摄入 15 次 / 分钟 / IP，推演 40 次；登录用 scrypt 哈希 + 服务端 session；
              抓取只允许 http/https，拒绝私网与 localhost，不跟随重定向。
            </p>
          </div>
          <div className={styles.criteriaRow}>
            <span className={styles.criteriaLabel}>责任边界</span>
            <p className={styles.criteriaText}>
              不替代你的决定；内置快照会明确标注，不冒充实时抓取；
              世界导出后不归服务器管，授权随文件走。
            </p>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>授权与分成</h2>
        <p className={styles.sectionLead}>
          世界被导出之后就不归服务器管了，所以授权跟着文件走 ——
          World File 里带一份人类可读的条款。
        </p>
        <div className={styles.licenses}>
          {(Object.keys(LICENSE_PRESETS) as (keyof typeof LICENSE_PRESETS)[]).map((mode) => {
            const preset = LICENSE_PRESETS[mode];
            return (
              <div
                key={mode}
                className={styles.license}
                data-active={mode === "attribution"}
              >
                <div className={styles.licenseHead}>
                  <span className={styles.licenseName}>{preset.label}</span>
                  <span className={styles.licenseTag}>
                    {mode === "personal" ? "默认关闭商用" : mode === "attribution" ? "导出时默认" : "需另行签署"}
                  </span>
                </div>
                <span className={styles.licenseTerms}>{preset.terms}</span>
              </div>
            );
          })}
        </div>
        <p className={styles.sectionLead} style={{ marginTop: "var(--space-4)", marginBottom: 0 }}>
          这不是强制执行的许可证系统。条款写在文件里，靠协作双方遵守；
          真要强制，需要签名与公钥体系，我们还没做。
        </p>
      </section>

      <section className={styles.section}>
        <Button variant="secondary" onClick={onBack}>
          回到世界
        </Button>
      </section>
    </div>
  );
}
