"use strict";
/**
 * lib/adapters/file-inbox.js —— 文件收件箱：监听 ~/.ai-veil/events.jsonl
 *
 * 任何进程只要按行追加一条 VeilEvent JSON，就能驱动 AI-Veil。
 * 行为与 Rust 版一致：
 *   - 默认从文件末尾开始（不回放历史），AI_VEIL_INBOX_FROM_START=1 可从头回放
 *   - 按字节切行（0x0A 不会出现在 UTF-8 多字节序列内部），半行缓存等下一批
 *   - 文件被截断/轮转时自动回到偏移 0
 *   - 路径可用 AI_VEIL_INBOX 覆盖
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseEventLine } = require("./common");

const POLL_MS = 80;
const MAX_PENDING = 1 << 20;

function create(ctx) {
  const inbox = process.env.AI_VEIL_INBOX
    ? path.resolve(process.env.AI_VEIL_INBOX)
    : path.join(ctx.home, ".ai-veil", "events.jsonl");

  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, "", "utf8");

  const fromStart = /^(1|true)$/i.test(String(process.env.AI_VEIL_INBOX_FROM_START || ""));
  let offset = fromStart ? 0 : fs.statSync(inbox).size;
  let pending = Buffer.alloc(0);
  let stopped = false;
  let timer = null;

  ctx.logger.info(`文件收件箱就绪：${inbox}（偏移 ${offset}，${fromStart ? "从头回放" : "仅新事件"}）`);

  function drainLines() {
    const out = [];
    let idx = pending.indexOf(0x0a);
    while (idx >= 0) {
      out.push(pending.subarray(0, idx).toString("utf8"));
      pending = pending.subarray(idx + 1);
      idx = pending.indexOf(0x0a);
    }
    return out;
  }

  function poll() {
    if (stopped) return;
    try {
      let size = 0;
      try {
        size = fs.statSync(inbox).size;
      } catch {
        // 文件被删掉：重建后继续
        fs.mkdirSync(path.dirname(inbox), { recursive: true });
        fs.writeFileSync(inbox, "", "utf8");
        offset = 0;
        pending = Buffer.alloc(0);
        return;
      }

      if (size < offset) {
        offset = 0;
        pending = Buffer.alloc(0);
        ctx.logger.info("收件箱被截断，读取偏移已重置为 0");
      }

      if (size > offset) {
        const length = size - offset;
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(inbox, "r");
        let read = 0;
        try {
          read = fs.readSync(fd, buffer, 0, length, offset);
        } finally {
          fs.closeSync(fd);
        }
        offset += read;
        pending = Buffer.concat([pending, buffer.subarray(0, read)]);
        if (pending.length > MAX_PENDING) pending = pending.subarray(pending.length - MAX_PENDING / 2);
      }

      for (const line of drainLines()) {
        const event = parseEventLine(line);
        if (event) ctx.emit(event);
      }
    } catch (error) {
      ctx.logger.warn(`收件箱读取失败：${error.message}`);
    }
  }

  timer = setInterval(poll, POLL_MS);

  return {
    name: "file",
    close() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      ctx.logger.info("文件收件箱适配器关闭");
    },
    sendCancel(sessionId, reason) {
      const { writeCancelMarker } = require("./common");
      const target = writeCancelMarker(ctx.home, sessionId, reason);
      ctx.logger.info(`文件收件箱收到中止：${target}`);
      return { ok: true, path: target };
    },
  };
}

module.exports = { create, inboxPath: (home) => (process.env.AI_VEIL_INBOX || path.join(home, ".ai-veil", "events.jsonl")) };
