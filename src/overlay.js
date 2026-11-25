// AI-Veil 遮罩前端编排入口。
// 职责：初始化 Tauri IPC、订阅后端事件、把 VeilState 映射为 CSS 变量与两个渲染层，
// 并在非 Tauri（浏览器预览）环境下用内置 demo 状态降级渲染，保证不白屏、不抛异常。

import { mountBorderLayer } from "./border/border.js";
import { mountBannerLayer } from "./banner/banner.js";
import { playFeedback, unlockAudio } from "./audio/synth.js";

const LOG_THROTTLE_MS = 2000;
const NOTICE_FADE_MS = 8000;
const ABORT_RECT_THROTTLE_MS = 100;
const FADE_OUT_MS = 250;
const RELAYOUT_DEBOUNCE_MS = 60;
const FALLBACK_FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';

/** 浏览器预览用的最小配置与状态夹具（字段与 §2 / §3 契约一致） */
const DEMO_BANNER = {
  visible: true, shape: "speech_bubble", variant: "orange", anchor: "top-center",
  offset: { x: 0, y: 24 }, size: { w: 320, h: 96 }, scale: 1, rotation: 0, opacity: 0.95, blur: 20,
  padding: { x: 18, y: 12 }, text_color: "#FFFFFF", align: "center", max_lines: 2, overflow: "ellipsis",
  font: { family: "system", size: 15, weight: 500, letter_spacing: 0.3 },
  custom: { svg_path: "", image_fit: "contain", tint: "#FF7A18" },
  animation: { idle: ["blink"], enter: "pop", duration: 0.35 }
};
const DEMO_CONFIG = {
  meta: { version: 1, theme: "orange" },
  border: {
    visible: true, scope: "fullscreen", width: 4, radius: 12, style: "solid",
    color: "#FF7A18", color_end: "#FFB347", glow: "0 0 24px rgba(255,122,24,.45)",
    animation: "breathe", animation_duration: 2, opacity: 1, inset: 0, per_event: {}
  },
  banner: DEMO_BANNER,
  text: { cancel_button: "中止" },
  sound: {
    enabled: false, volume: 0.6, throttle_ms: 800, custom_path: "",
    synth: {
      start_wave: "sine", start_freq: 660, start_dur: 0.12,
      end_wave: "sine", end_freq: 440, end_dur: 0.18,
      alert_wave: "square", alert_freq: 880, alert_dur: 0.25
    },
    events: { session_start: true, session_end: true, need_human: true, error: true, action: false }
  },
  hotkeys: { cancel: "Ctrl+Alt+Esc", toggle_visible: "Ctrl+Alt+V", next_theme: "Ctrl+Alt+T" }
};
const DEMO_STATE = {
  seq: 1, active: true, hidden: false, theme: "orange",
  session_id: "preview-001", agent: "deepseek-harness", agent_version: "0.1.0",
  mode: "takeover", event: "need_human", kind: "need_human",
  text: "需要你帮个忙 · 请输入验证码（浏览器预览模式）",
  abort_label: "中止", abort_hotkey: "Ctrl+Alt+Esc", duration_text: "9.0s",
  viewport: { w: 1280, h: 720 }, scale_factor: 1, region: { x: 0, y: 0, w: 1280, h: 720 },
  border: {
    visible: true, scope: "fullscreen", width: 6, radius: 12, style: "solid",
    color: "#FF3B30", color_end: "#FFB347", glow: "0 0 24px rgba(255,122,24,.45)",
    animation: "pulse", animation_duration: 2, opacity: 1, inset: 0,
    rect: { x: 0, y: 0, w: 1280, h: 720 }
  },
  banner: DEMO_BANNER, warnings: []
};

// kind → 声音类别；alert 类再按事件开关决定是否发声
const SOUND_KIND = { start: "start", end: "end", need_human: "alert", error: "error" };
const SOUND_GATE = { start: "session_start", end: "session_end", alert: "need_human", error: "error" };

let invoke = null;
let listen = null;
let convertFileSrc = null;
let config = null;
let state = { seq: null };
let veilRoot = null;
let borderLayerEl = null;
let bannerLayerEl = null;
let borderHandle = null;
let bannerHandle = null;
let noticeEl = null;
let noticeTimer = 0;
let fadeTimer = 0;
let relayoutTimer = 0;
let rectTimer = 0;
let pendingRect = null;
let lastRectKey = "__init__";
const assetCache = new Map();
const logThrottle = new Map();

/* ============================ 基础工具 ============================ */

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value, fallback) {
  return typeof value === "string" && value ? value : fallback;
}

function errorText(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  try {
    return String(error);
  } catch (nested) {
    return "未知错误";
  }
}

function setVar(name, value) {
  if (value === undefined || value === null || value === "") return;
  try {
    document.documentElement.style.setProperty(name, String(value));
  } catch (error) {
    // 单个变量写失败不影响其它渲染
  }
}

/** 统一容错执行：同步异常一律转为 warn（带中文上下文），不向上抛 */
function safe(fn, label) {
  try {
    return fn();
  } catch (error) {
    if (label) warn(`${label}：${errorText(error)}`);
    return undefined;
  }
}

/** 兜住可能同步抛错、也可能返回 Promise 的调用，避免未捕获的 rejection */
function settle(pending, onError) {
  if (!pending || typeof pending.catch !== "function") return pending;
  return pending.catch((error) => {
    if (typeof onError === "function") onError(error);
    return null;
  });
}

/* ============================ 警告与提示 ============================ */

function showNotice(message) {
  if (!document.body) return;
  try {
    if (!noticeEl || !noticeEl.isConnected) {
      noticeEl = document.createElement("div");
      noticeEl.id = "veil-notice";
      document.body.appendChild(noticeEl);
    }
    const raw = String(message === undefined || message === null ? "" : message);
    noticeEl.textContent = raw.length > 220 ? `${raw.slice(0, 220)}...` : raw;
    noticeEl.classList.add("is-visible");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => safe(() => noticeEl.classList.remove("is-visible")), NOTICE_FADE_MS);
  } catch (error) {
    // 提示角标只是辅助信息，失败不级联
  }
}

/** 统一警告出口：控制台 + frontend_log（同条消息 2s 内只上报一次）+ 角落提示 */
function warn(message) {
  const raw = String(message === undefined || message === null ? "未知警告" : message);
  try {
    console.warn("[AI-Veil]", raw);
  } catch (error) {
    // 忽略
  }
  showNotice(raw);
  try {
    const now = Date.now();
    if (now - (logThrottle.get(raw) || 0) < LOG_THROTTLE_MS) return;
    logThrottle.set(raw, now);
    if (invoke) settle(invoke("frontend_log", { level: "warn", message: raw }));
  } catch (error) {
    // 日志上报失败不能影响渲染
  }
}

/* ============================ IPC 与会话 ============================ */

function initTauri() {
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") return false;
  invoke = tauri.core.invoke.bind(tauri.core);
  convertFileSrc = typeof tauri.core.convertFileSrc === "function" ? tauri.core.convertFileSrc.bind(tauri.core) : null;
  listen = tauri.event && typeof tauri.event.listen === "function" ? tauri.event.listen.bind(tauri.event) : null;
  return true;
}

async function invokeSafe(command, args) {
  if (!invoke) return null;
  try {
    return await invoke(command, args || {});
  } catch (error) {
    warn(`调用 ${command} 失败：${errorText(error)}`);
    return null;
  }
}

/* ============================ 素材加载 ============================ */

async function loadAsset(path) {
  const key = String(path === undefined || path === null ? "" : path);
  if (!key) return null;
  if (assetCache.has(key)) return assetCache.get(key);
  if (!invoke) {
    assetCache.set(key, null);
    return null;
  }
  const result = await invokeSafe("load_asset", { path: key });
  const ok = Boolean(result && result.ok === true);
  assetCache.set(key, ok ? result : null);
  if (!ok) warn(`素材加载失败：${key}${result && result.error ? `（${result.error}）` : ""}`);
  return ok ? result : null;
}

const assets = {
  /** 读 SVG 文本，交给形状自行 sanitize / 内联 */
  async svg(path) {
    const result = await loadAsset(path);
    return result && typeof result.text === "string" && result.text ? result.text : null;
  },
  /** 读图片 / 音频 URL：优先用后端给好的 data_url，其次 convertFileSrc */
  async imageUrl(path) {
    const result = await loadAsset(path);
    if (result && typeof result.data_url === "string" && result.data_url) return result.data_url;
    if (!convertFileSrc) return null;
    return safe(() => convertFileSrc(String(path || "")), "convertFileSrc 失败") || null;
  }
};

/* ============================ 中止通道 ============================ */

function sendAbortRect(rect) {
  if (!invoke) return;
  settle(safe(() => invoke("report_abort_rect", { rect: rect || null })));
}

/** banner.js 每次布局后回传按钮矩形；100ms 节流 + 值不变不重复发送 */
function onAbortRect(rect) {
  safe(() => {
    const normalized = rect && Number.isFinite(Number(rect.x))
      ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }
      : null;
    const key = normalized ? `${normalized.x},${normalized.y},${normalized.w},${normalized.h}` : "null";
    if (key === lastRectKey) return;
    lastRectKey = key;
    pendingRect = normalized;
    clearTimeout(rectTimer);
    rectTimer = setTimeout(() => sendAbortRect(pendingRect), ABORT_RECT_THROTTLE_MS);
  }, "中止矩形归一化失败");
}

function requestAbort(reason) {
  if (!invoke) {
    console.warn("[AI-Veil] 预览模式：忽略中止请求");
    return;
  }
  settle(safe(() => invoke("abort", { reason: String(reason || "unknown") })), (error) =>
    warn(`中止请求失败：${errorText(error)}`)
  );
}

/* ============================ CSS 变量与主题 ============================ */

function applyCssVars(current) {
  const st = current || {};
  const border = st.border || (config && config.border) || {};
  const banner = st.banner || (config && config.banner) || {};
  const font = banner.font || {};
  const anim = num(banner.animation && banner.animation.duration, 0.35);
  const vars = [
    ["--v-border-color", border.color],
    ["--v-border-color-end", border.color_end],
    ["--v-border-width", `${num(border.width, 4)}px`],
    ["--v-border-radius", `${num(border.radius, 12)}px`],
    ["--v-border-glow", border.glow],
    ["--v-border-opacity", num(border.opacity, 1)],
    ["--v-border-visible", border.visible === false ? 0 : 1],
    ["--v-border-dur", `${Math.max(0.05, num(border.animation_duration, 2))}s`],
    ["--v-banner-opacity", num(banner.opacity, 0.95)],
    ["--v-banner-blur", `${num(banner.blur, 20)}px`],
    ["--v-text-color", banner.text_color],
    ["--v-text-align", banner.align],
    ["--v-font-family", !font.family || font.family === "system" ? FALLBACK_FONT : String(font.family)],
    ["--v-font-size", `${num(font.size, 15)}px`],
    ["--v-font-weight", num(font.weight, 500)],
    ["--v-font-spacing", `${num(font.letter_spacing, 0.3)}px`],
    ["--v-anim-dur", `${anim}s`],
    ["--v-enter-dur", `${anim}s`]
  ];
  for (const [name, value] of vars) setVar(name, value);
}

function applyTheme(current) {
  const theme = text(current && current.theme, text(config && config.meta && config.meta.theme, "orange"));
  safe(() => {
    document.body.dataset.theme = theme;
  }, "切换主题失败");
}

/* ============================ 图层管理 ============================ */

/** 销毁句柄并移除图层节点；border === null / banner === null 时靠它把节点整个摘掉 */
function disposeLayer(which) {
  const handle = which === "border" ? borderHandle : bannerHandle;
  const el = which === "border" ? borderLayerEl : bannerLayerEl;
  if (handle) safe(() => handle.destroy(), `销毁 ${which} 层失败`);
  if (el && el.parentNode) safe(() => el.parentNode.removeChild(el), `移除 #${which}-layer 失败`);
  if (which === "border") {
    borderHandle = null;
    borderLayerEl = null;
  } else {
    bannerHandle = null;
    bannerLayerEl = null;
  }
}

/** 需要时重建图层节点：边框层插到 #veil-root 首位，横幅层放最后（位于边框之上） */
function createLayer(which) {
  if (!veilRoot) return null;
  const el = document.createElement("div");
  el.id = `${which}-layer`;
  const inserted = safe(() => {
    if (which === "border") veilRoot.insertBefore(el, veilRoot.firstChild);
    else veilRoot.appendChild(el);
    return true;
  }, `插入 #${which}-layer 失败`);
  if (!inserted) return null;
  if (which === "border") borderLayerEl = el;
  else bannerLayerEl = el;
  return el;
}

function liveLayer(which) {
  const el = which === "border" ? borderLayerEl : bannerLayerEl;
  return el && el.isConnected ? el : createLayer(which);
}

function renderBorder(current) {
  if (!current || current.border === null) {
    if (borderHandle) safe(() => borderHandle.clear(), "清空边框失败");
    disposeLayer("border");
    return;
  }
  const layer = liveLayer("border");
  if (!layer) return;
  if (!borderHandle) {
    const created = safe(() => mountBorderLayer(layer), "挂载边框层失败");
    if (!created) return;
    borderHandle = created;
  }
  safe(() => borderHandle.update(current), "更新边框失败");
}

function bannerCtx() {
  return {
    assets,
    warn,
    onAbortRect,
    // 形状（如 custom_svg）读取素材上限时需要实时配置，故提供取值函数而不是快照
    getConfig: () => config,
    abortLabel: () => text(state.abort_label, text(config && config.text && config.text.cancel_button, "中止")),
    hotkey: () => text(state.abort_hotkey, text(config && config.hotkeys && config.hotkeys.cancel, "Ctrl+Alt+Esc"))
  };
}

function renderBanner(current) {
  if (!current || current.banner === null) {
    if (bannerHandle) safe(() => bannerHandle.clear(), "清空横幅失败");
    disposeLayer("banner");
    return;
  }
  const layer = liveLayer("banner");
  if (!layer) return;
  if (!bannerHandle) {
    const created = safe(() => mountBannerLayer(layer, bannerCtx()), "挂载横幅层失败");
    if (!created) return;
    bannerHandle = created;
  }
  safe(() => bannerHandle.update(current, config || {}), "更新横幅失败");
}

function clearVisuals() {
  renderBorder(null);
  renderBanner(null);
  onAbortRect(null);
}

function setHidden(hidden) {
  if (!veilRoot) return;
  safe(() => {
    veilRoot.classList.toggle("veil-hidden", hidden === true);
    if (hidden === true) {
      // 隐藏时取消可能的淡出流程，避免两个状态互相打架
      clearTimeout(fadeTimer);
      veilRoot.classList.remove("veil-fading");
    }
  }, "切换隐藏状态失败");
}

/* ============================ 状态渲染 ============================ */

function maybePlaySound(prev, next) {
  safe(() => {
    const kind = next && next.kind;
    // 后端（Rust）已经把 sound.enabled / sound.events / 免打扰 / 静音覆盖 / 最小接管时长
    // 全部算完，字段存在时以它为准：null 表示"这次不该响"，必须尊重，不能自己再推断。
    const hasBackendSound = Boolean(next) && Object.prototype.hasOwnProperty.call(next, "sound");
    const soundKind = hasBackendSound ? next.sound || null : SOUND_KIND[kind];
    if (!soundKind) return;
    if (prev && prev.kind === kind && (prev.sound || null) === (next.sound || null)) return;
    if (!hasBackendSound) {
      const events = (config && config.sound && config.sound.events) || {};
      const gate = SOUND_GATE[soundKind];
      if (gate && events[gate] === false) return;
    }
    settle(playFeedback(soundKind, (config && config.sound) || {}, assets));
  }, "播放反馈音失败");
}

/**
 * 应用一份完整 VeilState：seq 去重 → 主题 → CSS 变量 → 两个图层的增删与更新。
 * active === false 先淡出再清理；hidden === true 清空视觉但保留窗口。
 */
function applyState(next) {
  if (!next || typeof next !== "object") {
    warn("收到非法的 state 载荷");
    return;
  }
  if (next.seq !== undefined && next.seq !== null && next.seq === state.seq) return;

  const prev = state;
  state = next;
  applyTheme(next);
  applyCssVars(next);

  if (next.hidden === true) {
    setHidden(true);
    clearVisuals();
    maybePlaySound(prev, next);
    return;
  }
  setHidden(false);

  if (next.active === false) {
    safe(() => veilRoot.classList.add("veil-fading"));
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      clearVisuals();
      // 清理后复位淡出状态，避免窗口永久停在 opacity:0
      safe(() => veilRoot.classList.remove("veil-fading"));
    }, FADE_OUT_MS);
    maybePlaySound(prev, next);
    return;
  }

  clearTimeout(fadeTimer);
  safe(() => veilRoot.classList.remove("veil-fading"));
  renderBorder(next);
  renderBanner(next);
  maybePlaySound(prev, next);
}

function applyConfig(next) {
  if (!next || typeof next !== "object") return;
  config = next;
  applyTheme(state);
  applyCssVars(state);
  if (state && state.seq !== undefined && state.seq !== null) {
    renderBorder(state);
    renderBanner(state);
  }
}

/* ============================ 事件订阅 ============================ */

function handleNotice(payload) {
  const message = payload && payload.message ? String(payload.message) : "";
  if (!message) return;
  const level = payload && payload.level ? String(payload.level) : "info";
  if (level === "warn" || level === "error") warn(message);
  else showNotice(message);
}

function handleAbort(payload) {
  console.warn("[AI-Veil] 收到中止事件：", (payload && payload.reason) || "unknown");
  clearVisuals();
}

function subscribe() {
  if (!listen) return;
  const handlers = [
    ["veil://state", applyState],
    ["veil://config", applyConfig],
    ["veil://notice", handleNotice],
    ["veil://abort", handleAbort]
  ];
  for (const [name, handler] of handlers) {
    const pending = safe(
      () =>
        listen(name, (event) => {
          try {
            handler(event && event.payload);
          } catch (error) {
            warn(`处理事件 ${name} 失败：${errorText(error)}`);
          }
        }),
      `订阅 ${name} 失败`
    );
    settle(pending, (error) => warn(`订阅 ${name} 失败：${errorText(error)}`));
  }
}

/* ============================ 尺寸变化与键盘 ============================ */

function relayout() {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => {
    if (!state || state.seq === undefined || state.seq === null) return;
    if (borderHandle && state.border) safe(() => borderHandle.update(state), "重排边框失败");
    if (bannerHandle && state.banner) safe(() => bannerHandle.update(state, config || {}), "重排横幅失败");
  }, RELAYOUT_DEBOUNCE_MS);
}

function installDomListeners() {
  window.addEventListener("resize", relayout, { passive: true });
  if (window.visualViewport) {
    safe(() => {
      window.visualViewport.addEventListener("resize", relayout, { passive: true });
      window.visualViewport.addEventListener("scroll", relayout, { passive: true });
    }, "监听 visualViewport 失败");
  }

  // 首次用户手势解锁音频（预览模式下这些事件不触发也无妨）
  document.addEventListener("pointerdown", () => unlockAudio(), { once: true, passive: true });
  document.addEventListener("keydown", () => unlockAudio(), { once: true });

  // 兜底热键：窗口不抢焦点时热键由 Rust 侧全局热键处理，这里只在能收到键盘事件时补一刀
  document.addEventListener("keydown", (event) => {
    if (event && event.key === "Escape" && event.ctrlKey && event.altKey) {
      event.preventDefault();
      requestAbort("keydown fallback");
    }
  });

  const flushRect = () => {
    clearTimeout(rectTimer);
    sendAbortRect(null);
  };
  window.addEventListener("beforeunload", flushRect);
  window.addEventListener("pagehide", flushRect);
}

/* ============================ 启动 ============================ */

async function boot() {
  veilRoot = document.getElementById("veil-root");
  if (!veilRoot) {
    console.warn("[AI-Veil] 缺少 #veil-root 节点，遮罩无法渲染");
    return;
  }
  borderLayerEl = document.getElementById("border-layer");
  bannerLayerEl = document.getElementById("banner-layer");

  const tauriReady = initTauri();
  installDomListeners();

  if (!tauriReady) {
    console.warn("[AI-Veil] 未检测到 window.__TAURI__，进入浏览器预览降级模式");
    config = DEMO_CONFIG;
    applyState(DEMO_STATE);
    return;
  }

  subscribe();
  const remoteConfig = await invokeSafe("get_config");
  config = remoteConfig && typeof remoteConfig === "object" ? remoteConfig : DEMO_CONFIG;
  applyTheme(state);

  const remoteState = await invokeSafe("get_state");
  applyState(remoteState && typeof remoteState === "object" ? remoteState : Object.assign({}, DEMO_STATE, { seq: 0 }));
}

/** 调试入口：控制台可直接调 window.__VEIL_DEV__.applyState(...) 验证渲染 */
window.__VEIL_DEV__ = {
  applyState,
  getState() {
    return state;
  }
};

const bootFailed = (error) => warn(`初始化失败：${errorText(error)}`);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => boot().catch(bootFailed), { once: true });
} else {
  boot().catch(bootFailed);
}
