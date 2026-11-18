import { useRef } from "react";
import { ArrowRight, FileUp, Info, Link2, LogIn, Sparkles, Store } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import type { WorldSpec } from "@/world/spec";
import { SPEC_SAMPLES } from "@/world/spec-samples";
import type { UseSession } from "./use-session";
import type { UseWorlds } from "./use-worlds";
import styles from "./home.module.css";

const COVERS = {
  city: "/mirai/07-market.webp",
  study: "/mirai/03-insight.webp",
  home: "/mirai/04-world.webp",
  cover: "/mirai/01-cover.webp",
} as const;

function coverFor(name: string): string {
  if (/上海|城市/.test(name)) return COVERS.city;
  if (/研|学术/.test(name)) return COVERS.study;
  if (/家庭|家/.test(name)) return COVERS.home;
  return COVERS.cover;
}

function specCover(spec: WorldSpec): string {
  return (
    spec.assets_manifest.cover?.path ??
    spec.assets_manifest.backgrounds[Object.keys(spec.assets_manifest.backgrounds)[0] ?? ""]?.path ??
    spec.assets_manifest.portraits[spec.cast[0]?.portrait ?? ""]?.base ??
    COVERS.cover
  );
}

/**
 * 未登录的入口：示例世界 + 本地世界。
 * 不是 dashboard；管理台留给登录之后。新建世界走对话铸造台，不再内联展开表单。
 */
export function HomeScreen({
  w,
  session,
  onOpen,
  onDemo,
  onForge,
  onMarket,
  onIngest,
  onEnterSpec,
  onAuth,
  onStudio,
  onLogout,
  onGuide,
  onAbout,
}: {
  w: UseWorlds;
  session: UseSession;
  onOpen: () => void;
  onDemo: () => void;
  onForge: () => void;
  onMarket: () => void;
  onIngest: () => void;
  onEnterSpec: (spec: WorldSpec) => void;
  onAuth: () => void;
  onStudio: () => void;
  onLogout: () => void;
  onGuide: () => void;
  onAbout: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const samples = SPEC_SAMPLES.filter(
    (spec) => !w.worlds.some((world) => world.spec?.id === spec.id),
  );

  return (
    <div className={styles.home}>
      <div className={styles.brandRow}>
        <div className={styles.brand}>
          Mirai<span>·</span>Selene
        </div>
        <span className={styles.accountActions}>
          <Button variant="secondary" size="sm" onClick={onDemo}>
            <Sparkles size={14} strokeWidth={1.75} aria-hidden />
            演示模式
          </Button>
          {session.user ? (
            <>
              <Button variant="ghost" onClick={onStudio}>
                {session.user.name} · 工作台
              </Button>
              <Button variant="ghost" size="sm" onClick={onLogout}>
                退出
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={onAuth}>
              <LogIn size={14} strokeWidth={1.75} aria-hidden />
              登录
            </Button>
          )}
        </span>
      </div>

      <h1 className={styles.headline}>选一条路走进去，走出来还能反悔</h1>

      {w.worlds.length ? (
        <div className={styles.list}>
          {w.worlds.map((world) => (
            <button
              key={world.id}
              className={styles.worldRow}
              onClick={() => {
                w.setActiveId(world.id);
                onOpen();
              }}
            >
              <img
                className={styles.worldThumb}
                src={world.spec ? specCover(world.spec) : coverFor(world.name)}
                alt=""
                loading="lazy"
                decoding="async"
              />
              <span className={styles.worldText}>
                <span className={styles.worldName}>{world.name}</span>
                <span className={styles.worldHook}>{world.hook}</span>
                <span className={styles.worldMeta}>
                  {world.characters.length} 个人
                  <span aria-hidden>·</span>
                  {Object.keys(world.tree.nodes).length} 个节点
                </span>
              </span>
              <ArrowRight size={18} strokeWidth={1.75} aria-hidden />
            </button>
          ))}
        </div>
      ) : null}

      {samples.length ? (
        <div className={styles.samples}>
          <span className={styles.samplesHead}>示例世界</span>
          <div className={styles.list}>
            {samples.map((sample) => (
              <button
                key={sample.id}
                className={styles.worldRow}
                onClick={() => onEnterSpec(sample)}
              >
                <img
                  className={styles.worldThumb}
                  src={specCover(sample)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
                <span className={styles.worldText}>
                  <span className={styles.worldName}>{sample.title}</span>
                  <span className={styles.worldHook}>
                    {sample.logline ?? sample.subtitle ?? ""}
                  </span>
                  <span className={styles.worldMeta}>
                    {sample.cast.length} 个人
                    <span aria-hidden>·</span>
                    {sample.logic_nodes.length} 个节点
                  </span>
                </span>
                <ArrowRight size={18} strokeWidth={1.75} aria-hidden />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.actions}>
        {w.worlds.length > 0 ? (
          <Button
            onClick={() => {
              w.setActiveId(w.worlds[0].id);
              onOpen();
            }}
          >
            走进这个世界
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
          </Button>
        ) : samples.length ? (
          <Button onClick={() => onEnterSpec(samples[0])}>
            走进示例世界
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
          </Button>
        ) : null}

        <div className={styles.secondaryRow}>
          <Button variant="secondary" onClick={onForge} style={{ flex: 1 }}>
            <Sparkles size={16} strokeWidth={1.75} aria-hidden />
            新建世界
          </Button>
          <Button variant="secondary" onClick={() => fileRef.current?.click()} style={{ flex: 1 }}>
            <FileUp size={16} strokeWidth={1.75} aria-hidden />
            载入文件
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
              w.importFile(text);
              event.target.value = "";
            }}
          />
        </div>

        <Button variant="ghost" size="sm" onClick={onIngest}>
          <Link2 size={14} strokeWidth={1.75} aria-hidden />
          从链接造世界
        </Button>
        <Button variant="ghost" size="sm" onClick={onMarket}>
          <Store size={14} strokeWidth={1.75} aria-hidden />
          世界市场
        </Button>
        <Button variant="ghost" size="sm" onClick={onAbout}>
          <Info size={14} strokeWidth={1.75} aria-hidden />
          边界与基准
        </Button>
      </div>

      <p className={styles.footNote}>
        {session.user
          ? `当前档案：${session.user.name} · ${session.user.email}。世界只属于这个账号，别人看不到也改不到。`
          : "不登录也能用，世界存在这台设备上。登录后世界归你的账号，跨设备可见，别人看不到。"}
      </p>
    </div>
  );
}
