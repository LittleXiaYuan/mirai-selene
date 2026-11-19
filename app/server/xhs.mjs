/**
 * 小红书真实读取：走 @lucasygu/redbook 的 CLI（浏览器 Cookie 认证，无官方 API）。
 *
 * 为什么不在服务端自己签名：xhs 的 web 接口要 x-s/x-t 签名与 xsec_token，
 * 这套东西上游库已经维护好了；我们只做调用与归一化，避免自己抄一份会过期的签名。
 *
 * 没有 XHS_COOKIE 时不假装能抓 —— 直接抛 xhs-login-required，让上层明确标注。
 */
import { execFile } from "node:child_process";

const COOKIE = process.env.XHS_COOKIE || "";
const CLI = process.env.XHS_CLI || "redbook";

export function xhsConfigured() {
  return Boolean(COOKIE);
}

function run(args, timeout = 25_000) {
  return new Promise((resolve, reject) => {
    execFile(
      CLI,
      [...args, "--json", "--cookie-string", COOKIE],
      { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr || error.message).trim().split("\n").slice(-3).join(" | ");
          reject(new Error(tail.slice(0, 240)));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function parseJson(text) {
  const cleaned = String(text || "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("redbook 没有返回 JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function fetchXhsNote(url) {
  if (!COOKIE) throw new Error("xhs-login-required");

  const note = parseJson(await run(["read", url]));
  const title = String(note.title ?? note.note_card?.title ?? "").slice(0, 80);
  const body = String(note.desc ?? note.note_card?.desc ?? "").slice(0, 4000);
  if (!title && !body) throw new Error("xhs-empty（这条笔记需要带 xsec_token 的完整链接）");

  const tags = (note.tag_list ?? note.note_card?.tag_list ?? [])
    .map((tag) => String(tag?.name ?? tag).trim())
    .filter(Boolean)
    .slice(0, 8);

  let comments = [];
  let commentsFetched = false;
  try {
    const parsed = parseJson(await run(["comments", url, "--all"], 30_000));
    const list = parsed.comments ?? parsed.data?.comments ?? [];
    comments = list.slice(0, 30).map((comment) => ({
      text: String(comment.content ?? comment.text ?? "").slice(0, 200),
      likes: Number(comment.like_count ?? comment.likes ?? 0),
      author: String(comment.user?.nickname ?? comment.user_info?.nickname ?? ""),
    })).filter((comment) => comment.text);
    commentsFetched = true;
  } catch {
    // 评论抓不到不算失败：正文与标签仍然可用
  }

  return {
    title: title || "一条正在发酵的热帖",
    body: body || title,
    tags,
    comments,
    commentsFetched,
    likes: Number(note.interact_info?.liked_count ?? 0),
    collects: Number(note.interact_info?.collected_count ?? 0),
  };
}
