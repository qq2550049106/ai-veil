#!/usr/bin/env node
// AI-Veil MCP 桥（stdio JSON-RPC 2.0）
// ---------------------------------------------------------------------------
// 作用：把 DSH 的 Agent 动作翻译成 AI-Veil 的统一事件，写进文件收件箱
//       （默认 ~/.ai-veil/events.jsonl，AI-Veil 用 `--adapter file` 消费）。
// 工具：
//   veil_emit   { event: <VeilEvent 对象> } 或 { json: "<JSON 字符串>" }
//   veil_cancel { session_id?, reason? }
// 约束：
//   - stdout 只输出 JSON-RPC 报文，日志一律 stderr；
//   - 零依赖，只用 node: 内置模块；
//   - 任何异常都转成 JSON-RPC error，不让进程崩掉。
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "ai-veil-bridge";
const SERVER_VERSION = "1.0.0";

const HOME = os.homedir();
const INBOX = process.env.AI_VEIL_INBOX || path.join(HOME, ".ai-veil", "events.jsonl");
const CANCEL_DIR = path.join(HOME, ".ai-veil", "cancel");
const AGENT = process.env.AI_VEIL_AGENT || "deepseek-harness";

const startedAt = Date.now();
const sessionId = `dsh-${startedAt.toString(36)}`;

function log(message) {
  try {
    process.stderr.write(`[ai-veil-bridge] ${message}\n`);
  } catch {
    /* stderr 不可写时忽略 */
  }
}

function ensureDirs() {
  fs.mkdirSync(path.dirname(INBOX), { recursive: true });
  fs.mkdirSync(CANCEL_DIR, { recursive: true });
}

function appendEvent(event) {
  ensureDirs();
  fs.appendFileSync(INBOX, JSON.stringify(event) + "\n", "utf8");
}

/** 补齐默认字段，保证 AI-Veil 侧解析不会因为缺字段而丢事件 */
function normalize(input) {
  const event = { ...input };
  if (!event.event || typeof event.event !== "string" || !event.event.trim()) {
    throw new Error("缺少 event 字段");
  }
  event.event = event.event.trim();
  if (!event.ts || typeof event.ts !== "number") event.ts = Date.now();
  if (!event.session_id || typeof event.session_id !== "string") event.session_id = sessionId;
  if (!event.agent || typeof event.agent !== "object") {
    event.agent = { name: AGENT, version: "unknown" };
  }
  if (!event.mode) event.mode = "takeover";
  if (event.cancel === undefined) event.cancel = { enabled: true, hotkey: "Ctrl+Alt+Esc" };
  return event;
}

function extractEvent(args) {
  if (args && typeof args === "object") {
    if (args.event && typeof args.event === "object") return normalize(args.event);
    if (typeof args.event === "string") return normalize(JSON.parse(args.event));
    if (typeof args.json === "string") return normalize(JSON.parse(args.json));
    if (args.event === undefined && args.json === undefined) return normalize(args);
  }
  throw new Error("veil_emit 需要 event 或 json 参数");
}

function cancel(session, reason) {
  ensureDirs();
  const target = path.join(CANCEL_DIR, `cancel-${String(session).replace(/[^\w-]/g, "_")}-${Date.now()}.json`);
  fs.writeFileSync(target, JSON.stringify({ session_id: session, reason, ts: Date.now() }), "utf8");
  appendEvent({
    event: "session.end",
    ts: Date.now(),
    session_id: session,
    agent: { name: AGENT, version: "unknown" },
    mode: "takeover",
    action: { type: "other", target: `已中止：${reason}` },
  });
  return target;
}

const TOOLS = [
  {
    name: "veil_emit",
    description:
      "向 AI-Veil 上报一条接管事件，让用户在屏幕上看到横幅/边框、听到提示音、收到桌面通知。开始接管、每次动作前后、需要人工介入、出错、结束都应调用；长任务每 25 秒发一次 heartbeat 续期。",
    inputSchema: {
      type: "object",
      properties: {
        event: {
          type: "object",
          description:
            'VeilEvent 对象，例如 {"event":"action.before","action":{"type":"click","target":"保存按钮"}}',
        },
        json: {
          type: "string",
          description: "与 event 等价的 JSON 字符串（不方便传对象时使用）",
        },
      },
    },
  },
  {
    name: "veil_cancel",
    description: "请求 AI-Veil 立即结束当前接管会话（等价于用户按下中止热键）。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "要中止的会话 id，留空表示当前会话" },
        reason: { type: "string", description: "中止原因，会写入中止记录" },
      },
    },
  },
];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function handle(message) {
  const { id, method, params } = message;
  if (!method) return; // 客户端对我们的响应，忽略

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case "notifications/initialized":
    case "initialized":
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        if (name === "veil_emit") {
          const event = extractEvent(args);
          appendEvent(event);
          reply(id, { content: [{ type: "text", text: `ok: ${event.event}` }], isError: false });
          return;
        }
        if (name === "veil_cancel") {
          const session = args.session_id || sessionId;
          const reason = args.reason || "MCP 客户端请求中止";
          const target = cancel(session, reason);
          reply(id, { content: [{ type: "text", text: `cancelled: ${target}` }], isError: false });
          return;
        }
        replyError(id, -32601, `未知工具 ${name}`);
      } catch (error) {
        replyError(id, -32602, String((error && error.message) || error));
      }
      return;
    }
    default:
      replyError(id, -32601, `未实现的方法 ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      log(`非法报文：${error && error.message}`);
      replyError(null, -32700, "Parse error");
    }
  }
});

process.stdin.on("end", () => {
  log("stdin 关闭，桥退出");
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  log(`未捕获异常：${error && error.stack ? error.stack : error}`);
});

log(`已启动 · inbox=${INBOX} · session=${sessionId}`);
