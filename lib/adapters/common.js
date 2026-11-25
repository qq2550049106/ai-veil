"use strict";
/**
 * lib/adapters/common.js —— 适配器共用的小工具
 */

const fs = require("node:fs");
const path = require("node:path");

/** 解析一行 JSONL 事件；空行/注释/非法 JSON 一律返回 null（永不抛错） */
function parseEventLine(line) {
  const text = String(line || "").trim();
  if (!text || text.startsWith("#") || text.startsWith("//")) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const value = JSON.parse(text.slice(start));
    if (!value || typeof value !== "object" || !value.event) return null;
    return value;
  } catch {
    return null;
  }
}

/** 把中止信号落盘为可观测记录（Agent 卡死时也能留痕，外部进程可轮询） */
function writeCancelMarker(home, sessionId, reason) {
  const dir = path.join(home, ".ai-veil", "cancel");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = String(sessionId || "unknown").replace(/[^\w-]/g, "_");
  const target = path.join(dir, `cancel-${safe}-${stamp}.json`);
  fs.writeFileSync(
    target,
    JSON.stringify({ session_id: sessionId, reason: String(reason || ""), ts: Date.now() }),
    "utf8"
  );
  return target;
}

/** 事件落盘（供 MCP / 桥之外的工具写入） */
function appendEventFile(home, event) {
  const dir = path.join(home, ".ai-veil");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "events.jsonl");
  fs.appendFileSync(target, JSON.stringify(event) + "\n", "utf8");
  return target;
}

module.exports = { parseEventLine, writeCancelMarker, appendEventFile };
