/**
 * Mirai-Selene MCP server 的 stdio 包装。
 *
 * 工具与分派在 server/mcp-core.mjs；同一个内核也被 serve.mjs 的 /mcp 复用，
 * 所以 Agent 既能在本地用 stdio 跑，也能从云端以 Streamable HTTP 连进来。
 */

import { dispatch } from "./mcp-core.mjs";

function send(payload) {
  if (payload) process.stdout.write(`${JSON.stringify(payload)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut = buffer.indexOf("\n");
  while (cut !== -1) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    cut = buffer.indexOf("\n");
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "不是合法 JSON" } });
      continue;
    }
    void dispatch(message).then(send);
  }
});

process.stderr.write("mirai-selene mcp ready\n");
