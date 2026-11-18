/**
 * 世界模型演出一幕：把玩家的一句话发过去，正文边到边收。
 *
 * 用 EventSource 不行（要 POST），所以手写 SSE 解析。
 * 关键点：正文到了就先显示，不要等整段结束 —— 那就不叫实时了。
 */

import { useCallback, useRef, useState } from "react";

export interface SceneMeta {
  place: string;
  time: string;
  mood: string;
  weather: string;
}

/** 模型给的下一步，带它会留下的记忆 —— 这样点之前就能算影响。 */
export interface Suggestion {
  text: string;
  key?: string;
  value?: number;
}

export interface Beat {
  text: string;
  scene: SceneMeta | null;
  suggestions: Suggestion[];
  memory: { key: string; value: number } | null;
}

const EMPTY: Beat = { text: "", scene: null, suggestions: [], memory: null };

export function useBeat() {
  const [beat, setBeat] = useState<Beat>(EMPTY);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBeat(EMPTY);
    setPending(false);
    setError(null);
  }, []);

  const run = useCallback(
    async (
      payload: { action: string; world: unknown; memories: { key: string; value: number }[] },
      options?: { demoFallback?: boolean },
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const acc: Beat = { text: "", scene: null, suggestions: [], memory: null };
      setBeat(EMPTY);
      setError(null);
      setPending(true);

      const timeoutId = options?.demoFallback
        ? window.setTimeout(() => controller.abort("demo_timeout"), 5500)
        : null;

      try {
        const res = await fetch("/mirai-api/act", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`服务返回 ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (timeoutId) window.clearTimeout(timeoutId);
          buffer += decoder.decode(value, { stream: true });

          // SSE 以空行分隔事件
          let cut = buffer.indexOf("\n\n");
          while (cut !== -1) {
            const raw = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            cut = buffer.indexOf("\n\n");

            let event = "message";
            let data = "";
            for (const line of raw.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!data) continue;

            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            if (event === "delta") {
              acc.text += (parsed as { text?: string }).text ?? "";
              setBeat({ ...acc });
            } else if (event === "scene") {
              acc.scene = parsed as SceneMeta;
              setBeat({ ...acc });
            } else if (event === "suggest") {
              const raw = (parsed as { items?: unknown[] }).items ?? [];
              acc.suggestions = raw.map((item) => {
                if (typeof item === "string") return { text: item };
                const o = item as { text?: string; key?: string; value?: number };
                return {
                  text: String(o.text ?? "").slice(0, 40),
                  key: o.key ? String(o.key).slice(0, 12) : undefined,
                  value: typeof o.value === "number" ? o.value : undefined,
                };
              }).filter((x) => x.text);
              setBeat({ ...acc });
            } else if (event === "done") {
              acc.memory = (parsed as { memory?: { key: string; value: number } }).memory ?? null;
              setBeat({ ...acc });
            } else if (event === "error") {
              setError((parsed as { message?: string }).message ?? "生成失败");
            }
          }
        }
        return acc;
      } catch (err) {
        if (timeoutId) window.clearTimeout(timeoutId);
        const abortedByUser = (err as Error).name === "AbortError" && controller.signal.reason !== "demo_timeout";
        if (options?.demoFallback && !abortedByUser) {
          const fallbackText = `她停了半拍，把你刚才那句「${payload.action.slice(0, 26)}」在心里过了一遍，目光没有移开：「你嘴上说得轻巧，但其实心里已经做了决定，对吧？如果现在退一步，你甘心吗？」`;
          acc.text = fallbackText;
          acc.suggestions = [
            { text: "把真实的顾虑直接摊开说", key: "坦诚度", value: 2 },
            { text: "先稳住局面，留二十四小时余地", key: "缓冲期", value: 1 },
            { text: "坚持底线，不让对方牵着走", key: "强硬态度", value: 2 },
          ];
          acc.memory = { key: payload.action.slice(0, 8) || "关键表态", value: 2 };
          setBeat({ ...acc });
          return acc;
        }
        if (!abortedByUser) {
          setError(err instanceof Error ? err.message : "连不上世界");
        }
        return null;
      } finally {
        if (timeoutId) window.clearTimeout(timeoutId);
        setPending(false);
      }
    },
    [],
  );

  return { beat, pending, error, run, reset };
}

export type UseBeat = ReturnType<typeof useBeat>;
