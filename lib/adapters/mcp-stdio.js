"use strict";
/**
 * lib/adapters/mcp-stdio.js —— AI-Veil 自带的 MCP stdio 服务器
 *
 * 这是"方式 A：MCP 工具直连"的实现：AI-Veil 自己就是 MCP server，
 * 宿主（Claude Desktop / Kimi / 任意 MCP 客户端）把它当子进程拉起，
 * 通过 tools/call 上报事件，不需要中间桥、也不需要文件。
 *
 * 协议：JSON-RPC 2.0，一行一条报文，stdout 只输出协议数据，日志走 stderr。
 */

const { writeCancelMarker } = require("./common");

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "veil_emit",
    description:
      "向 AI-Veil 上报一条接管事件，让用户在屏幕上看到横幅/边框、听到提示音、收到桌面通知。开始接管、每次动作前后、需要人工介入、出错、结束都应调用；长任务每 25 秒发一次 heartbeat 续期。",
    inputSchema: {
      type: "object",
      properties: {
        event: { type: "object", description: 'VeilEvent 对象，例如 {"event":"action.before","action":{"type":"click","target":"保存按钮"}}' },
        json: { type: "string", description: "与 event 等价的 JSON 字符串" },
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

function normalize(input, fallbackSession) {
  const event = Object.assign({}, input);
  if (!event.event || typeof event.event !== "string" || !event.event.trim()) throw new Error("缺少 event 字段");
  event.event = event.event.trim();
  if (!event.ts || typeof event.ts !== "number") event.ts = Date.now();
  if (!event.session_id) event.session_id = fallbackSession;
  if (!event.agent || typeof event.agent !== "object") event.agent = { name: "mcp-client", version: "unknown" };
  if (!event.mode) event.mode = "takeover";
  return event;
}

function create(ctx) {
  const sessionId = `mcp-${Date.now().toString(36)}`;
  let stopped = false;
  let buffer = "";

  ctx.logger.info("MCP stdio 服务器已启动（tools: veil_emit / veil_cancel）");

  function send(payload) {
    if (stopped) return;
    try {
      process.stdout.write(JSON.stringify(payload) + "\n");
    } catch {
      /* 宿主关掉了管道 */
    }
  }

  function reply(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }

  function replyError(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function handle(message) {
    const { id, method, params } = message || {};
    if (!method) return;
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ai-veil", version: require("../../package.json").version },
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
            let event;
            if (args.event && typeof args.event === "object") event = normalize(args.event, sessionId);
            else if (typeof args.event === "string") event = normalize(JSON.parse(args.event), sessionId);
            else if (typeof args.json === "string") event = normalize(JSON.parse(args.json), sessionId);
            else event = normalize(args, sessionId);
            ctx.emit(event);
            reply(id, { content: [{ type: "text", text: `ok: ${event.event}` }], isError: false });
            return;
          }
          if (name === "veil_cancel") {
            const target = args.session_id || sessionId;
            const reason = args.reason || "MCP 客户端请求中止";
            const marker = writeCancelMarker(ctx.home, target, reason);
            if (ctx.abort) ctx.abort(reason);
            reply(id, { content: [{ type: "text", text: `cancelled: ${marker}` }], isError: false });
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

  const onData = (chunk) => {
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
        ctx.logger.warn(`MCP 收到非法报文：${error.message}`);
        replyError(null, -32700, "Parse error");
      }
    }
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);

  return {
    name: "mcp_stdio",
    close() {
      stopped = true;
      process.stdin.removeListener("data", onData);
    },
    sendCancel(sessionIdToCancel, reason) {
      const target = writeCancelMarker(ctx.home, sessionIdToCancel, reason);
      return { ok: true, path: target, note: "MCP 通道：已留痕，客户端可见 tools/call 返回" };
    },
  };
}

module.exports = { create, TOOLS };
