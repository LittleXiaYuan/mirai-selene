import { useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Download,
  GitMerge,
  Play,
  RotateCcw,
  Sparkles,
  Store,
  X,
} from "lucide-react";
import type { WorldSpec } from "@/world/spec";
import { SPEC_SAMPLES } from "@/world/spec-samples";
import styles from "./demo-mode.module.css";

export type DemoStep = 1 | 2 | 3 | 4;

interface DemoScenario {
  id: string;
  tag: string;
  title: string;
  desc: string;
  cover: string;
  kind: "ingest" | "spec";
  specId?: string;
}

const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "viral-ingest",
    tag: "完整链路 · 强烈推荐",
    title: "现实热帖拆解 → 5 阵营推演",
    desc: "一键吞噬真实热帖，实时拆出 5 股势力与隐性动机，再直接走进视觉小说舞台。",
    cover: "/mirai/cover-whistleblow.webp",
    kind: "ingest",
  },
  {
    id: "dd-48h",
    tag: "高压商业谈判",
    title: "尽调前 48 小时 · 密钥逼宫",
    desc: "直进沉浸舞台：面对技术合伙人施压，按住麦克风说出真心或违心话，测 PAI-SSM 反应。",
    cover: "/mirai/cover-dd48h.webp",
    kind: "spec",
    specId: "dd-before-48h",
  },
  {
    id: "last-call",
    tag: "虹桥演示专场",
    title: "最后一通电话 · 期限博弈",
    desc: "雨夜陆家嘴 × 清晨海岸线，1 分钟体验沉浸推演、秒级分叉与三路无损合流。",
    cover: "/mirai/cover-wednesday.webp",
    kind: "spec",
    specId: "last-call-demo",
  },
];

export function DemoLauncherModal({
  onStartIngest,
  onStartSpec,
  onClose,
}: {
  onStartIngest: () => void;
  onStartSpec: (spec: WorldSpec) => void;
  onClose: () => void;
}) {
  const handlePick = (item: DemoScenario) => {
    if (item.kind === "ingest") {
      onStartIngest();
      return;
    }
    const found = SPEC_SAMPLES.find((s) => s.id === item.specId) ?? SPEC_SAMPLES[0];
    if (found) onStartSpec(found);
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="一键体验演示模式">
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <div>
            <span className={styles.eyebrow}>
              <Sparkles size={13} strokeWidth={2} aria-hidden />
              演示模式 · 1 分钟走完全链路
            </span>
            <h2 className={styles.modalTitle}>选一个引子，一键生成并走进平行世界</h2>
            <p className={styles.modalSub}>
              省去所有配置步骤：选完即自动串联「造世界 → 舞台听声辨心 → 分叉与三路合流 → 带走 .world 资产」。
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="退出演示模式">
            <X size={16} />
          </button>
        </div>

        <div className={styles.flowStrip} aria-hidden>
          <div className={styles.flowItem}>
            <span className={styles.flowNum}>1</span>
            <span>热帖 / 引子一键造世界</span>
          </div>
          <div className={styles.flowItem}>
            <span className={styles.flowNum}>2</span>
            <span>沉浸舞台 · 真麦听声辨心</span>
          </div>
          <div className={styles.flowItem}>
            <span className={styles.flowNum}>3</span>
            <span>平行分叉 · 三路无损合流</span>
          </div>
          <div className={styles.flowItem}>
            <span className={styles.flowNum}>4</span>
            <span>导出 .world · 逛自由市场</span>
          </div>
        </div>

        <div className={styles.cards}>
          {DEMO_SCENARIOS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.card}
              onClick={() => handlePick(item)}
            >
              <div className={styles.cardCoverWrap}>
                <img className={styles.cardCover} src={item.cover} alt={item.title} />
                <span className={styles.cardTag}>{item.tag}</span>
              </div>
              <div className={styles.cardBody}>
                <div className={styles.cardTitle}>{item.title}</div>
                <div className={styles.cardDesc}>{item.desc}</div>
                <span className={styles.cardCta}>
                  <Play size={13} fill="currentColor" aria-hidden />
                  一键开演
                  <ArrowRight size={13} aria-hidden />
                </span>
              </div>
            </button>
          ))}
        </div>

        <div className={styles.modalFooter}>
          <span>提示：进入舞台后支持真实麦克风「按住开口」；若会场较吵，系统会自动红字提醒。</span>
          <button
            type="button"
            className={styles.stepChip}
            onClick={onClose}
            style={{ color: "#c7d2fe" }}
          >
            退出演示模式，自由操作
          </button>
        </div>
      </div>
    </div>
  );
}

export function DemoGuideBar({
  step,
  busy,
  onOpenLauncher,
  onJumpStage,
  onBranchAndMerge,
  onExportAndMarket,
  onReset,
  onExit,
}: {
  step: DemoStep;
  busy?: boolean;
  onOpenLauncher: () => void;
  onJumpStage: () => void;
  onBranchAndMerge: () => void;
  onExportAndMarket: () => void;
  onReset: () => void;
  onExit: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className={styles.guideWrap}>
        <button
          type="button"
          className={styles.collapsedPill}
          onClick={() => setCollapsed(false)}
        >
          <Sparkles size={13} aria-hidden />
          演示模式 · 第 {step}/4 步
          <ChevronDown size={14} aria-hidden />
        </button>
      </div>
    );
  }

  const hint =
    step === 1
      ? "正在拆解热帖 5 阵营：可点下方「走进世界」，或直接进舞台"
      : step === 2
        ? "点选项或按住「按住开口」真实说话（环境吵会红字提醒）"
        : step === 3
          ? "已完成双线分叉与三路无损合流，可对比两条平行世界线"
          : "体验闭环达成！可下载 .world 文件或切换下一位评委体验";

  return (
    <div className={styles.guideWrap} role="region" aria-label="演示模式引导条">
      <div className={styles.guideBar}>
        <div className={styles.guideSteps}>
          <button
            type="button"
            className={styles.stepChip}
            data-active={step === 1}
            data-done={step > 1}
            onClick={onOpenLauncher}
          >
            1 造世界
          </button>
          <button
            type="button"
            className={styles.stepChip}
            data-active={step === 2}
            data-done={step > 2}
            onClick={onJumpStage}
          >
            2 舞台听声
          </button>
          <button
            type="button"
            className={styles.stepChip}
            data-active={step === 3}
            data-done={step > 3}
            onClick={onBranchAndMerge}
          >
            3 分叉合流
          </button>
          <button
            type="button"
            className={styles.stepChip}
            data-active={step === 4}
            onClick={onExportAndMarket}
          >
            4 .world 市场
          </button>
        </div>

        <span className={styles.guideHint}>{hint}</span>

        {step === 1 && (
          <button type="button" className={styles.primaryAction} onClick={onJumpStage}>
            直接走进舞台
            <ArrowRight size={14} aria-hidden />
          </button>
        )}
        {step === 2 && (
          <button
            type="button"
            className={styles.primaryAction}
            disabled={busy}
            onClick={onBranchAndMerge}
          >
            <GitMerge size={14} aria-hidden />
            {busy ? "正在分叉并合流..." : "一键分叉 → 无损合流"}
          </button>
        )}
        {step === 3 && (
          <button type="button" className={styles.primaryAction} onClick={onExportAndMarket}>
            <Download size={14} aria-hidden />
            导出 .world 并逛市场
          </button>
        )}
        {step === 4 && (
          <button type="button" className={styles.primaryAction} onClick={onReset}>
            <RotateCcw size={14} aria-hidden />
            下一位体验
          </button>
        )}

        <button
          type="button"
          className={styles.iconBtn}
          onClick={onOpenLauncher}
          title="切换体验剧本"
          aria-label="切换体验剧本"
        >
          <Store size={13} aria-hidden />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setCollapsed(true)}
          title="收起导览条"
          aria-label="收起导览条"
        >
          <ChevronUp size={14} aria-hidden />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onExit}
          title="退出演示模式"
          aria-label="退出演示模式"
        >
          <X size={13} aria-hidden />
        </button>
      </div>
    </div>
  );
}
