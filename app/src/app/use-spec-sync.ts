import { useEffect, useRef, useState } from "react";
import type { WorldSpec } from "@/world/spec";
import { fetchCurrentSpec } from "./spec-api";

export interface SpecSyncState {
  version: number;
  world: string | null;
  online: boolean;
}

/**
 * 服务端世界仓库的轮询。
 *
 * 版本号一变就把新 Spec 折进世界，切断当前连接 —— 不刷新、不重启。
 * 首次拿到版本只记录，不覆盖玩家已经选好的世界；除非服务端本来就有 Spec。
 */
export function useSpecSync(onSpec: (spec: WorldSpec) => void, enabled = true): SpecSyncState {
  const [state, setState] = useState<SpecSyncState>({ version: 0, world: null, online: false });
  const seen = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const tick = async () => {
      const data = await fetchCurrentSpec();
      if (!alive) return;
      if (!data) {
        setState((prev) => ({ ...prev, online: false }));
        return;
      }
      setState({
        version: data.version,
        world: data.spec?.title ?? null,
        online: true,
      });

      if (seen.current === null) {
        seen.current = data.version;
        // 服务端已经有世界：接管；没有：保留本地选择。
        // 首次只记版本，不接管：主界面仍然是 App 的登录/世界管理。
        return;
      }
      if (data.version !== seen.current) {
        seen.current = data.version;
        if (data.spec) onSpec(data.spec);
      }
    };

    void tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [onSpec, enabled]);

  return state;
}
