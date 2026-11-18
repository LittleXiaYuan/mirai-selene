/**
 * 最小 SMTP 发信客户端（零第三方依赖）。
 *
 * 为什么自己写：生产服务器刻意保持零 node_modules —— 部署只传 dist 与
 * server/*.mjs，跑 `npm install` 的机会都没有。所以这里用 node:tls 直接
 * 走隐式 TLS（465，QQ/163/阿里云邮箱都支持），只实现发信需要的那几条命令。
 *
 * 不支持 STARTTLS（587）。需要 587 时再补；当前所有主流国内邮箱都提供 465。
 *
 * 环境变量：
 *   SMTP_HOST   smtp.qq.com
 *   SMTP_PORT   465
 *   SMTP_USER   you@example.com
 *   SMTP_PASS   授权码（不是登录密码）
 *   SMTP_FROM   Mirai-Selene <you@example.com>
 *   MIRAI_APP_URL https://mirai.cloudtori.cn   // 用于拼重置链接
 */

import tls from "node:tls";

const HOST = process.env.SMTP_HOST || "";
const PORT = Number(process.env.SMTP_PORT || 465);
const USER = process.env.SMTP_USER || "";
const PASS = process.env.SMTP_PASS || "";
const FROM = process.env.SMTP_FROM || USER;
const TIMEOUT_MS = 15_000;

export function mailConfigured() {
  return Boolean(HOST && USER && PASS && FROM);
}

export function appUrl() {
  return (process.env.MIRAI_APP_URL || "https://mirai.cloudtori.cn").replace(/\/+$/, "");
}

function encodeHeader(value) {
  // 非 ASCII 主题按 RFC 2047 编码，避免中文标题变乱码
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function sanitizeHeader(value) {
  // 防头注入：正文之外的字段不允许回车换行
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

/**
 * 发一封纯文本邮件。返回 { ok, error? }，不抛异常 —— 调用方（注册/找回）
 * 不该因为邮件服务抖动而整体失败。
 */
export async function sendMail({ to, subject, text }) {
  if (!mailConfigured()) return { ok: false, error: "smtp-not-configured" };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // 已断开
      }
      resolve(result);
    };

    let socket;
    let buffer = "";
    let step = 0;
    let waiting = null;

    const timer = setTimeout(() => finish({ ok: false, error: "smtp-timeout" }), TIMEOUT_MS);

    const onLine = (line) => {
      // 多行响应以 "250-" 续行，最后一行是 "250 "
      if (/^\d{3}-/.test(line)) return;
      const handler = waiting;
      waiting = null;
      handler?.(line);
    };

    const expect = (pattern) =>
      new Promise((resolveLine, rejectLine) => {
        waiting = (line) => {
          if (pattern.test(line)) resolveLine(line);
          else rejectLine(new Error(`smtp unexpected: ${line.slice(0, 120)}`));
        };
      });

    const send = (data) => socket.write(`${data}\r\n`);

    try {
      socket = tls.connect({ host: HOST, port: PORT, servername: HOST }, () => {
        // 连接建立后由下面的流程接管
      });
    } catch (error) {
      finish({ ok: false, error: String(error) });
      return;
    }

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");
        onLine(line);
      }
    });
    socket.on("error", (error) => finish({ ok: false, error: String(error) }));
    socket.on("close", () => {
      if (!settled) finish({ ok: false, error: "smtp-closed" });
    });

    (async () => {
      try {
        await expect(/^220/); // greeting
        send("EHLO mirai.local");
        await expect(/^250/);
        send("AUTH LOGIN");
        await expect(/^334/);
        send(Buffer.from(USER, "utf8").toString("base64"));
        await expect(/^334/);
        send(Buffer.from(PASS, "utf8").toString("base64"));
        await expect(/^235/);
        send(`MAIL FROM:<${sanitizeHeader(USER)}>`);
        await expect(/^250/);
        send(`RCPT TO:<${sanitizeHeader(to)}>`);
        await expect(/^25[01]/);
        send("DATA");
        await expect(/^354/);

        const body = Buffer.from(String(text), "utf8")
          .toString("base64")
          .replace(/.{76}/g, "$&\r\n");
        const message = [
          `From: ${sanitizeHeader(FROM)}`,
          `To: ${sanitizeHeader(to)}`,
          `Subject: ${encodeHeader(sanitizeHeader(subject))}`,
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset="UTF-8"',
          "Content-Transfer-Encoding: base64",
          "",
          body,
          ".",
        ].join("\r\n");
        socket.write(`${message}\r\n`);
        await expect(/^250/);
        send("QUIT");
        finish({ ok: true });
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}
