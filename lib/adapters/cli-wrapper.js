"use strict";
/**
 * lib/adapters/cli-wrapper.js —— 包装任意命令行 Agent，不改它的代码
 *
 * 用法：ai-veil --adapter cli -- <命令> [参数...]
 * 解析规则（与 Rust 版一致）：
 *   1. 一行是合法 JSON（含 event 字段）→ 直接当事件
 *   2. 含 click/点击 → action.before(click)；type/输入 → type；scroll/滚动 → scroll；
 *      screenshot/截图 → screenshot；launch/打开/启动 → launch
 *   3. 含 error/失败/异常 → error 事件
 *   4. 子进程退出 → session.end
 */

const { spawn } = require("node:child_process");
const { parseEventLine } = require("./common");

const PATTERNS = [
  { re: /\b(click|tap)\b|点击|单击/i, type: "click" },
  { re: /\b(type|typing)\b|输入|键入/i, type: "type" },
  { re: /\bscroll\b|滚动/i, type: "scroll" },
  { re: /\b(screenshot|capture)\b|截图|截屏/i, type: "screenshot" },
  { re: /\b(launch|open|start)\b|打开|启动/i, type: "launch" },
];
const ERROR_RE = /\b(error|fail(ed|ure)?)\b|失败|异常|错误/i;

function create(ctx) {
  const args = Array.isArray(ctx.args) ? ctx.args.slice() : [];
  if (!args.length) throw new Error("--adapter cli 需要在 `--` 之后给出要包装的命令，例如：ai-veil --adapter cli -- node agent.js");

  const [command, ...rest] = args;
  const sessionId = `cli-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  let stopped = false;
  let bufferOut = "";
  let bufferErr = "";
  let child = null;

  ctx.logger.info(`CLI 包装器启动：${command} ${rest.join(" ")}`);

  function emitText(text, stream) {
    const line = String(text || "").trim();
    if (!line) return;
    const asEvent = parseEventLine(line);
    if (asEvent) {
      ctx.emit(Object.assign({ session_id: sessionId, agent: { name: `cli:${command}`, version: "unknown" } }, asEvent));
      return;
    }
    if (ERROR_RE.test(line)) {
      ctx.emit({
        event: "error",
        ts: Date.now(),
        session_id: sessionId,
        agent: { name: `cli:${command}`, version: "unknown" },
        action: { type: "other", target: line.slice(0, 160) },
      });
      return;
    }
    const hit = PATTERNS.find((p) => p.re.test(line));
    if (hit) {
      ctx.emit({
        event: "action.before",
        ts: Date.now(),
        session_id: sessionId,
        agent: { name: `cli:${command}`, version: "unknown" },
        action: { type: hit.type, target: line.slice(0, 160) },
      });
    } else if (stream === "stderr") {
      ctx.logger.info(`[cli:stderr] ${line}`);
    }
  }

  function feed(stream, chunk) {
    const key = stream === "stdout" ? "bufferOut" : "bufferErr";
    const merged = (stream === "stdout" ? bufferOut : bufferErr) + chunk;
    const parts = merged.split(/\r?\n/);
    const tail = parts.pop();
    if (stream === "stdout") bufferOut = tail;
    else bufferErr = tail;
    for (const part of parts) emitText(part, stream);
    void key;
  }

  try {
    child = spawn(command, rest, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
  } catch (error) {
    throw new Error(`无法启动被包装的命令：${error.message}`);
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => feed("stdout", chunk));
  child.stderr.on("data", (chunk) => feed("stderr", chunk));

  ctx.emit({
    event: "session.start",
    ts: Date.now(),
    session_id: sessionId,
    agent: { name: `cli:${command}`, version: "unknown" },
    mode: "takeover",
    action: { type: "launch", target: `${command} ${rest.join(" ")}`.trim() },
  });

  child.on("error", (error) => {
    ctx.logger.warn(`CLI 包装器进程错误：${error.message}`);
    ctx.emit({
      event: "error",
      ts: Date.now(),
      session_id: sessionId,
      agent: { name: `cli:${command}`, version: "unknown" },
      action: { type: "other", target: error.message },
    });
  });

  child.on("exit", (code, signal) => {
    if (bufferOut.trim()) emitText(bufferOut, "stdout");
    if (bufferErr.trim()) emitText(bufferErr, "stderr");
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    ctx.logger.info(`CLI 包装器退出：code=${code} signal=${signal} 用时=${seconds}s`);
    if (!stopped) {
      ctx.emit({
        event: "session.end",
        ts: Date.now(),
        session_id: sessionId,
        agent: { name: `cli:${command}`, version: "unknown" },
        action: { type: "other", target: `进程退出 code=${code}` },
      });
    }
  });

  return {
    name: "cli",
    close() {
      stopped = true;
      if (child && !child.killed && child.exitCode === null) {
        try {
          child.kill();
        } catch {
          /* 已经退出 */
        }
      }
    },
    sendCancel(sessionIdToCancel, reason) {
      const { writeCancelMarker } = require("./common");
      const target = writeCancelMarker(ctx.home, sessionIdToCancel, reason);
      if (child && child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* 忽略 */
        }
      }
      return { ok: true, path: target, note: "已向子进程发 SIGTERM" };
    },
  };
}

module.exports = { create };
