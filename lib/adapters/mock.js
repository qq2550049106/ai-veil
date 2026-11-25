"use strict";
/**
 * lib/adapters/mock.js —— 回放 examples/mock-events.jsonl
 *
 * 用途：不接任何 Agent 也能看到完整效果。时间轴按原 ts 差值压缩（单项最长 2.5s），
 * 这样一段"真实"的接管过程几十秒内就能走完。
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseEventLine } = require("./common");

const MAX_GAP_MS = 2500;
const DEFAULT_GAP_MS = 1200;

function create(ctx) {
  let stopped = false;
  let timer = null;
  let index = 0;
  let events = [];

  const file =
    process.env.AI_VEIL_MOCK_FILE && process.env.AI_VEIL_MOCK_FILE.trim()
      ? path.resolve(process.env.AI_VEIL_MOCK_FILE)
      : path.join(__dirname, "..", "..", "examples", "mock-events.jsonl");
  const speed = Math.max(0.05, Number(process.env.AI_VEIL_MOCK_SPEED) || 1);
  const loop = /^(1|true)$/i.test(String(process.env.AI_VEIL_MOCK_LOOP || ""));

  try {
    const text = fs.readFileSync(file, "utf8");
    events = text
      .split(/\r?\n/)
      .map((line) => parseEventLine(line))
      .filter(Boolean);
  } catch (error) {
    ctx.logger.warn(`读取样例事件失败：${error.message}`);
    events = [];
  }

  function schedule() {
    if (stopped) return;
    if (index >= events.length) {
      if (loop && events.length) {
        index = 0;
        ctx.logger.info("回放循环：从头再来");
      } else {
        ctx.logger.info("回放结束（可再次 start_adapter mock 重放）");
        return;
      }
    }
    const current = events[index];
    const previous = index > 0 ? events[index - 1] : null;
    const gap = previous && current.ts && previous.ts ? Math.max(0, current.ts - previous.ts) : DEFAULT_GAP_MS;
    const delay = Math.min(gap || DEFAULT_GAP_MS, MAX_GAP_MS) / speed;

    timer = setTimeout(() => {
      if (stopped) return;
      index += 1;
      ctx.emit(current);
      schedule();
    }, delay);
  }

  ctx.logger.info(`回放样例事件：${events.length} 条（${path.basename(file)}，倍速 ${speed}x${loop ? "，循环" : ""}）`);
  // 首条立刻发，让用户马上看到反馈
  if (events.length) {
    const first = events[0];
    index = 1;
    setImmediate(() => {
      if (!stopped) ctx.emit(first);
    });
  }
  schedule();

  return {
    name: "mock",
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    sendCancel(sessionId, reason) {
      // 回放模式下"中止"= 停止回放（没有真实 Agent 可以通知）
      ctx.logger.info(`回放模式收到中止：${sessionId} / ${reason}`);
      return { ok: true, note: "回放模式已停止" };
    },
  };
}

module.exports = { create };
