import { useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import type { WorldSpec } from "@/world/spec";
import { SPEC_SAMPLES } from "@/world/spec-samples";
import { previewShell } from "./game-shell";
import { AppTopBar } from "./app-topbar";
import { useWallet } from "./use-wallet";
import styles from "./market.module.css";

const byId = (id: string) => SPEC_SAMPLES.find((spec) => spec.id === id) ?? SPEC_SAMPLES[0];

// 价格与 server/market.mjs 的价目表一一对应；服务端仍会按 id 再核一次价。
const LISTINGS: { spec: WorldSpec; tag: string; tone: BadgeTone; note: string; price: number }[] = [
  { spec: byId("last-call-demo"), tag: "免费", tone: "success", note: "轻量、适合第一次走进来", price: 0 },
  { spec: byId("natural-after-school"), tag: "高张力", tone: "danger", note: "一封信，两个人都没说实话", price: 12 },
  { spec: byId("wednesday-before"), tag: "编辑推荐", tone: "info", note: "医院与 Offer，两难都保留", price: 18 },
  { spec: byId("dd-before-48h"), tag: "死局悬赏", tone: "warning", note: "密钥逼宫，谈崩概率高", price: 24 },
  { spec: byId("whistleblower-eve"), tag: "死局悬赏", tone: "danger", note: "举报前夜，证据与恐惧", price: 28 },
];

function coverOf(spec: WorldSpec): string | null {
  return (
    spec.assets_manifest.cover?.path ??
    spec.assets_manifest.backgrounds[Object.keys(spec.assets_manifest.backgrounds)[0] ?? ""]?.path ??
    null
  );
}

const PLANS = [
  {
    id: "free",
    name: "免费",
    monthly: 0,
    yearly: 0,
    line: "先走进来",
    features: ["3 个世界", "单线存档与回滚", "示例世界 · 导入 .world", "画面指纹校验"],
    action: "直接开始",
  },
  {
    id: "pro",
    name: "Pro",
    monthly: 29,
    yearly: 23,
    line: "把世界当成自己的",
    features: ["无限世界与分支", "2×5 存档画廊 · merge3 合流", "导出带校验的 .world", "语音副语言输入与追问"],
    action: "升级 Pro",
    featured: true,
  },
  {
    id: "studio",
    name: "Studio",
    monthly: 199,
    yearly: 159,
    line: "靠世界赚钱",
    features: ["上架世界并定价", "分叉破局按血缘树分润 70%", "企业高压谈判沙盘席位", "世界授权与审计导出"],
    action: "申请创作者席位",
  },
] as const;

/**
 * 世界市场：把 `.world` 资产当商品，也当入口。
 * 这里先放可导入的精选世界；分叉破局后的分润走世界文件里的血缘树。
 */
export function MarketScreen({
  onHome,
  onBack,
  onForge,
  onEnter,
  onAuth,
  onWorkspace,
  signedInName,
}: {
  onHome: () => void;
  onBack: () => void;
  onForge: () => void;
  onEnter: (spec: WorldSpec) => void;
  onAuth: () => void;
  onWorkspace: () => void;
  signedInName?: string;
}) {
  const wallet = useWallet(Boolean(signedInName));
  const buy = async (listing: (typeof LISTINGS)[number]) => {
    if (!signedInName) {
      onAuth();
      return;
    }
    try {
      await wallet.purchase(listing.spec.id);
      onEnter(listing.spec);
    } catch {
      // 错误已经落在 wallet.error 里，界面会显示
    }
  };

  return (
    <div className={styles.page}>
      <AppTopBar
        onBack={onBack}
        onHome={onHome}
        onAuth={onAuth}
        onWorkspace={onWorkspace}
        signedInName={signedInName}
      />
      <header className={styles.head}>
        <div className={styles.title}>
          <h1>世界市场</h1>
          <p>
            创作者挂出一个世界，玩家分叉破局。导入后世界归你；分支和合流都留在你自己的世界线里。
          </p>
        </div>
        <div className={styles.headActions}>
          {wallet.balance !== null ? (
            <span className={styles.wallet}>余额 {wallet.balance} · 体验额度</span>
          ) : null}
          {wallet.error ? <span className={styles.walletError}>{wallet.error}</span> : null}
          <Button variant="secondary" onClick={onForge}>
            <Sparkles size={16} strokeWidth={1.75} aria-hidden />
            用对话造一个
          </Button>
        </div>
      </header>

      <main className={styles.grid}>
        {LISTINGS.map((listing) => {
          const cover = coverOf(listing.spec);
          return (
            <article key={listing.spec.id} className={styles.card}>
              <div
                className={styles.cover}
                style={cover ? { backgroundImage: `url(${cover})` } : undefined}
                aria-hidden
              >
                <span className={styles.tag}>
                  <Badge tone={listing.tone} size="sm">
                    {listing.tag}
                  </Badge>
                </span>
              </div>
              <div className={styles.body}>
                <h2>{listing.spec.title}</h2>
                <p>{listing.spec.logline ?? listing.note}</p>
                <div className={styles.cast}>
                  {listing.spec.cast.map((member) => (
                    <span key={member.id} className={styles.castChip}>
                      {member.name}
                      <em>{member.role}</em>
                    </span>
                  ))}
                </div>
                <p className={styles.note}>{listing.note}</p>
                <span className={styles.price}>
                  {listing.price === 0 ? "免费" : `${listing.price} 额度 · 作者分成 70%`}
                </span>
                <div className={styles.actions}>
                  {listing.price > 0 && !wallet.owned.has(listing.spec.id) ? (
                    <Button
                      size="sm"
                      loading={wallet.busyId === listing.spec.id}
                      onClick={() => void buy(listing)}
                    >
                      {signedInName ? `购买 · ${listing.price}` : `登录后购买 · ${listing.price}`}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => onEnter(listing.spec)}>
                      导入并走进
                      <ArrowRight size={14} strokeWidth={2} aria-hidden />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void previewShell(listing.spec)}>
                    预览游戏壳
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </main>

      <footer className={styles.foot}>
        <span>`.world` 资产包 · 导入后归你 · 分叉破局按血缘树分润</span>
        <span>世界仍在你的 App 里管理：存档、回滚、合并、导出</span>
      </footer>
    </div>
  );
}
