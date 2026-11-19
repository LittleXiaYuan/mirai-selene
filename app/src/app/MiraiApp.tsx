import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./use-session";
import { useWorlds, type WorldMeta } from "./use-worlds";
import { HomeScreen } from "./home-screen";
import { LandingScreen } from "./landing-screen";
import { ResetPasswordScreen } from "./reset-password-screen";
import { WorldStudio } from "./world-studio";
import { LoginImmersive } from "@/components/arc/blocks/login-immersive/login-immersive";
import { ForgeScreen } from "./forge-screen";
import { MarketScreen } from "./market-screen";
import { IngestScreen } from "./ingest-screen";
import { useSpecSync } from "./use-spec-sync";
import { MobileTabBar, type MobileTab } from "./mobile-tabbar";
import { DemoGuideBar, DemoLauncherModal, type DemoStep } from "./demo-mode";
import { SPEC_SAMPLES } from "@/world/spec-samples";
import type { WorldSpec } from "@/world/spec";

// 这些页面只在需要时加载：首屏不背它们的代码
const EditScreen = lazy(() =>
  import("./edit-screen").then((m) => ({ default: m.EditScreen })),
);
const Ending = lazy(() => import("./ending").then((m) => ({ default: m.Ending })));
const StageScreen = lazy(() =>
  import("./stage-screen").then((m) => ({ default: m.StageScreen })),
);
const CompareView = lazy(() =>
  import("./compare-view").then((m) => ({ default: m.CompareView })),
);
const AboutView = lazy(() =>
  import("./about-view").then((m) => ({ default: m.AboutView })),
);
// 引导只在第一次进入世界时用，也不进首屏
const Tour = lazy(() => import("./tour").then((m) => ({ default: m.Tour })));

type View = "landing" | "guest" | "forge" | "market" | "ingest" | "auth" | "home" | "stage" | "edit" | "ending" | "compare" | "about";

/** 能直接分享、刷新不丢的视图才有地址；stage/ending 这类仍然只是会话内状态。 */
const VIEW_PATHS: Partial<Record<View, string>> = {
  landing: "/",
  guest: "/world",
  forge: "/forge",
  market: "/market",
  ingest: "/ingest",
  auth: "/login",
  about: "/about",
};

function viewFromPath(pathname: string): View | null {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return (Object.keys(VIEW_PATHS) as View[]).find((v) => VIEW_PATHS[v] === clean) ?? null;
}

const TOUR_KEY = "mirai.tour.v1";

function tourSeen(): boolean {
  try {
    return Boolean(localStorage.getItem(TOUR_KEY));
  } catch {
    return true;
  }
}

function markTourSeen() {
  try {
    localStorage.setItem(TOUR_KEY, "1");
  } catch {
    // 隐私模式下存不了，下次再引导一遍
  }
}

/**
 * 单页应用：登录 → 首页 → 世界 → 编辑。
 *
 * 引导不是居中弹窗，而是进到世界里之后聚焦真实控件：
 * 选择区、时间线、分叉按钮。第一次进 Stage 自动开始。
 */
/** 步骤数据跟 Tour 同属一个 chunk，一起懒加载。 */
function TourWithSteps({ onDone }: { onDone: () => void }) {
  const [steps, setSteps] = useState<import("./tour").TourStep[] | null>(null);
  useEffect(() => {
    let alive = true;
    import("./tour").then((m) => {
      if (alive) setSteps(m.STAGE_TOUR);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!steps) return null;
  return <Tour steps={steps} onDone={onDone} />;
}

function RouteFallback() {
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: "var(--radius-pill)",
          border: "2px solid var(--border)",
          borderTopColor: "var(--accent)",
          animation: "spin 0.8s linear infinite",
        }}
        aria-label="加载中"
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function MiraiApp() {
  const session = useSession();
  const w = useWorlds();
  // 上线产品的入口是宣传页：先回答「这是什么」，再给「直接体验 / 登录」两个动作。
  // 老的世界列表退到「开始体验」之后，不再一进来就甩一屏管理操作。
  const [view, setViewState] = useState<View>(
    () => viewFromPath(window.location.pathname) ?? "landing",
  );
  // 栈只记住"从哪来"，返回键才不会被几个子应用踢回一个不相干的地方。
  const navView = useRef<View>(view);
  navView.current = view;
  const navStack = useRef<View[]>([]);
  const setView = useCallback((next: View) => {
    if (next === navView.current) return;
    navStack.current.push(navView.current);
    setViewState(next);
  }, []);
  const goBack = useCallback((fallback: View) => {
    setViewState(navStack.current.pop() ?? fallback);
  }, []);
  // 邮件里的重置链接形如 /?reset=<token>；解析一次即可。
  const [resetToken, setResetToken] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get("reset");
    } catch {
      return null;
    }
  });
  const [showForgot, setShowForgot] = useState(false);
  // 演示模式：支持 URL `/?demo=1`、页面入口按钮或快捷键 Ctrl+Shift+D 唤起
  const [demoMode, setDemoMode] = useState<boolean>(() => {
    try {
      const flag = new URLSearchParams(window.location.search).get("demo");
      return flag === "1" || flag === "true";
    } catch {
      return false;
    }
  });
  const [demoPickerOpen, setDemoPickerOpen] = useState<boolean>(() => {
    try {
      const flag = new URLSearchParams(window.location.search).get("demo");
      return flag === "1" || flag === "true";
    } catch {
      return false;
    }
  });
  const [demoAutoIngest, setDemoAutoIngest] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  // localStorage 只能读在 effect 里：首次渲染要和预期一致
  const [tour, setTour] = useState(false);
  const [tourDue, setTourDue] = useState(false);
  const enteredStage = useRef(false);

  // 地址跟着视图走：直链、刷新、浏览器后退都落在同一个位置，而不是一律掉回首页。
  useEffect(() => {
    const path = VIEW_PATHS[view];
    if (path && window.location.pathname !== path) window.history.pushState({ view }, "", path);
  }, [view]);

  useEffect(() => {
    const onPop = () => {
      // 浏览器后退是"外部"导航：清掉应用内栈，避免下一次返回又弹回去。
      navStack.current = [];
      setViewState(viewFromPath(window.location.pathname) ?? "landing");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 默认落在未登录的展示首页：示例世界 + 一句话。登录从右上角进，成功后进工作台。
  // 这样扫码的人先看到「这是什么东西」，而不是一道表单。

  /**
   * 服务端发布了 World-Spec，客户端就地切世界。
   * 这是「叙事操作系统」的默认行为：服务端的世界是当前世界，不用刷新。
   */
  const loadSpec = w.loadSpec;
  const liveSpecId = useRef<string | null>(null);
  useEffect(() => {
    liveSpecId.current = w.active?.spec?.id ?? null;
  }, [w.active?.spec?.id]);
  const applyLiveSpec = useCallback(
    (spec: WorldSpec) => {
      // 自己刚发布的那一份不重复载入，否则会把人踢回第一幕。
      if (liveSpecId.current === spec.id) return;
      loadSpec(spec);
      setView("stage");
    },
    [loadSpec],
  );
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const applyLive = useCallback(
    (spec: WorldSpec) => {
      // 还没登录/还没跳过入口时，不让热重载把人直接拽进世界。
      if (viewRef.current === "auth") return;
      applyLiveSpec(spec);
    },
    [applyLiveSpec],
  );
  const specSync = useSpecSync(applyLive);

  useEffect(() => {
    setTourDue(!tourSeen());
  }, []);

  // 快捷键 Ctrl+Shift+D 随时开关演示模式
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setDemoMode((prev) => {
          const next = !prev;
          setDemoPickerOpen(next);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 第一次进到世界里就自动开始引导（演示模式下跳过旧弹窗引导，避免打断体验）
  useEffect(() => {
    if (view !== "stage" || demoMode) return;
    if (enteredStage.current) return;
    enteredStage.current = true;
    if (tourDue) {
      const timer = window.setTimeout(() => setTour(true), 600);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [view, tourDue, demoMode]);

  const finishTour = () => {
    markTourSeen();
    setTour(false);
    setTourDue(false);
  };

  // 本地世界按账号分桶：换号不串数据（服务端另有 user_id 隔离）。
  const setScope = w.setScope;
  useEffect(() => {
    setScope(session.user?.id ?? null);
  }, [session.user?.id, setScope]);

  // 登录后把服务端的世界拉下来合并（服务端优先，本地独有的保留）
  useEffect(() => {
    if (!session.user) return;
    let alive = true;
    (async () => {
      try {
        const remote = (await session.pullWorlds()) as WorldMeta[];
        if (!alive || !Array.isArray(remote)) return;
        if (remote.length) w.mergeRemote(remote);
      } catch {
        // 拉取失败就用本地的，不白屏
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user?.id]);

  // 当前世界变化时推上去。防抖 1.2 秒，避免拖动时间线时狂发请求。
  const pushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPushed = useRef<string>("");
  useEffect(() => {
    if (!session.user || !w.active) return;
    const payload = JSON.stringify({
      id: w.active.id,
      name: w.active.name,
      hook: w.active.hook,
      characters: w.active.characters,
      tree: w.active.tree,
      cursor: w.active.cursor,
    });
    if (payload === lastPushed.current) return;
    if (pushRef.current) clearTimeout(pushRef.current);
    pushRef.current = setTimeout(() => {
      lastPushed.current = payload;
      void session.pushWorld(JSON.parse(payload));
    }, 1200);
    return () => {
      if (pushRef.current) clearTimeout(pushRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.active?.tree, w.active?.cursor, w.active?.name, session.user?.id]);

  if (session.loading) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          color: "var(--text-muted)",
          fontSize: "var(--text-sm)",
        }}
      >
        正在打开
      </div>
    );
  }

  // 带 token 落地：先设新密码，再回登录页。
  if (resetToken) {
    const done = () => {
      window.history.replaceState(null, "", "/");
      setResetToken(null);
      setView("auth");
    };
    return (
      <ResetPasswordScreen
        mode="reset"
        token={resetToken}
        onBack={done}
        onDone={done}
      />
    );
  }

  // 忘记密码：不需要先进登录态，独立一页。
  if (showForgot) {
    return (
      <ResetPasswordScreen
        mode="request"
        onBack={() => setShowForgot(false)}
        onDone={() => {
          setShowForgot(false);
          setView("auth");
        }}
      />
    );
  }

  const openDemoMode = () => {
    setDemoMode(true);
    setDemoPickerOpen(true);
  };

  const exitDemoMode = () => {
    setDemoMode(false);
    setDemoPickerOpen(false);
    setDemoAutoIngest(false);
  };

  const demoStep: DemoStep =
    view === "ingest"
      ? 1
      : view === "stage"
        ? 2
        : view === "compare"
          ? 3
          : view === "market"
            ? 4
            : 1;

  const handleDemoJumpStage = () => {
    if (!w.active) {
      const fallback = SPEC_SAMPLES.find((s) => s.id === "last-call-demo") ?? SPEC_SAMPLES[0];
      if (fallback) w.loadSpec(fallback);
    }
    setDemoPickerOpen(false);
    setView("stage");
  };

  const handleDemoBranchAndMerge = () => {
    setDemoBusy(true);
    if (!w.active) {
      const fallback = SPEC_SAMPLES.find((s) => s.id === "last-call-demo") ?? SPEC_SAMPLES[0];
      if (fallback) w.loadSpec(fallback);
    }
    const res = w.demoForkAndMerge();
    setDemoBusy(false);
    if (res.ok) {
      setDemoPickerOpen(false);
      setView("compare");
    }
  };

  const handleDemoExportAndMarket = () => {
    w.exportFile();
    setDemoPickerOpen(false);
    setView("market");
  };

  const tabbarVisible = ["guest", "home", "forge", "market", "ingest"].includes(view);
  const activeTab: MobileTab =
    view === "home" || view === "guest"
      ? "worlds"
      : view === "forge" || view === "market" || view === "ingest"
        ? view
        : "worlds";

  return (
    <>
      {view === "landing" && (
        <LandingScreen
          signedInName={session.user?.name}
          onEnter={() => setView(session.user ? "home" : "guest")}
          onDemo={openDemoMode}
          onAuth={() => setView("auth")}
          onAbout={() => setView("about")}
          onMarket={() => setView("market")}
          onWorkspace={() => setView("home")}
        />
      )}
      {view === "forge" && (
        <ForgeScreen
          onHome={() => setView("landing")}
          onEnter={(spec) => {
            w.loadSpec(spec);
            setView("stage");
          }}
          onWorlds={() => goBack(session.user ? "home" : "landing")}
        />
      )}
      {view === "auth" && (
        <>
          <LoginImmersive
            fullScreen
            onSkip={() => setView("landing")}
            onMagic={async (email) => {
              await session.magic(email);
              window.setTimeout(() => setView("home"), 1500);
            }}
            onAuthenticate={async (mode, email, password, name) => {
              if (mode === "sign-up") {
                await session.register(email, name || email.split("@")[0], password);
              } else {
                await session.login(email, password);
              }
              // 让确认动画先画完，再进工作台
              window.setTimeout(() => setView("home"), 1500);
            }}
          />
          <button
            type="button"
            onClick={() => setShowForgot(true)}
            style={{
              position: "fixed",
              left: "50%",
              bottom: "calc(var(--space-5) + env(safe-area-inset-bottom, 0px))",
              transform: "translateX(-50%)",
              zIndex: 40,
              background: "none",
              border: 0,
              padding: "8px 12px",
              fontSize: "var(--text-sm)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            忘记密码？
          </button>
        </>
      )}
      {view === "guest" && (
        <HomeScreen
          w={w}
          session={session}
          onHome={() => setView("landing")}
          onOpen={() => setView("stage")}
          onDemo={openDemoMode}
          onForge={() => setView("forge")}
          onMarket={() => setView("market")}
          onIngest={() => setView("ingest")}
          onEnterSpec={(spec) => {
            w.loadSpec(spec);
            setView("stage");
          }}
          onAuth={() => setView("auth")}
          onStudio={() => setView("home")}
          onLogout={async () => {
            await session.logout();
            setView("landing");
          }}
          onAbout={() => setView("about")}
          onGuide={() => {
            setView("stage");
            window.setTimeout(() => setTour(true), 700);
          }}
        />
      )}
      {view === "ingest" && (
        <IngestScreen
          autoRunDemo={demoAutoIngest}
          onHome={() => setView("landing")}
          onEnter={(spec) => {
            w.loadSpec(spec);
            setDemoAutoIngest(false);
            setView("stage");
          }}
          onWorlds={() => goBack(session.user ? "home" : "landing")}
          onForge={() => setView("forge")}
        />
      )}
      {view === "market" && (
        <MarketScreen
          onHome={() => setView("landing")}
          onBack={() => goBack(session.user ? "home" : "landing")}
          onForge={() => setView("forge")}
          onEnter={(spec) => {
            w.loadSpec(spec);
            setView("stage");
          }}
        />
      )}
      {view === "home" && (
        <WorldStudio
          w={w}
          session={session}
          onHome={() => setView("landing")}
          onOpen={() => setView("stage")}
          onForge={() => setView("forge")}
          onMarket={() => setView("market")}
          onIngest={() => setView("ingest")}
          onAuth={() => setView("auth")}
          onLogout={() => setView("landing")}
          onAbout={() => setView("about")}
          onGuide={() => {
            setView("stage");
            window.setTimeout(() => setTour(true), 700);
          }}
        />
      )}
      {view === "stage" && (
        <Suspense fallback={<RouteFallback />}>
          <StageScreen
            w={w}
            specSync={specSync}
            demoMode={demoMode}
            onEdit={() => setView("edit")}
            onHome={() => setView(session.user ? "home" : "guest")}
            onForge={() => setView("forge")}
            onEnd={() => setView("ending")}
            onCompare={() => setView("compare")}
          />
        </Suspense>
      )}
      {view === "edit" && (
        <Suspense fallback={<RouteFallback />}>
          <EditScreen w={w} onPlay={() => setView("stage")} onHome={() => setView("home")} />
        </Suspense>
      )}
      {view === "about" && (
        <Suspense fallback={<RouteFallback />}>
          <AboutView onBack={() => goBack(session.user ? "home" : "landing")} />
        </Suspense>
      )}
      {view === "compare" && (
        <Suspense fallback={<RouteFallback />}>
          <CompareView w={w} onBack={() => setView("stage")} />
        </Suspense>
      )}
      {view === "ending" && (
        <Suspense fallback={<RouteFallback />}>
          <Ending w={w} onBack={() => setView("stage")} />
        </Suspense>
      )}

      {tour && view === "stage" && !demoMode && (
        <Suspense fallback={null}>
          <TourWithSteps onDone={finishTour} />
        </Suspense>
      )}

      {demoMode && demoPickerOpen && (
        <DemoLauncherModal
          onStartIngest={() => {
            setDemoPickerOpen(false);
            setDemoAutoIngest(true);
            setView("ingest");
          }}
          onStartSpec={(spec) => {
            w.loadSpec(spec);
            setDemoPickerOpen(false);
            setDemoAutoIngest(false);
            setView("stage");
          }}
          onClose={exitDemoMode}
        />
      )}

      {demoMode && !demoPickerOpen && (
        <DemoGuideBar
          step={demoStep}
          busy={demoBusy}
          onOpenLauncher={() => setDemoPickerOpen(true)}
          onJumpStage={handleDemoJumpStage}
          onBranchAndMerge={handleDemoBranchAndMerge}
          onExportAndMarket={handleDemoExportAndMarket}
          onReset={() => {
            w.resetToDemo();
            setDemoAutoIngest(false);
            setDemoPickerOpen(true);
          }}
          onExit={exitDemoMode}
        />
      )}

      {tabbarVisible && (
        <MobileTabBar
          active={activeTab}
          onNavigate={(tab) => {
            if (tab === "worlds") setView(session.user ? "home" : "guest");
            else setView(tab);
          }}
        />
      )}
    </>
  );
}
