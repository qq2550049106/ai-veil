"use strict";
/**
 * lib/log.js —— 极简文件日志（追加写 ~/.ai-veil/logs/ai-veil.log，同时打 stderr）
 * 任何写盘失败都静默：日志不能反过来影响主流程。
 */

const fs = require("node:fs");
const path = require("node:path");

class Logger {
  constructor(dir) {
    this.path = path.join(dir, "ai-veil.log");
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
    } catch {
      /* 目录建不出来也不要崩 */
    }
  }

  write(level, message) {
    const stamp = new Date().toTimeString().slice(0, 8);
    const line = `[${stamp}] [${String(level).toUpperCase()}] ${String(message).replace(/\n/g, " ⏎ ")}\n`;
    try {
      process.stderr.write(line);
    } catch {
      /* stderr 被关掉也继续 */
    }
    try {
      fs.appendFileSync(this.path, line, "utf8");
    } catch {
      /* 磁盘满/权限问题：忽略 */
    }
  }

  info(message) {
    this.write("info", message);
  }

  warn(message) {
    this.write("warn", message);
  }

  error(message) {
    this.write("error", message);
  }
}

module.exports = { Logger };
