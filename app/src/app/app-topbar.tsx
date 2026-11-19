import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import styles from "./app-topbar.module.css";

/**
 * 子应用共用的顶栏：返回箭头永远在最左、同一个位置。
 * 右边固定留一个身份入口，未登录也能从这里登录，不用先回官网。
 */
export function AppTopBar({
  onBack,
  onHome,
  signedInName,
  onAuth,
  onWorkspace,
  children,
}: {
  onBack: () => void;
  onHome: () => void;
  signedInName?: string;
  onAuth: () => void;
  onWorkspace: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={styles.bar}>
      <button
        type="button"
        className="icon-button"
        onClick={onBack}
        aria-label="返回上一页"
      >
        <ArrowLeft size={20} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        className={styles.wordmark}
        onClick={onHome}
        aria-label="回到首页"
      >
        Mirai<span>·</span>Selene
      </button>
      <span className={styles.spacer} />
      {children}
      {signedInName ? (
        <Button variant="ghost" size="sm" onClick={onWorkspace}>
          {signedInName} · 工作台
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={onAuth}>
          登录 / 注册
        </Button>
      )}
    </div>
  );
}
