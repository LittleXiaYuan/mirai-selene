import { useCallback, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { AiChat, type ChatRespond } from "@/components/arc/blocks/ai-chat/ai-chat";
import type { MarkProps } from "@/components/arc/blocks/ai-chat/ai-chat-marks";
import type { AssetTask } from "./spec-api";
import type { WorldSpec } from "@/world/spec";
import { forgeTurn, startForge } from "./forge-api";
import styles from "./forge.module.css";

const SeleneMark = ({ title, ...props }: MarkProps) => (
  <svg viewBox="0 0 24 24" fill="none" role="img" aria-label={title ?? "Selene"} {...props}>
    <path
      d="M15.8 3.4A9 9 0 1 0 21 12.6a7.1 7.1 0 0 1-9.1-4.5 7.1 7.1 0 0 1 3.9-4.7Z"
      fill="currentColor"
    />
  </svg>
);

const MODELS = [{ id: "selene", name: "Selene", note: "PAI-SSM · World-Spec", mark: SeleneMark }];

const SUGGESTIONS = [
  { label: "医院与 offer", prompt: "周三之前，医院复查结果和上海的 offer 撞在一起" },
  { label: "合伙人逼宫", prompt: "尽调前 48 小时，技术合伙人要我把生产库密钥交出来" },
  { label: "举报前夜", prompt: "实名举报前夜，被举报的人约我在咖啡馆私下谈谈" },
  { label: "雨夜散伙", prompt: "合伙人散伙前的最后一轮谈判，账上只剩六周" },
];

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * 用一句话造世界：Arc AI chat 作为对话骨架。
 * 对话负责问六件事；答完把 Spec 放进右侧预览，点「走进去」交给舞台。
 */
export function ForgeScreen({
  onHome,
  onEnter,
  onWorlds,
}: {
  onHome: () => void;
  onEnter: (spec: WorldSpec) => void;
  onWorlds: () => void;
}) {
  const [spec, setSpec] = useState<WorldSpec | null>(null);
  const [tasks, setTasks] = useState<AssetTask[]>([]);
  const [chatKey, setChatKey] = useState(0);
  const session = useRef<string | null>(null);

  const reset = useCallback(() => {
    session.current = null;
    setSpec(null);
    setTasks([]);
    setChatKey((key) => key + 1);
  }, []);

  const respond = useCallback<ChatRespond>(
    async function* (messages, { signal }) {
      const last = [...messages].reverse().find((message) => message.role === "user");
      if (!last) return;

      if (!session.current) {
        const started = await startForge();
        if (!started?.ok || !started.session_id) {
          yield { type: "error", message: "铸造台没有响应，确认 serve.mjs 已启动。" };
          return;
        }
        session.current = started.session_id;
      }

      const result = await forgeTurn({
        session_id: session.current,
        text: last.content,
        tension: 0,
      });

      if (!result?.ok) {
        yield { type: "error", message: result?.error ?? "这一句没接住，再说一次。" };
        return;
      }

      const text = [result.reply, result.question, result.hint].filter(Boolean).join("\n\n");
      for (let index = 0; index < text.length; index += 4) {
        if (signal.aborted) return;
        yield { type: "text", delta: text.slice(index, index + 4) };
        await delay(14);
      }

      if (result.done && result.spec) {
        setSpec(result.spec);
        setTasks(result.tasks ?? []);
        yield { type: "text", delta: "\n\n世界已经折好。右侧可以走进去，或者先看看十幕。" };
      }
    },
    [],
  );

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <Button variant="ghost" size="sm" onClick={onWorlds}>
          <ArrowLeft size={15} strokeWidth={1.75} aria-hidden />
          世界列表
        </Button>
        <button
          type="button"
          className={styles.brand}
          onClick={onHome}
          aria-label="回到首页"
        >
          Mirai<span>·</span>Selene
        </button>
        <span className={styles.spacer} />
        <span className={styles.hintText}>说出一个处境，Selene 会问六件事</span>
      </header>

      <div className={styles.layout} data-preview={spec ? "" : undefined}>
        <section
          className={styles.chat}
          style={{ "--chat-height": "100%" } as CSSProperties}
          aria-label="用一句话造世界"
        >
          <AiChat
            key={chatKey}
            models={MODELS}
            respond={respond}
            title="用一句话造世界"
            greeting="别写设定。告诉我一个真实处境，我会把它拆成十幕。"
            placeholder="说一个处境，比如：母亲的复查报告和上海 offer 撞在周三之前"
            suggestions={SUGGESTIONS}
            onNewChat={reset}
          />
        </section>

        {spec ? (
          <aside className={styles.preview} aria-label="世界预览">
            <span className={styles.kicker}>世界已成型</span>
            <h2>{spec.title}</h2>
            <p className={styles.logline}>{spec.logline}</p>

            <div className={styles.cast}>
              {spec.cast.map((member) => (
                <span key={member.id} className={styles.castChip}>
                  <b>{member.name}</b>
                  <span>{member.role}</span>
                </span>
              ))}
            </div>

            <div className={styles.meta}>
              <span>十幕</span>
              <b>{spec.logic_nodes.length}</b>
              <span>资产任务</span>
              <b>{tasks.length}</b>
              <span>温度</span>
              <b>{spec.state_injection.temperature ?? "默认"}</b>
              <span>预计</span>
              <b>约 {Math.max(3, Math.round(spec.logic_nodes.length * 1.3))} 分钟</b>
            </div>

            <div className={styles.nodes}>
              {spec.logic_nodes.map((node) => (
                <span key={node.id} className={styles.nodeChip}>
                  {node.title.split(" · ")[0]}
                </span>
              ))}
            </div>

            <div className={styles.actions}>
              <Button onClick={() => onEnter(spec)}>
                <Sparkles size={16} strokeWidth={1.75} aria-hidden />
                走进去
                <ArrowRight size={15} strokeWidth={2} aria-hidden />
              </Button>
              <Button variant="secondary" onClick={reset}>
                再铸一版
              </Button>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
