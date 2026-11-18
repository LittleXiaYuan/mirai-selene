import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Alert } from "@/components/arc/alert/alert";
import type { UseSession } from "./use-session";
import styles from "./auth.module.css";

type Mode = "login" | "register";

export function AuthScreen({
  session,
  onDone,
  onSkip,
}: {
  session: UseSession;
  onDone: () => void;
  onSkip: () => void;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    if (!email.trim() || !password) {
      setError("邮箱和密码都要填");
      return;
    }
    if (mode === "register" && password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    setBusy(true);
    try {
      if (mode === "register") {
        await session.register(email.trim(), name.trim() || email.split("@")[0], password);
      } else {
        await session.login(email.trim(), password);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "出错了，再试一次");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.brand}>
        Mirai<span>·</span>Selene
      </div>

      <h1 className={styles.headline}>
        {mode === "login" ? "回到你的世界" : "给世界一个容器"}
      </h1>
      <p className={styles.sub}>
        {mode === "login"
          ? "登录后，你在任何设备上都能接着走上次那条世界线。"
          : "注册后，世界会存在服务器上，不再只活在这台手机里。"}
      </p>

      {error && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Alert tone="danger" title={error} />
        </div>
      )}

      <div className={styles.form}>
        <Input
          id="a-email"
          label="邮箱"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="field-16"
          placeholder="you@example.com"
        />

        {mode === "register" && (
          <Input
            id="a-name"
            label="怎么称呼你"
            autoComplete="nickname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="field-16"
            placeholder="显示在作品旁边"
          />
        )}

        <Input
          id="a-pass"
          label="密码"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="field-16"
          placeholder={mode === "register" ? "至少 8 位" : undefined}
        />

        <Button onClick={() => void submit()} loading={busy}>
          {mode === "login" ? "进去" : "建好账号"}
          {!busy && <ArrowRight size={16} strokeWidth={1.75} aria-hidden />}
        </Button>
      </div>

      <div className={styles.switchRow}>
        {mode === "login" ? "还没有账号？" : "已经有账号？"}
        <Button
          variant="ghost"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
          }}
        >
          {mode === "login" ? "注册一个" : "去登录"}
        </Button>
      </div>

      <div className={styles.skip}>
        <Button variant="ghost" onClick={onSkip}>
          先不登录，直接看看
        </Button>
      </div>

      <p className={styles.note}>
        不登录也能用。世界会存在这台设备上，可以导出成文件带走。登录只是让它跨设备同步。
      </p>
    </div>
  );
}
