"use strict";
/**
 * main.js —— AI-Veil 主进程（Electron 版）
 *
 * 对应 Tauri 版的 main.rs + overlay.rs：
 *   - 遮罩窗口（透明/置顶/不抢焦点/鼠标穿透，仅中止按钮可点）
 *   - 托盘（按状态着色，运行时绘制图标）
 *   - 全局热键（中止 / 显隐 / 换主题）
 *   - 22 个 IPC 命令（名字与参数与 Tauri 版逐一对应，前端零改动）
 *   - 120ms 心跳推送 + 500ms 配置轮询
 *   - 适配器：mock / file / mcp_stdio / cli
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, globalShortcut, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 最早的崩溃兜底：必须放在所有业务 require 之前。
// 主进程崩溃时窗口/托盘都没了，用户只剩"程序闪退"这一个信息——这里把栈落到文件里。
(function installCrashTrap() {
  const dir = path.join(os.homedir(), ".ai-veil", "logs");
  const file = path.join(dir, "crash.log");
  const write = (label, err) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const detail = err && err.stack ? err.stack : String(err);
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${label}\n${detail}\n\n`, "utf8");
    } catch {
      /* 连日志都写不了就只能放弃 */
    }
  };
  process.on("uncaughtException", (err) => write("uncaughtException", err));
  process.on("unhandledRejection", (err) => write("unhandledRejection", err));
})();

const { Logger } = require("./lib/log");
const { ConfigStore, nowMs } = require("./lib/config");
const { EventBus, buildState, idleState } = require("./lib/event-bus");
const { AssetStore } = require("./lib/assets");
const { makeTrayPng } = require("./lib/tray-icons");
const notify = require("./lib/notify");
const { spawnAdapter, describe } = require("./lib/adapters");

/* ============================ 常量与路径 ============================ */

const HOME = os.homedir();
const APP_ROOT = __dirname;
const PATHS = {
  home: HOME,
  root: APP_ROOT,
  logDir: path.join(HOME, ".ai-veil", "logs"),
  config: path.join(HOME, ".ai-veil", "config.toml"),
  inbox: process.env.AI_VEIL_INBOX || path.join(HOME, ".ai-veil", "events.jsonl"),
  assets: path.join(HOME, ".ai-veil", "assets"),
  cancel: path.join(HOME, ".ai-veil", "cancel"),
  icon: path.join(APP_ROOT, "assets", "icons", "icon.png"),
  iconSmall: path.join(APP_ROOT, "assets", "icons", "32x32.png"),
};

const TICK_MS = 120;
const CONFIG_POLL_MS = 500;
const HIT_POLL_MS = 40;
const FADE_OUT_MS = 480;

// Electron 默认把 userData 放在 C:\Users\<user>\AppData\Roaming\ai-veil（缓存/GPU/本地存储），
// 会悄悄占掉系统盘。这里统一挪到项目内 .runtime/，随项目一起搬走。
// 必须在 app ready 之前调用。
try {
  const runtimeDir = path.join(APP_ROOT, ".runtime", "user-data");
  fs.mkdirSync(runtimeDir, { recursive: true });
  app.setPath("userData", runtimeDir);
  app.setPath("sessionData", runtimeDir);
} catch (error) {
  // 只影响缓存位置，失败不阻断启动
}

/* ============================ 进程全局状态 ============================ */

const S = {
  logger: null,
  cfgStore: null,
  bus: null,
  assets: null,
  overlay: null,
  settings: null,
  tray: null,
  adapter: null,
  adapterKind: "none",
  seq: 0,
  abortRect: null,
  lastState: null,
  lastTray: null,
  lastPublishAt: 0,
  pendingStartNotify: null,
  visualOffNotified: false,
  timers: { hit: null, tick: null, watch: null },
  quitting: false,
};

function cfg() {
  return S.cfgStore.config;
}

/* ============================ 命令行参数 ============================ */

function parseArgs(argv) {
  const out = { adapter: null, dev: false, passthrough: [] };
  const sep = argv.indexOf("--");
  const head = sep >= 0 ? argv.slice(0, sep) : argv.slice();
  out.passthrough = sep >= 0 ? argv.slice(sep + 1) : [];
  for (let i = 0; i < head.length; i++) {
    const arg = head[i];
    if (arg === "--adapter" || arg === "-a") out.adapter = head[++i] || null;
    else if (arg.startsWith("--adapter=")) out.adapter = arg.slice("--adapter=".length);
    else if (arg === "--dev") out.dev = true;
  }
  if (!out.adapter && process.env.AI_VEIL_ADAPTER) out.adapter = process.env.AI_VEIL_ADAPTER;
  return out;
}

const CLI = parseArgs(process.argv.slice(1));

/* ============================ 窗口：遮罩 ============================ */

function primaryRect() {
  const display = screen.getPrimaryDisplay();
  return { x: display.bounds.x, y: display.bounds.y, w: display.bounds.width, h: display.bounds.height, scaleFactor: display.scaleFactor };
}

function displayForRegion(region) {
  const displays = screen.getAllDisplays();
  if (!region) return screen.getPrimaryDisplay();
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const hit = displays.find(
    (d) => cx >= d.bounds.x && cx <= d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy <= d.bounds.y + d.bounds.height
  );
  return hit || screen.getPrimaryDisplay();
}

function ensureOverlay() {
  if (S.overlay && !S.overlay.isDestroyed()) return S.overlay;
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true, // 需要能接收"中止"按钮的点击；显示时用 showInactive 避免抢焦点
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(APP_ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* 某些平台不支持，忽略 */
  }
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(APP_ROOT, "src", "overlay.html"));
  win.webContents.on("did-finish-load", () => {
    S.logger.info("遮罩窗口已加载");
    if (S.lastState) win.webContents.send("veil://state", S.lastState);
  });
  // 渲染器侧诊断：前端报错时主进程日志里必须看得到，否则遮罩"白屏"无从查起
  win.webContents.on("console-message", (_event, level, message) => {
    const tag = ["debug", "info", "warn", "error"][level] || "log";
    S.logger.write(`renderer-${tag}`, String(message));
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    S.logger.error(`遮罩加载失败 ${code} ${desc} ${url}`);
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    S.logger.error(`preload 异常 ${preloadPath}: ${error && error.message}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    S.logger.error(`遮罩渲染进程崩溃：${details.reason}，将重建窗口`);
    S.overlay = null;
    if (!S.quitting) setTimeout(() => ensureOverlay(), 800);
  });
  win.on("closed", () => {
    S.overlay = null;
  });

  S.overlay = win;
  return win;
}

function placeOverlay(state) {
  const win = S.overlay;
  if (!win || win.isDestroyed()) return;
  const display = displayForRegion(state.region);
  const current = win.getBounds();
  const target = display.bounds;
  if (current.x !== target.x || current.y !== target.y || current.width !== target.width || current.height !== target.height) {
    win.setBounds(target);
  }
}

function showOverlay() {
  const win = S.overlay;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.showInactive();
}

function hideOverlay() {
  const win = S.overlay;
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(true, { forward: true });
  win.hide();
}

/* ============================ 状态推送 ============================ */

function currentDisplayMeta() {
  const display = screen.getPrimaryDisplay();
  return { display: { x: display.bounds.x, y: display.bounds.y, w: display.bounds.width, h: display.bounds.height }, scaleFactor: display.scaleFactor };
}

function publishState(state) {
  S.seq += 1;
  state.seq = S.seq;
  S.lastState = state;
  S.lastPublishAt = Date.now();

  const win = ensureOverlay();
  if (!win || win.isDestroyed()) return;

  if (!state.active) {
    win.webContents.send("veil://state", state);
    // 渲染器自己做淡出，主进程延后隐藏窗口
    const seqAtSend = state.seq;
    setTimeout(() => {
      if (S.lastState && S.lastState.seq === seqAtSend && !S.lastState.active) hideOverlay();
    }, FADE_OUT_MS);
    return;
  }

  if (state.hidden) {
    win.webContents.send("veil://state", state);
    return;
  }

  placeOverlay(state);
  showOverlay();
  win.webContents.send("veil://state", state);
}

function publishIdle() {
  const meta = currentDisplayMeta();
  publishState(idleState(cfg(), { seq: 0, hidden: S.bus.hidden, display: meta.display, scaleFactor: meta.scaleFactor }));
  setTray("idle");
}

/* ============================ 托盘 ============================ */

const TRAY_TEXT = {
  active: "AI-Veil · 接管中",
  alert: "AI-Veil · 需要你介入",
  error: "AI-Veil · 操控异常",
  visual_off: "AI-Veil · 视觉反馈已全部关闭",
  idle: "AI-Veil · 待机",
};

function trayImage(state) {
  try {
    return nativeImage.createFromBuffer(makeTrayPng(state, 32));
  } catch (error) {
    S.logger.warn(`托盘图标生成失败：${error.message}`);
    return nativeImage.createFromPath(PATHS.iconSmall);
  }
}

function setTray(state) {
  if (S.lastTray === state) return;
  S.lastTray = state;
  if (!S.tray) return;
  S.tray.setImage(trayImage(state));
  S.tray.setToolTip(TRAY_TEXT[state] || TRAY_TEXT.idle);
}

function buildTray() {
  S.tray = new Tray(trayImage("idle"));
  S.tray.setToolTip(TRAY_TEXT.idle);
  const menu = Menu.buildFromTemplate([
    { label: "打开设置…", click: () => showSettings() },
    { type: "separator" },
    { label: "临时显示 / 隐藏遮罩", click: () => toggleOverlay() },
    { label: "发送演示事件（需要你介入）", click: () => previewEvent("need_human") },
    { label: "演示回放（mock 11 条事件）", click: () => startAdapter("mock") },
    { label: "停止当前适配器", click: () => stopAdapter() },
    { type: "separator" },
    { label: "打开日志目录", click: () => openPath(PATHS.logDir) },
    { label: "打开配置目录", click: () => openPath(path.dirname(PATHS.config)) },
    { type: "separator" },
    { label: "退出 AI-Veil", click: () => quitApp() },
  ]);
  S.tray.setContextMenu(menu);
  S.tray.on("double-click", () => showSettings());
}

function openPath(target) {
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    /* 忽略 */
  }
  return shell.openPath(target);
}

/* ============================ 窗口：设置 ============================ */

function showSettings() {
  if (S.settings && !S.settings.isDestroyed()) {
    S.settings.show();
    S.settings.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    title: "AI-Veil 设置",
    backgroundColor: "#0d1117",
    autoHideMenuBar: true,
    icon: PATHS.icon,
    webPreferences: {
      preload: path.join(APP_ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(APP_ROOT, "src", "settings.html"));
  win.on("closed", () => {
    S.settings = null;
  });
  S.settings = win;
}

/* ============================ 事件落地 ============================ */

function applyEvent(raw) {
  const meta = currentDisplayMeta();
  const result = S.bus.ingest(raw, cfg(), nowMs(), meta.display);
  if (!result.ok) {
    S.logger.info(`事件被忽略：${result.reason}`);
    return { ok: false, warnings: [result.reason] };
  }
  deliver(result.resolved);
  return { ok: true, warnings: [] };
}

function deliver(resolved) {
  S.logger.info(`事件=${resolved.event} 会话=${resolved.session_id} 文本=${resolved.text}`);

  for (const warning of resolved.warnings) {
    S.logger.warn(warning);
    if (S.overlay && !S.overlay.isDestroyed()) S.overlay.webContents.send("veil://notice", { level: "warn", message: warning });
  }

  // 底线：视觉全关时必须有"日志 + 一次通知 + 托盘黄色"
  if (resolved.visual_off) {
    if (!S.visualOffNotified && cfg().notify.enabled) {
      S.visualOffNotified = true;
      const r = notify.sendNotice({
        title: "AI-Veil · 视觉反馈已全部关闭",
        body: "边框与横幅都不再渲染。中止热键、桌面通知与声音仍然有效，托盘图标已转为黄色。",
        silent: false,
        iconPath: PATHS.icon,
      });
      if (r.ok) S.logger.info("已发送「视觉反馈已全部关闭」提示通知");
      else S.logger.warn(`提示通知发送失败：${r.error}`);
    }
  } else {
    S.visualOffNotified = false;
  }

  if (resolved.notify) scheduleNotification(resolved);
  else if (!resolved.active) cancelPendingStartNotify();

  const meta = currentDisplayMeta();
  const state = buildState(resolved, cfg(), {
    seq: 0,
    hidden: S.bus.hidden,
    display: meta.display,
    scaleFactor: meta.scaleFactor,
  });
  publishState(state);
  setTray(resolved.tray);
}

function cancelPendingStartNotify() {
  if (S.pendingStartNotify) {
    clearTimeout(S.pendingStartNotify);
    S.pendingStartNotify = null;
  }
}

function sendNotification(resolved) {
  const titles = {
    start: "AI-Veil · 接管开始",
    end: "AI-Veil · 操控已结束",
    need_human: "AI-Veil · 需要你介入",
    error: "AI-Veil · 操控异常",
  };
  const title = titles[resolved.kind] || "AI-Veil";
  const result = notify.sendNotice({
    title,
    body: resolved.text,
    silent: Boolean(cfg().notify.silent),
    iconPath: PATHS.icon,
  });
  if (result.ok) S.logger.info(`已发送通知：${title}`);
  else S.logger.warn(`通知失败已降级（仅遮罩与声音）：${result.error}`);

  if (cfg().notify.thumbnail) {
    notify
      .captureThumbnail(PATHS.logDir)
      .then((shot) => {
        if (shot.ok) S.logger.info(`截屏缩略图已落盘：${shot.path}（不会上传）`);
        else S.logger.warn(`缩略图失败：${shot.error}`);
      })
      .catch(() => {});
  }
}

function scheduleNotification(resolved) {
  const minMs = Number(cfg().rules.min_takeover_ms) || 0;
  if (resolved.active && resolved.kind === "start" && minMs > 0) {
    // 短会话不吵人：开始通知延迟到"最小接管时长"之后再发，期间结束就取消
    cancelPendingStartNotify();
    S.pendingStartNotify = setTimeout(() => {
      S.pendingStartNotify = null;
      if (S.bus.resolved && S.bus.resolved.active) sendNotification(resolved);
    }, minMs);
    return;
  }
  cancelPendingStartNotify();
  sendNotification(resolved);
}

/* ============================ 中止通道 ============================ */

function doAbort(reason) {
  const text = String(reason || "用户中止");
  S.logger.warn(`中止请求：${text}`);
  cancelPendingStartNotify();

  if (S.adapter) {
    const result = S.adapter.sendCancel(S.bus.resolved ? S.bus.resolved.session_id : "current", text);
    if (result && result.ok === false) S.logger.warn(`适配器中止失败：${result.error}`);
  }

  const meta = currentDisplayMeta();
  const resolved = S.bus.forceEnd(cfg(), nowMs(), meta.display, text);
  hideOverlay();
  const state = buildState(resolved, cfg(), { seq: 0, hidden: false, display: meta.display, scaleFactor: meta.scaleFactor });
  S.seq += 1;
  state.seq = S.seq;
  S.lastState = state;
  if (S.overlay && !S.overlay.isDestroyed()) S.overlay.webContents.send("veil://state", state);
  setTray("idle");
  return { ok: true };
}

function toggleOverlay() {
  const hidden = S.bus.toggleHidden();
  if (hidden) {
    hideOverlay();
    setTray("visual_off");
  } else if (S.bus.resolved && S.bus.resolved.active) {
    const meta = currentDisplayMeta();
    publishState(
      buildState(S.bus.resolved, cfg(), { seq: 0, hidden: false, display: meta.display, scaleFactor: meta.scaleFactor })
    );
  }
  return hidden;
}

/* ============================ 热键 ============================ */

function normalizeAccelerator(raw) {
  return String(raw || "")
    .split("+")
    .map((part) => {
      const key = part.trim();
      const lower = key.toLowerCase();
      if (lower === "win" || lower === "meta") return "Super";
      if (lower === "ctrl" || lower === "control") return "Control";
      if (lower === "alt" || lower === "option") return "Alt";
      if (lower === "shift") return "Shift";
      if (lower === "esc") return "Escape";
      if (lower === "return") return "Enter";
      if (lower === "space") return "Space";
      if (key.length === 1) return key.toUpperCase();
      return key.charAt(0).toUpperCase() + key.slice(1);
    })
    .join("+");
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const warnings = [];
  const list = [
    [cfg().hotkeys.cancel, () => doAbort("用户按下中止热键")],
    [cfg().hotkeys.toggle_visible, () => toggleOverlay()],
    [cfg().hotkeys.next_theme, () => cycleTheme()],
  ];
  for (const [raw, handler] of list) {
    const accelerator = normalizeAccelerator(raw);
    if (!accelerator) continue;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        try {
          handler();
        } catch (error) {
          S.logger.warn(`热键回调异常：${error.message}`);
        }
      });
      if (!ok) warnings.push(`热键 ${accelerator} 注册失败（可能被其它程序占用）`);
    } catch (error) {
      warnings.push(`热键 ${accelerator} 注册异常：${error.message}`);
    }
  }
  if (warnings.length) {
    for (const warning of warnings) S.logger.warn(warning);
    // 中止通道不可用是最严重的情况：立刻告知用户
    if (warnings.some((w) => w.includes(normalizeAccelerator(cfg().hotkeys.cancel)))) {
      notify.sendNotice({ title: "AI-Veil · 中止热键不可用", body: "注册失败，请改用托盘菜单或设置面板里的中止按钮。", iconPath: PATHS.icon });
    }
  }
  return warnings;
}

const THEME_ORDER = ["orange", "cyan", "mono", "contrast"];

function cycleTheme() {
  const current = cfg().meta.theme;
  const index = THEME_ORDER.indexOf(current);
  const next = THEME_ORDER[(index + 1) % THEME_ORDER.length];
  cfg().meta.theme = next;
  S.cfgStore.save(cfg(), S.logger);
  if (S.lastState) {
    const meta = currentDisplayMeta();
    const state = S.bus.resolved
      ? buildState(S.bus.resolved, cfg(), { seq: 0, hidden: S.bus.hidden, display: meta.display, scaleFactor: meta.scaleFactor })
      : idleState(cfg(), { seq: 0, hidden: S.bus.hidden, display: meta.display, scaleFactor: meta.scaleFactor });
    publishState(state);
  }
  return next;
}

/* ============================ 适配器 ============================ */

function stopAdapter() {
  if (S.adapter) {
    try {
      S.adapter.stop();
    } catch (error) {
      S.logger.warn(`适配器停止失败：${error.message}`);
    }
    S.adapter = null;
  }
  S.adapterKind = "none";
}

function startAdapter(kind) {
  stopAdapter();
  const normalized = String(kind || "").toLowerCase();
  if (!normalized) return { ok: true, warnings: [] };
  try {
    S.adapter = spawnAdapter(normalized, {
      home: PATHS.home,
      args: CLI.passthrough,
      logger: S.logger,
      emit: (event) => applyEvent(event),
      abort: (reason) => doAbort(reason),
    });
    S.adapterKind = normalized;
    const warnings = [];
    S.logger.info(`适配器已启动：${normalized}（${describe(normalized)}）`);
    return { ok: true, warnings };
  } catch (error) {
    S.adapterKind = "none";
    S.logger.error(`适配器启动失败：${error.message}`);
    return { ok: false, warnings: [error.message] };
  }
}

/* ============================ 演示事件 ============================ */

function demoEvent(kind) {
  const ts = nowMs();
  const agent = { name: "deepseek-harness", version: "0.1.0" };
  const base = { ts, session_id: `demo-${Date.now().toString(36)}`, agent, mode: "takeover" };
  switch (kind) {
    case "start":
      return Object.assign({}, base, {
        event: "session.start",
        scope: { type: "fullscreen" },
        action: { type: "launch", target: "演示：接管开始" },
        ttl_ms: 30000,
        cancel: { enabled: true, hotkey: cfg().hotkeys.cancel },
      });
    case "running":
      return Object.assign({}, base, {
        event: "action.before",
        scope: { type: "region", bounds: { x: 320, y: 180, w: 960, h: 640 }, display_id: 1 },
        action: { type: "click", target: "演示：点击「保存」" },
      });
    case "need_human":
      return Object.assign({}, base, {
        event: "need_human",
        scope: { type: "fullscreen" },
        action: { type: "other", target: "演示：需要你介入" },
      });
    case "error":
      return Object.assign({}, base, {
        event: "error",
        scope: { type: "fullscreen" },
        action: { type: "other", target: "演示：目标进程无响应" },
      });
    case "end":
      return Object.assign({}, base, { event: "session.end", scope: { type: "fullscreen" }, action: { type: "other", target: "演示：会话结束" } });
    default:
      return null;
  }
}

function previewEvent(kind) {
  const event = demoEvent(String(kind || "").toLowerCase());
  if (!event) {
    S.logger.warn(`未知预览类型 ${kind}`);
    return { ok: false };
  }
  applyEvent(event);
  return { ok: true };
}

/* ============================ 定时器 ============================ */

function startTimers() {
  // 命中区轮询：只有中止按钮区域可点，其余鼠标穿透
  S.timers.hit = setInterval(() => {
    const win = S.overlay;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (!S.abortRect || !S.lastState || !S.lastState.active || S.lastState.hidden) {
      win.setIgnoreMouseEvents(true, { forward: true });
      return;
    }
    try {
      const point = screen.getCursorScreenPoint();
      const bounds = win.getBounds();
      const rect = S.abortRect;
      const inside =
        point.x >= bounds.x + rect.x &&
        point.x <= bounds.x + rect.x + rect.w &&
        point.y >= bounds.y + rect.y &&
        point.y <= bounds.y + rect.y + rect.h;
      win.setIgnoreMouseEvents(!inside, { forward: true });
    } catch {
      /* 轮询失败不影响主流程 */
    }
  }, HIT_POLL_MS);

  // 120ms 心跳：TTL 兜底 + 时长文本刷新
  S.timers.tick = setInterval(() => {
    if (!S.bus.resolved || !S.bus.resolved.active) return;
    const meta = currentDisplayMeta();
    const expired = S.bus.tick(cfg(), nowMs(), meta.display);
    if (expired) {
      deliver(expired);
      return;
    }
    const state = buildState(S.bus.resolved, cfg(), {
      seq: 0,
      hidden: S.bus.hidden,
      display: meta.display,
      scaleFactor: meta.scaleFactor,
    });
    if (!S.lastState || S.lastState.duration_text !== state.duration_text) publishState(state);
  }, TICK_MS);

  // 500ms 配置轮询（自己刚写过的会因 mtime/size 一致被跳过）
  S.timers.watch = setInterval(() => {
    if (!S.cfgStore.changedExternally()) return;
    S.logger.info("检测到配置文件变化，重新加载");
    S.cfgStore.load(S.logger);
    for (const warning of S.cfgStore.warnings) S.logger.warn(warning);
    registerHotkeys();
    if (!S.bus.resolved) publishIdle();
  }, CONFIG_POLL_MS);
}

/* ============================ IPC ============================ */

function ok(extra) {
  return Object.assign({ ok: true, warnings: [] }, extra || {});
}

function registerIpc() {
  const handle = (name, fn) => {
    ipcMain.handle(`veil:${name}`, async (_event, args) => {
      try {
        return await fn(args || {});
      } catch (error) {
        S.logger.error(`IPC ${name} 失败：${error.message}`);
        return { ok: false, warnings: [error.message] };
      }
    });
  };

  handle("get_config", () => cfg());

  handle("set_config", (args) => {
    const warnings = S.cfgStore.replace(args.config || {}, S.logger);
    registerHotkeys();
    const meta = currentDisplayMeta();
    const state = S.bus.resolved
      ? buildState(S.bus.resolved, cfg(), { seq: 0, hidden: S.bus.hidden, display: meta.display, scaleFactor: meta.scaleFactor })
      : idleState(cfg(), { seq: 0, hidden: S.bus.hidden, display: meta.display, scaleFactor: meta.scaleFactor });
    publishState(state);
    return { ok: true, warnings };
  });

  handle("reset_config", () => {
    const warnings = S.cfgStore.reset(S.logger);
    registerHotkeys();
    publishIdle();
    return { ok: true, warnings };
  });

  handle("get_state", () => S.lastState || idleState(cfg(), Object.assign({ seq: 0, hidden: S.bus.hidden }, currentDisplayMeta())));

  handle("report_abort_rect", (args) => {
    const rect = args.rect;
    S.abortRect =
      rect && Number.isFinite(Number(rect.w)) && Number.isFinite(Number(rect.h))
        ? { x: Number(rect.x) || 0, y: Number(rect.y) || 0, w: Number(rect.w) || 0, h: Number(rect.h) || 0 }
        : null;
    return { ok: true };
  });

  handle("abort", (args) => doAbort(args.reason));

  handle("load_asset", (args) => S.assets.load(args.path));

  handle("import_asset", (args) => S.assets.import(args.name, args.data_base64, S.logger));

  handle("list_assets", () => S.assets.list());

  handle("export_preset", (args) => S.assets.exportPreset(cfg(), Boolean(args.inline_assets)));

  handle("import_preset", (args) => {
    const result = S.assets.readPreset(args.data);
    if (!result.ok) return { ok: false, warnings: result.warnings };
    const warnings = S.cfgStore.replace(result.config, S.logger);
    registerHotkeys();
    publishIdle();
    if (result.assets.length) warnings.push(`已恢复 ${result.assets.length} 个素材：${result.assets.join(", ")}`);
    return { ok: true, warnings };
  });

  handle("set_theme", (args) => {
    const theme = String(args.theme || "").toLowerCase();
    if (!THEME_ORDER.includes(theme)) return { ok: false, theme: cfg().meta.theme, warnings: [`主题 ${theme} 不存在`] };
    cfg().meta.theme = theme;
    S.cfgStore.save(cfg(), S.logger);
    const meta = currentDisplayMeta();
    const state = S.bus.resolved
      ? buildState(S.bus.resolved, cfg(), { seq: 0, hidden: S.bus.hidden, display: meta.display, scaleFactor: meta.scaleFactor })
      : idleState(cfg(), { seq: 0, hidden: S.bus.hidden, display: meta.display, scaleFactor: meta.scaleFactor });
    publishState(state);
    return { ok: true, theme };
  });

  handle("toggle_overlay", () => ({ ok: true, value: toggleOverlay() }));

  handle("frontend_log", (args) => {
    S.logger.write(String(args.level || "info"), String(args.message || ""));
    return { ok: true };
  });

  handle("open_logs", () => {
    openPath(PATHS.logDir);
    return { ok: true, path: PATHS.logDir };
  });

  handle("open_settings", () => {
    showSettings();
    return { ok: true };
  });

  handle("preview_event", (args) => previewEvent(args.kind));

  handle("emit_raw_event", (args) => {
    const raw = args.json_text || args.json || "";
    let event;
    try {
      event = JSON.parse(String(raw));
    } catch (error) {
      return { ok: false, warnings: [`事件 JSON 不合法：${error.message}`] };
    }
    if (!event || typeof event !== "object" || !event.event) return { ok: false, warnings: ["事件缺少 event 字段"] };
    if (!event.ts || Number(event.ts) <= 0) event.ts = nowMs();
    if (!event.session_id) event.session_id = "manual-debug";
    return applyEvent(event);
  });

  handle("start_adapter", (args) => startAdapter(args.kind));

  handle("stop_adapter", () => {
    stopAdapter();
    return { ok: true };
  });

  handle("get_audio", () => ({
    enabled: cfg().sound.enabled,
    volume: cfg().sound.volume,
    throttle_ms: cfg().sound.throttle_ms,
    custom_data_url: S.assets.audio(cfg()),
  }));

  handle("get_runtime", () => ({
    version: app.getVersion(),
    adapter: S.adapterKind,
    home: PATHS.home,
    config_path: PATHS.config,
    log_path: path.join(PATHS.logDir, "ai-veil.log"),
    warnings: S.cfgStore.warnings,
    upload_enabled: cfg().privacy.upload_enabled,
  }));
}

/* ============================ 退出 ============================ */

function quitApp() {
  S.quitting = true;
  app.quit();
}

/* ============================ 启动 ============================ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (S.settings) showSettings();
  });

  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

  app.whenReady().then(() => {
    S.logger = new Logger(PATHS.logDir);
    S.logger.info(`AI-Veil ${app.getVersion()} 启动 · Electron ${process.versions.electron} · ${process.platform}`);

    S.cfgStore = new ConfigStore(PATHS.home);
    S.cfgStore.load(S.logger);
    for (const warning of S.cfgStore.warnings) S.logger.warn(warning);

    S.bus = new EventBus();
    S.assets = new AssetStore(PATHS.home, cfg);
    S.assets.seedBuiltin(S.logger);

    registerIpc();
    buildTray();
    ensureOverlay();
    registerHotkeys();
    startTimers();
    publishIdle();

    if (CLI.adapter && CLI.adapter !== "none") {
      const result = startAdapter(CLI.adapter);
      if (!result.ok) S.logger.error(`适配器启动失败：${result.warnings.join("; ")}`);
    } else if (CLI.adapter === "none") {
      S.logger.info("--adapter none：不启动适配器，仅托盘/热键/IPC 可用");
    } else {
      // 开箱即用：双击 exe 没有任何参数时，默认消费 DSH 桥写入的事件文件
      const result = startAdapter("file");
      S.logger.info("未指定 --adapter，默认使用 file 收件箱（~/.ai-veil/events.jsonl）");
      if (!result.ok) S.logger.error(`默认适配器启动失败：${result.warnings.join("; ")}`);
    }

    if (CLI.dev && S.overlay) S.overlay.webContents.openDevTools({ mode: "detach" });
  });

  app.on("window-all-closed", () => {
    // 托盘常驻应用：窗口全关也不退出
  });

  app.on("activate", () => {
    if (S.settings) showSettings();
  });

  app.on("will-quit", () => {
    S.quitting = true;
    for (const timer of Object.values(S.timers)) if (timer) clearInterval(timer);
    cancelPendingStartNotify();
    stopAdapter();
    try {
      globalShortcut.unregisterAll();
    } catch {
      /* 忽略 */
    }
    if (S.tray) {
      try {
        S.tray.destroy();
      } catch {
        /* 忽略 */
      }
    }
  });
}
