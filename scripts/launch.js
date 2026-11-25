#!/usr/bin/env node
"use strict";
/**
 * scripts/launch.js —— 一条命令启动正式版（`npm start` 背后就是它）
 *
 * 它解决三个只在真实机器上才会遇到的坑：
 *   1. Electron 对 ELECTRON_RUN_AS_NODE 是"存在即生效"（空串也算）→ 启动前从子进程环境里删掉
 *   2. electron.exe 放在含非 ASCII 字符的路径下会 0xc0000005 → 优先选 ASCII 路径上的运行时
 *   3. 受限环境/虚拟机里 Chromium 沙箱起不来 → 默认带 --no-sandbox --disable-gpu（可用
 *      AI_VEIL_ELECTRON_FLAGS 覆盖，设为空串即恢复最严格的安全设置）
 *
 * 运行时查找顺序（找到第一个存在且在 ASCII 路径上的）：
 *   1. $ELECTRON_OVERRIDE_DIST_PATH/electron[.exe]
 *   2. ~/.ai-veil/electron-dist/electron[.exe]      ← 推荐：把运行时缓存到这里
 *   3. <项目>/node_modules/electron/dist/electron[.exe]
 *
 * 用法：
 *   npm start                     # 消费 ~/.ai-veil/events.jsonl
 *   npm start -- --adapter mock   # 回放样例事件
 *   node scripts/launch.js --adapter file --verbose
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const EXE_NAME = isWindows ? "electron.exe" : "electron";

const passthrough = process.argv.slice(2);
const verbose = passthrough.includes("--verbose");
const appArgs = passthrough.filter((a) => a !== "--verbose");

function isAscii(text) {
  return /^[\x20-\x7E]*$/.test(text);
}

function candidates() {
  const list = [];
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    list.push(path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, EXE_NAME));
  }
  // 项目内 vendor/electron（推荐：可指向 ASCII 真实目录的 junction，见 README）
  list.push(path.join(ROOT, "vendor", "electron", EXE_NAME));
  list.push(path.join(os.homedir(), ".ai-veil", "electron-dist", EXE_NAME));
  list.push(path.join(ROOT, "node_modules", "electron", "dist", EXE_NAME));
  return list;
}

/** 取真实路径（junction 会解析到目标），解析失败就退回原路径 */
function realPath(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return p;
  }
}

function describe(p) {
  const exists = fs.existsSync(p);
  // ASCII 判定必须看解析后的真实路径：junction 本身可能是 ASCII，但目标可能不是
  const real = exists ? realPath(p) : p;
  return { path: p, real, exists, ascii: isAscii(real) };
}

const found = candidates().map(describe);
const runners = found.filter((c) => c.exists);
const usable = runners.find((c) => c.ascii);

if (verbose) {
  console.log("[ai-veil] 候选运行时：");
  for (const c of found) {
    console.log(`  ${c.exists ? "✓" : "✗"} ascii=${c.ascii}  ${c.path}`);
  }
}

if (!usable) {
  console.error("[ai-veil] 找不到可用的 Electron 运行时。");
  if (runners.length === 0) {
    console.error("  → 先执行 `npm install`；或把 Electron 解压到 ~/.ai-veil/electron-dist/");
  } else {
    console.error("  → 找到的运行时都在非 ASCII 路径上，Electron 在这种路径下会崩溃（0xc0000005）。");
    console.error("  → 把运行时复制到纯 ASCII 目录，然后：");
    console.error("     set ELECTRON_OVERRIDE_DIST_PATH=C:\\electron44   (PowerShell: $env:ELECTRON_OVERRIDE_DIST_PATH='C:\\electron44')");
  }
  process.exit(1);
}

const cleanupEnv = Object.assign({}, process.env);
// 坑 1：这个变量存在就会让 Electron 退化成纯 Node
delete cleanupEnv.ELECTRON_RUN_AS_NODE;
delete cleanupEnv.ELECTRON_NO_ATTACH_CONSOLE;

const defaultFlags = "--no-sandbox --disable-gpu";
const flagsRaw = process.env.AI_VEIL_ELECTRON_FLAGS === undefined ? defaultFlags : process.env.AI_VEIL_ELECTRON_FLAGS;
const flags = flagsRaw.split(/\s+/).filter(Boolean);

const argv = [ROOT, ...flags, ...appArgs];

if (verbose || !process.env.AI_VEIL_QUIET) {
  const logDir = path.join(os.homedir(), ".ai-veil", "logs");
  console.log(`[ai-veil] 运行时：${usable.path}`);
  console.log(`[ai-veil] 参数：${argv.slice(1).join(" ")}`);
  console.log(`[ai-veil] 日志：${path.join(logDir, "ai-veil.log")}  /  ${path.join(logDir, "crash.log")}`);
}

// 后台拉起：命令立即返回，托盘是唯一入口（要停就从托盘退出）
const child = spawn(usable.path, argv, {
  cwd: ROOT,
  env: cleanupEnv,
  detached: true,
  stdio: "ignore",
  windowsHide: false,
});
child.unref();

console.log(`[ai-veil] 已启动（pid ${child.pid}），托盘图标可退出。`);
