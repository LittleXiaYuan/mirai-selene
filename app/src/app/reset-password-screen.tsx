import { useState } from "react";
import { ArrowLeft, Mail } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import styles from "./reset.module.css";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

/**
 * 两个入口共用一个组件：
 *   mode="request" —— 输入邮箱，请求重置链接（不暴露邮箱是否存在）
 *   mode="reset"   —— 带着 token 落地，设置新密码
 */
export function ResetPasswordScreen({
  mode,
  token,
  onBack,
  onDone,
}: {
  mode: "request" | "reset";
  token?: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setNotice(null);
    if (mode === "reset" && password !== confirm) {
      setError("两次输入的新密码不一样");
      return;
    }
    setBusy(true);
    try {
      if (mode === "request") {
        const data = await post<{ ok: boolean; mailConfigured?: boolean }>("/api/auth/forgot", {
          email: email.trim(),
        });
        setNotice(
          data.mailConfigured
            ? "如果这个邮箱在系统里，重置链接已经发出，30 分钟内有效。"
            : "邮件服务还没配置，暂时无法发送重置链接。请先用密码登录，或联系管理员。",
        );
      } else {
        if (!token) throw new Error("缺少重置令牌，请重新打开邮件里的链接");
        await post("/api/auth/reset", { token, password });
        setNotice("密码已重置，其他设备已全部下线。请用新密码登录。");
        window.setTimeout(onDone, 1200);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <button className={styles.back} onClick={onBack} aria-label="返回">
          <ArrowLeft size={18} strokeWidth={1.75} aria-hidden />
          返回
        </button>

        <h1 className={styles.title}>
          {mode === "request" ? "找回密码" : "设置新密码"}
        </h1>
        <p className={styles.lead}>
          {mode === "request"
            ? "输入注册邮箱。我们会发一封一次性链接，30 分钟内有效。"
            : "设置一个新密码。保存后，其他设备上的登录会全部失效。"}
        </p>

        <div className="stack">
          {mode === "request" ? (
            <Input
              label="注册邮箱"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="field-16"
            />
          ) : (
            <>
              <Input
                label="新密码"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 8 位"
                autoComplete="new-password"
                className="field-16"
              />
              <Input
                label="再输一次"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder="确认新密码"
                autoComplete="new-password"
                className="field-16"
              />
            </>
          )}

          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={mode === "request" ? !email.trim() : password.length < 8}
          >
            <Mail size={16} strokeWidth={1.75} aria-hidden />
            {mode === "request" ? "发送重置链接" : "保存新密码"}
          </Button>

          {error && <Alert tone="danger" title="没成功">{error}</Alert>}
          {notice && <Alert tone="success" title="已完成">{notice}</Alert>}
        </div>
      </div>
    </div>
  );
}
