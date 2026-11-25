"use strict";
/**
 * lib/adapters/index.js —— 适配器注册表
 *
 * 与 Rust 版接口对齐：init / recv / sendCancel / close 四件事，
 * 外面套一层统一的 Handle，让主进程只关心"启动/停止/投递中止"。
 */

const mock = require("./mock");
const fileInbox = require("./file-inbox");
const mcpStdio = require("./mcp-stdio");
const cliWrapper = require("./cli-wrapper");

const KINDS = {
  mock: { label: "回放样例事件（examples/mock-events.jsonl）", create: mock.create },
  file: { label: "文件收件箱（~/.ai-veil/events.jsonl）", create: fileInbox.create },
  mcp_stdio: { label: "MCP stdio 服务（自带 veil_emit / veil_cancel）", create: mcpStdio.create },
  cli: { label: "CLI 包装器（-- 后面接任意命令）", create: cliWrapper.create },
};
KINDS.inbox = KINDS.file;
KINDS.mcp = KINDS.mcp_stdio;

class AdapterHandle {
  constructor(kind, impl) {
    this.kind = kind;
    this.impl = impl;
    this.name = impl.name || kind;
    this.stopped = false;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.impl.close();
    } catch {
      /* 关闭失败不影响退出 */
    }
  }

  sendCancel(sessionId, reason) {
    try {
      return this.impl.sendCancel(sessionId, reason);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

/**
 * @param {string} kind mock | file | mcp_stdio | cli
 * @param {object} ctx { home, logger, emit(event), abort(reason), config(), args }
 */
function spawnAdapter(kind, ctx) {
  const entry = KINDS[String(kind || "").toLowerCase()];
  if (!entry) {
    throw new Error(`未知适配器 \`${kind}\`（可选：mock | file | mcp_stdio | cli）`);
  }
  const impl = entry.create(ctx);
  return new AdapterHandle(kind, impl);
}

function describe(kind) {
  return (KINDS[String(kind || "").toLowerCase()] || {}).label || "未知适配器";
}

module.exports = { spawnAdapter, describe, KINDS, AdapterHandle };
