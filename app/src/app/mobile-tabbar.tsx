import { useEffect, useState } from "react";
import { Layers, Link2, Sparkles, Store } from "lucide-react";
import styles from "./mobile-tabbar.module.css";

export type MobileTab = "worlds" | "forge" | "market" | "ingest";

const ITEMS = [
  { id: "worlds", label: "世界", icon: Layers },
  { id: "forge", label: "造世界", icon: Sparkles },
  { id: "market", label: "市场", icon: Store },
  { id: "ingest", label: "摄取", icon: Link2 },
] as const;

/** 工作台的侧栏/详情在手机上会变成整屏抽屉（层级低于固定底栏），打开时让位。 */
function useCoveredBySheet() {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    // 抽屉状态由 Arc Shell 直接写在根节点属性上；轮询比跨组件传状态更稳。
    const update = () => {
      const root = document.querySelector<HTMLElement>("[data-variant]");
      setCovered(
        Boolean(root?.hasAttribute("data-panel-sheet") || root?.hasAttribute("data-sheet")),
      );
    };
    update();
    const timer = window.setInterval(update, 400);
    return () => window.clearInterval(timer);
  }, []);
  return covered;
}

/**
 * 手机端底栏。只负责导航，不承载状态；桌面由 CSS 隐藏。
 * 舞台/结局/编辑这些沉浸页不渲染它，避免压住台词层。
 */
export function MobileTabBar({
  active,
  onNavigate,
}: {
  active: MobileTab;
  onNavigate: (tab: MobileTab) => void;
}) {
  const covered = useCoveredBySheet();
  return (
    <nav
      className={styles.bar}
      aria-label="主导航"
      data-covered={covered ? "" : undefined}
    >
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const current = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            className={styles.item}
            aria-current={current ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <Icon size={20} strokeWidth={1.75} aria-hidden />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
