/* AI-Veil 设置窗口主脚本：加载 Config、双向绑定表单、防抖保存并热更新、渲染右侧横幅预览。
 * 依赖：Tauri 全局 API（window.__TAURI__）与形状注册表 ./shapes/registry.js。
 * 容错：所有 IPC 调用 try/catch；缺少 __TAURI__ 时进入只读预览模式，不抛未捕获异常。
 */

import { getShape, getFallback } from "./shapes/registry.js";

const SAVE_DEBOUNCE_MS = 200;
const STATUS_MS = 2000;
const DIAG_MAX = 50;
const IGNORE = Symbol("ignore");

const THEME_NAMES = ["orange", "cyan", "mono", "contrast"];

// 4 套主题色板：预览用，与 overlay 的 CSS 变量解耦（色值同时写死在 settings.css 的 .pv-token 里）
const THEME_TOKENS = {
  orange: { label: "橙光", accent: "#FF7A18", accent2: "#FFB347", surface: "#1B1410", surfaceFg: "#FFF3E8", stroke: "rgba(255,122,24,.35)", abortBg: "#FF7A18", abortFg: "#1A1208" },
  cyan: { label: "青蓝", accent: "#22D3EE", accent2: "#38BDF8", surface: "#0B1A21", surfaceFg: "#E6FBFF", stroke: "rgba(34,211,238,.32)", abortBg: "#22D3EE", abortFg: "#04222B" },
  mono: { label: "灰阶", accent: "#C9D1D9", accent2: "#8B949E", surface: "#161B22", surfaceFg: "#F0F6FC", stroke: "rgba(201,209,217,.28)", abortBg: "#C9D1D9", abortFg: "#0B0F14" },
  contrast: { label: "高对比", accent: "#FFD400", accent2: "#FF3B30", surface: "#000000", surfaceFg: "#FFFFFF", stroke: "rgba(255,212,0,.55)", abortBg: "#FFD400", abortFg: "#000000" }
};

const SHAPE_LABELS = {
  rect: "圆角矩形",
  pill: "胶囊",
  speech_bubble: "对话气泡",
  cat: "猫咪",
  paw: "爪印",
  blob: "有机形",
  star: "五角星",
  custom_svg: "自定义 SVG",
  image: "图片"
};

const SHAPE_NAMES = ["rect", "pill", "speech_bubble", "cat", "paw", "blob", "star", "custom_svg", "image"];

// 内置兜底配置：必须与 examples/config.sample.toml 完全一致
const FALLBACK_CONFIG = {
  meta: { version: 1, theme: "orange" },
  border: {
    visible: true,
    scope: "fullscreen",
    width: 4,
    radius: 12,
    style: "solid",
    color: "#FF7A18",
    color_end: "#FFB347",
    glow: "0 0 24px rgba(255,122,24,.45)",
    animation: "breathe",
    animation_duration: 2.0,
    opacity: 1.0,
    inset: 0,
    follow_display: true,
    per_event: {
      need_human: { color: "#FF3B30", animation: "pulse", width: 6 },
      error: { color: "#FF3B30", animation: "scan" },
      heartbeat: { visible: false }
    }
  },
  banner: {
    visible: true,
    shape: "cat",
    variant: "orange",
    anchor: "top-center",
    offset: { x: 0, y: 24 },
    size: { w: 320, h: 96 },
    scale: 1.0,
    rotation: 0,
    opacity: 0.95,
    blur: 20,
    padding: { x: 18, y: 12 },
    text_color: "#FFFFFF",
    align: "center",
    max_lines: 2,
    overflow: "ellipsis",
    font: { family: "system", size: 15, weight: 500, letter_spacing: 0.3 },
    custom: { svg_path: "~/Pictures/mascot.svg", image_fit: "contain", tint: "#FF7A18" },
    animation: { idle: "blink", enter: "pop", duration: 0.35 }
  },
  text: {
    start: "{agent} 正在接管你的电脑",
    running: "{agent} 正在操控 · {action}",
    waiting: "需要你介入 · {action}",
    end: "操控已结束 · 共 {duration}",
    error: "操控异常中断 · {action}",
    cancel_button: "中止"
  },
  sound: {
    enabled: true,
    volume: 0.6,
    throttle_ms: 800,
    custom_path: "",
    synth: {
      start_wave: "sine",
      start_freq: 660,
      start_dur: 0.12,
      end_wave: "sine",
      end_freq: 440,
      end_dur: 0.18,
      alert_wave: "square",
      alert_freq: 880,
      alert_dur: 0.25
    },
    events: { session_start: true, session_end: true, need_human: true, error: true, action: false }
  },
  notify: { enabled: true, duration_sec: 5, thumbnail: false, silent: false },
  rules: {
    ttl_ms: 30000,
    min_takeover_ms: 600,
    ignore_events: ["heartbeat"],
    dnd_start: "",
    dnd_end: "",
    process_whitelist: [],
    process_blacklist: []
  },
  hotkeys: { cancel: "Ctrl+Alt+Esc", toggle_visible: "Ctrl+Alt+V", next_theme: "Ctrl+Alt+T" },
  assets: { dirs: ["~/.ai-veil/assets/"], max_bytes: 524288, max_px: 4096, sanitize_svg: true },
  privacy: { upload_enabled: false, log_dir: "~/.ai-veil/logs" }
};

const TAURI = window.__TAURI__ || null;
const invoke = TAURI && TAURI.core && typeof TAURI.core.invoke === "function" ? TAURI.core.invoke.bind(TAURI.core) : null;
const listenEvent = TAURI && TAURI.event && typeof TAURI.event.listen === "function" ? TAURI.event.listen.bind(TAURI.event) : null;
const ONLINE = typeof invoke === "function";

let cfg = clone(FALLBACK_CONFIG);
let saveTimer = 0;
let statusTimer = 0;
let saveQueue = Promise.resolve();
let lastSavedPayload = "";
let diagBound = false;
let loadError = "";

/* ---------------- 基础工具 ---------------- */

const byId = (id) => document.getElementById(id);

function clone(value) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // 含不可克隆对象时退回 JSON 深拷贝
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function describeError(err) {
  if (err === null || err === undefined) return "未知错误";
  if (typeof err === "string") return err;
  if (err.message) return String(err.message);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function getPath(root, path) {
  let cursor = root;
  const parts = String(path).split(".");
  for (const part of parts) {
    if (!isPlainObject(cursor) || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPath(root, path, value) {
  const parts = String(path).split(".");
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function deletePath(root, path) {
  const parts = String(path).split(".");
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(cursor[parts[i]])) return;
    cursor = cursor[parts[i]];
  }
  delete cursor[parts[parts.length - 1]];
}

// 逗号分隔文本 ⇄ 字符串数组
function toArray(value) {
  let list = [];
  if (Array.isArray(value)) list = value.map((item) => String(item).trim());
  else if (typeof value === "string") list = value.split(",").map((item) => item.trim());
  return list.filter((item, index) => item.length > 0 && list.indexOf(item) === index);
}

function mergeDefaults(base, incoming) {
  if (!isPlainObject(incoming)) return clone(base);
  const out = isPlainObject(base) ? clone(base) : {};
  for (const key of Object.keys(incoming)) {
    const next = incoming[key];
    if (next === null || next === undefined) continue;
    out[key] = isPlainObject(next) && isPlainObject(out[key]) ? mergeDefaults(out[key], next) : clone(next);
  }
  return out;
}

/* ---------------- 状态条与诊断 ---------------- */

function setStatus(text, kind, fadeAfterMs) {
  const node = byId("save-status");
  if (!node) return;
  node.textContent = String(text);
  node.dataset.kind = kind || "info";
  node.classList.remove("is-faded");
  window.clearTimeout(statusTimer);
  const wait = Number.isFinite(fadeAfterMs) ? fadeAfterMs : STATUS_MS;
  if (wait > 0) statusTimer = window.setTimeout(() => node.classList.add("is-faded"), wait);
}

function appendDiag(level, message) {
  const text = String(message === null || message === undefined ? "" : message);
  if (!text) return;
  const safeLevel = ["info", "warn", "error"].includes(level) ? level : "info";
  const list = byId("diag-warnings");
  if (!list) {
    console.warn("[AI-Veil 设置]", text);
    return;
  }
  const item = document.createElement("li");
  item.className = "diag-item";
  item.dataset.level = safeLevel;
  const time = document.createElement("span");
  time.className = "diag-time";
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const body = document.createElement("span");
  body.className = "diag-text";
  body.textContent = text;
  item.append(time, body);
  list.prepend(item);
  while (list.children.length > DIAG_MAX) list.removeChild(list.lastElementChild);
}

function warn(message, level) {
  const text = String(message);
  console.warn("[AI-Veil 设置]", text);
  appendDiag(level || "warn", text);
}

/* ---------------- 配置加载与规范化 ---------------- */

async function loadConfig() {
  if (!ONLINE) {
    cfg = clone(FALLBACK_CONFIG);
    return;
  }
  try {
    const remote = await invoke("get_config", {});
    cfg = mergeDefaults(FALLBACK_CONFIG, remote && typeof remote === "object" ? remote : {});
    loadError = "";
  } catch (err) {
    cfg = clone(FALLBACK_CONFIG);
    loadError = "读取配置失败 · 已使用内置默认值";
    setStatus(loadError, "error", 0);
    warn("get_config 失败：" + describeError(err), "error");
  }
}

// 待机动画聚合：0 个 → "none"，1 个 → 字符串，多个 → 数组
function collectIdleSelection() {
  const picked = Array.from(document.querySelectorAll("[data-idle]"))
    .filter((node) => node.checked)
    .map((node) => node.dataset.idle);
  if (picked.length === 0) return "none";
  if (picked.length === 1) return picked[0];
  return picked;
}

// 保存前统一处理：数组字段、idle 聚合、per_event 空值删除
function normalizeConfig() {
  const root = cfg;
  if (!isPlainObject(root.meta)) root.meta = clone(FALLBACK_CONFIG.meta);
  if (!root.meta.version) root.meta.version = 1;

  ["rules.ignore_events", "rules.process_whitelist", "rules.process_blacklist", "assets.dirs"].forEach((path) => {
    setPath(root, path, toArray(getPath(root, path)));
  });

  setPath(root, "banner.animation.idle", collectIdleSelection());

  const perEvent = getPath(root, "border.per_event");
  if (isPlainObject(perEvent)) {
    for (const name of Object.keys(perEvent)) {
      const override = perEvent[name];
      const basePath = "border.per_event." + name;
      if (!isPlainObject(override)) {
        deletePath(root, basePath);
        continue;
      }
      for (const field of Object.keys(override)) {
        const value = override[field];
        if (value === "" || value === null || value === undefined) deletePath(root, basePath + "." + field);
      }
      if (Object.keys(override).length === 0) deletePath(root, basePath);
    }
  }
  return root;
}

/* ---------------- 控件读写 ---------------- */

function readControl(node) {
  const kind = node.dataset.kind;

  if (kind === "tristate") {
    if (node.value === "true") return true;
    if (node.value === "false") return false;
    return "";
  }
  if (kind === "csv") return toArray(node.value);
  if (node.type === "checkbox") return Boolean(node.checked);

  if (node.type === "number" || node.type === "range") {
    const raw = String(node.value).trim();
    if (raw === "") return node.dataset.optional === "1" ? "" : IGNORE;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : IGNORE;
  }
  return node.value;
}

function ensureOption(select, value) {
  const text = String(value);
  const exists = Array.from(select.options).some((option) => option.value === text);
  if (exists) return;
  const option = document.createElement("option");
  option.value = text;
  option.textContent = text;
  select.appendChild(option);
}

function writeControl(node, value) {
  const kind = node.dataset.kind;

  if (kind === "tristate") {
    node.value = value === true ? "true" : value === false ? "false" : "";
    return;
  }
  if (kind === "csv") {
    node.value = toArray(value).join(", ");
    return;
  }
  if (node.type === "checkbox") {
    node.checked = Boolean(value);
    return;
  }
  if (node.type === "number" || node.type === "range") {
    node.value = value === "" || value === null || value === undefined ? "" : String(value);
    return;
  }
  if (node.tagName === "SELECT") {
    const text = value === null || value === undefined ? "" : String(value);
    if (text !== "" && text !== "none") ensureOption(node, text);
    node.value = text;
    return;
  }
  node.value = value === null || value === undefined ? "" : String(value);
}

function commitControl(node) {
  const path = node.dataset.path;
  if (!path) return;
  const value = readControl(node);
  if (value === IGNORE) return;
  setPath(cfg, path, value);
}

/* ---------------- 保存 ---------------- */

function scheduleSave() {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    save();
  }, SAVE_DEBOUNCE_MS);
}

function save() {
  saveQueue = saveQueue.then(performSave, performSave);
  return saveQueue;
}

async function performSave() {
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  normalizeConfig();

  if (!ONLINE) {
    setStatus("未连接到后端 · 改动仅本地预览", "error", 3000);
    return false;
  }

  const payload = JSON.stringify(cfg);
  if (payload === lastSavedPayload) {
    setStatus("已保存 · 热更新生效", "ok", 1200);
    return true;
  }

  try {
    const result = await invoke("set_config", { config: cfg });
    const warnings = result && Array.isArray(result.warnings) ? result.warnings : [];
    warnings.forEach((item) => warn("配置警告：" + item, "warn"));
    if (result && result.ok === false) {
      setStatus("保存被拒绝" + (warnings.length ? " · " + warnings[0] : ""), "error", 6000);
      return false;
    }
    lastSavedPayload = payload;
    setStatus("已保存 · 热更新生效", "ok", STATUS_MS);
    return true;
  } catch (err) {
    setStatus("保存失败 · " + describeError(err), "error", 6000);
    warn("set_config 失败：" + describeError(err), "error");
    return false;
  }
}

/* ---------------- 渲染：表单 / 芯片 / 色卡 / 预览 ---------------- */

function renderAll() {
  document.querySelectorAll("[data-path]").forEach((node) => {
    writeControl(node, getPath(cfg, node.dataset.path));
  });
  renderIdleCheckboxes();
  renderThemeCards();
  renderShapeChips();
  applyPreviewVars();
  renderPreview();
  updateMetaLabels();
  const theme = (cfg.meta && cfg.meta.theme) || "orange";
  document.body.dataset.theme = THEME_NAMES.includes(theme) ? theme : "orange";
}

function renderIdleCheckboxes() {
  const idleList = toArray(getPath(cfg, "banner.animation.idle"));
  document.querySelectorAll("[data-idle]").forEach((node) => {
    node.checked = idleList.includes(node.dataset.idle);
  });
}

function renderThemeCards() {
  const active = (cfg.meta && cfg.meta.theme) || "orange";
  document.querySelectorAll("[data-theme-card]").forEach((card) => {
    const name = card.dataset.themeCard;
    const isActive = name === active;
    card.classList.toggle("is-active", isActive);
    card.setAttribute("aria-pressed", isActive ? "true" : "false");
    card.title = THEME_TOKENS[name] ? THEME_TOKENS[name].label : name;
  });
}

function renderShapeChips() {
  const active = (cfg.banner && cfg.banner.shape) || "cat";
  document.querySelectorAll("[data-shape-chip]").forEach((chip) => {
    const name = chip.dataset.shapeChip;
    const isActive = name === active;
    chip.classList.toggle("is-active", isActive);
    chip.title = SHAPE_LABELS[name] || name;
  });
}

function updateMetaLabels() {
  const theme = (cfg.meta && cfg.meta.theme) || "orange";
  const shape = (cfg.banner && cfg.banner.shape) || "cat";
  const size = getPath(cfg, "banner.size") || {};
  const tokens = THEME_TOKENS[theme] || THEME_TOKENS.orange;
  const setText = (id, text) => {
    const node = byId(id);
    if (node) node.textContent = text;
  };
  setText("preview-shape", shape);
  setText("preview-theme", theme);
  setText("preview-size", `${num(size.w, 320)} × ${num(size.h, 96)}`);
  setText("diag-theme", `${theme}（${tokens.label}）`);
  setText("diag-shape", `${shape}（${SHAPE_LABELS[shape] || shape}）`);
}

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace"]);

function fontFamilyValue(family) {
  const text = String(family || "").trim();
  if (!text) return "system-ui, sans-serif";
  if (text === "system") return "system-ui, -apple-system, 'Segoe UI', sans-serif";
  if (GENERIC_FAMILIES.has(text)) return text;
  return `'${text.replace(/'/g, "")}', sans-serif`;
}

// 把主题色板与当前配置写成与 overlay 同名的 CSS 变量
function applyPreviewVars() {
  const stage = byId("preview-stage");
  if (!stage) return;
  const theme = (cfg.meta && cfg.meta.theme) || "orange";
  const tokens = THEME_TOKENS[theme] || THEME_TOKENS.orange;
  const border = getPath(cfg, "border") || {};
  const banner = getPath(cfg, "banner") || {};
  const font = banner.font || {};
  const anim = banner.animation || {};
  const set = (name, value) => stage.style.setProperty(name, String(value));

  set("--v-accent", tokens.accent);
  set("--v-accent-2", tokens.accent2);
  set("--v-surface", tokens.surface);
  set("--v-surface-fg", tokens.surfaceFg);
  set("--v-surface-stroke", tokens.stroke);
  set("--v-abort-bg", tokens.abortBg);
  set("--v-abort-fg", tokens.abortFg);

  set("--v-border-color", border.color || "#FF7A18");
  set("--v-border-color-end", border.color_end || "#FFB347");
  set("--v-border-width", `${num(border.width, 4)}px`);
  set("--v-border-radius", `${num(border.radius, 12)}px`);
  set("--v-border-glow", border.glow || "none");
  set("--v-border-opacity", num(border.opacity, 1));
  set("--v-border-dur", `${num(border.animation_duration, 2)}s`);

  set("--v-banner-opacity", num(banner.opacity, 0.95));
  set("--v-banner-blur", `${num(banner.blur, 20)}px`);
  set("--v-text-color", banner.text_color || "#FFFFFF");
  set("--v-text-align", banner.align || "center");
  set("--v-font-family", fontFamilyValue(font.family));
  set("--v-font-size", `${num(font.size, 15)}px`);
  set("--v-font-weight", num(font.weight, 500));
  set("--v-font-spacing", `${num(font.letter_spacing, 0.3)}px`);
  set("--v-anim-dur", `${num(border.animation_duration, 2)}s`);
  set("--v-enter-dur", `${num(anim.duration, 0.35)}s`);
}

function previewMetrics() {
  const size = getPath(cfg, "banner.size") || {};
  return {
    w: clamp(num(size.w, 320), 140, 344),
    h: clamp(num(size.h, 96), 48, 204)
  };
}

function previewText() {
  const template = (cfg.text && cfg.text.waiting) || "需要你介入 · {action}";
  return String(template)
    .replace(/\{agent\}/g, "AI-Veil")
    .replace(/\{action\}/g, "预览动作")
    .replace(/\{target\}/g, "示例窗口")
    .replace(/\{duration\}/g, "3.0s")
    .replace(/\{time\}/g, "12:00");
}

// 预览用的素材读取一律返回 null，形状模块会自动降级，避免设置窗口重复实现加载/净化链路
const previewAssets = {
  async svg() {
    return null;
  },
  async imageUrl() {
    return null;
  }
};

function buildPreviewShape() {
  const banner = getPath(cfg, "banner");
  const shape = mergeDefaults(FALLBACK_CONFIG.banner, isPlainObject(banner) ? banner : {});
  const metrics = previewMetrics();
  shape.visible = true;
  shape.size = { w: metrics.w, h: metrics.h };
  return shape;
}

function renderPreview() {
  const layer = byId("preview-layer");
  const stage = byId("preview-stage");
  if (!layer) return;
  layer.textContent = "";

  const metrics = previewMetrics();
  layer.style.width = `${metrics.w}px`;
  layer.style.height = `${metrics.h}px`;
  layer.style.left = `${Math.round((360 - metrics.w) / 2)}px`;
  layer.style.top = `${Math.round((220 - metrics.h) / 2)}px`;

  const banner = getPath(cfg, "banner") || {};
  const scale = clamp(num(banner.scale, 1), 0.2, 5);
  const rotation = clamp(num(banner.rotation, 0), -180, 180);
  layer.style.transform = `scale(${scale}) rotate(${rotation}deg)`;

  try {
    const module_ = getShape(banner.shape) || getFallback();
    if (!module_ || typeof module_.render !== "function") throw new Error("形状模块缺少 render()");
    const result = module_.render(buildPreviewShape(), {
      doc: document,
      assets: previewAssets,
      warn: (message) => warn("预览：" + message, "warn"),
      event: "need_human"
    });
    const root = result && result.root;
    if (!root || typeof root.appendChild !== "function") throw new Error("形状未返回有效节点");
    root.classList.add("pv-shape-root");
    layer.appendChild(root);
    const textRect = result.textRect;
    if (textRect && num(textRect.w, 0) > 0 && num(textRect.h, 0) > 0) {
      layer.appendChild(buildPreviewText(banner, textRect));
    }
    if (stage) stage.classList.remove("is-fallback");
    const errorBox = byId("preview-error");
    if (errorBox) errorBox.textContent = "";
  } catch (err) {
    renderPreviewFallback(err);
  }
}

function buildPreviewText(banner, textRect) {
  const padding = banner.padding || {};
  const padX = Math.max(0, num(padding.x, 18));
  const padY = Math.max(0, num(padding.y, 12));
  const align = ["left", "center", "right"].includes(banner.align) ? banner.align : "center";
  const overflow = ["ellipsis", "wrap", "shrink"].includes(banner.overflow) ? banner.overflow : "ellipsis";
  const maxLines = clamp(num(banner.max_lines, 2), 1, 6);

  const box = document.createElement("div");
  box.className = "pv-text";
  box.dataset.align = align;
  box.style.left = `${num(textRect.x, 0) + padX}px`;
  box.style.top = `${num(textRect.y, 0) + padY}px`;
  box.style.width = `${Math.max(8, num(textRect.w, 0) - padX * 2)}px`;
  box.style.height = `${Math.max(8, num(textRect.h, 0) - padY * 2)}px`;
  box.style.textAlign = align;

  const inner = document.createElement("span");
  inner.className = "pv-text-inner";
  inner.textContent = previewText();
  inner.style.display = "block";
  inner.style.maxWidth = "100%";
  inner.style.overflow = "hidden";

  if (overflow === "ellipsis") {
    inner.style.whiteSpace = "nowrap";
    inner.style.textOverflow = "ellipsis";
  } else if (overflow === "wrap") {
    inner.style.setProperty("display", "-webkit-box");
    inner.style.setProperty("-webkit-box-orient", "vertical");
    inner.style.setProperty("-webkit-line-clamp", String(maxLines));
  }

  box.appendChild(inner);
  return box;
}

function renderPreviewFallback(err) {
  const layer = byId("preview-layer");
  const stage = byId("preview-stage");
  const errorBox = byId("preview-error");
  const message = describeError(err);

  if (layer) {
    layer.textContent = "";
    const solid = document.createElement("div");
    solid.className = "pv-fallback";
    solid.textContent = previewText();
    layer.appendChild(solid);
  }
  if (stage) stage.classList.add("is-fallback");
  if (errorBox) errorBox.textContent = "预览渲染失败：" + message;
  warn("预览渲染失败，已降级为纯色块：" + message, "error");
}

/* ---------------- 交互绑定 ---------------- */

function bindModel() {
  document.querySelectorAll("[data-path]").forEach((node) => {
    if (node.dataset.bound === "1") return;
    node.dataset.bound = "1";
    node.addEventListener("input", () => {
      commitControl(node);
      scheduleSave();
    });
    node.addEventListener("change", () => {
      commitControl(node);
      save();
    });
  });
  bindThemeCards();
  bindShapeChips();
  bindIdleCheckboxes();
  renderAll();
}

function bindThemeCards() {
  document.querySelectorAll("[data-theme-card]").forEach((card) => {
    if (card.dataset.bound === "1") return;
    card.dataset.bound = "1";
    card.addEventListener("click", () => {
      selectTheme(card.dataset.themeCard);
    });
  });
}

async function selectTheme(theme) {
  const next = THEME_NAMES.includes(theme) ? theme : "orange";
  if (!isPlainObject(cfg.meta)) cfg.meta = clone(FALLBACK_CONFIG.meta);
  cfg.meta.theme = next;
  document.body.dataset.theme = next;
  renderThemeCards();
  applyPreviewVars();
  renderPreview();
  updateMetaLabels();

  if (!ONLINE) {
    setStatus("未连接到后端 · 主题仅本地预览", "error", 3000);
    return;
  }
  try {
    const result = await invoke("set_theme", { theme: next });
    if (result && result.ok === false) throw new Error("后端返回 ok=false");
    await save();
  } catch (err) {
    setStatus("切换主题失败 · " + describeError(err), "error", 6000);
    warn("set_theme 失败：" + describeError(err), "error");
  }
}

function bindShapeChips() {
  document.querySelectorAll("[data-shape-chip]").forEach((chip) => {
    if (chip.dataset.bound === "1") return;
    chip.dataset.bound = "1";
    chip.addEventListener("click", () => {
      const name = chip.dataset.shapeChip;
      if (!SHAPE_NAMES.includes(name)) return;
      if (!isPlainObject(cfg.banner)) cfg.banner = clone(FALLBACK_CONFIG.banner);
      cfg.banner.shape = name;
      renderShapeChips();
      renderPreview();
      updateMetaLabels();
      scheduleSave();
    });
  });
}

function bindIdleCheckboxes() {
  document.querySelectorAll("[data-idle]").forEach((node) => {
    if (node.dataset.bound === "1") return;
    node.dataset.bound = "1";
    node.addEventListener("change", () => {
      scheduleSave();
      applyPreviewVars();
    });
  });
}

function activatePanel(name) {
  if (!name) return;
  document.querySelectorAll("[data-panel-nav]").forEach((button) => {
    const isActive = button.dataset.panelNav === name;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  document.querySelectorAll(".panel[data-panel]").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === name);
  });
}

function bindClick(id, handler) {
  const node = byId(id);
  if (node) node.addEventListener("click", handler);
}

function bindStaticControls() {
  document.querySelectorAll("[data-panel-nav]").forEach((button) => {
    button.addEventListener("click", () => activatePanel(button.dataset.panelNav));
  });

  bindClick("btn-reset", () => handleReset());
  bindClick("btn-export", () => handleExportPreset());
  bindClick("btn-import", () => {
    const input = byId("file-preset");
    if (input) input.click();
  });
  bindClick("btn-open-logs", () => simpleInvoke("open_logs", {}, "已打开日志目录"));
  bindClick("btn-mock", () => simpleInvoke("start_adapter", { kind: "mock" }, "演示回放已启动"));
  bindClick("btn-stop-mock", () => simpleInvoke("stop_adapter", {}, "演示回放已停止"));
  bindClick("btn-emit", () => handleEmitRawEvent());

  document.querySelectorAll("[data-browse]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = byId(button.dataset.browse);
      if (input) input.click();
    });
  });

  const presetInput = byId("file-preset");
  if (presetInput) {
    presetInput.addEventListener("change", () => {
      const file = presetInput.files && presetInput.files[0];
      presetInput.value = "";
      if (file) handleImportPreset(file);
    });
  }

  document.querySelectorAll("[data-asset-target]").forEach((input) => {
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      handleAssetImport(file, input.dataset.assetTarget, input);
    });
  });
}

/* ---------------- 文件与 IPC 操作 ---------------- */

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("FileReader 读取失败"));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("FileReader 读取失败"));
    reader.readAsText(file, "utf-8");
  });
}

async function handleAssetImport(file, targetPath, input) {
  if (input) input.value = "";
  if (!targetPath) return;
  if (!ONLINE) {
    setStatus("未连接到后端 · 无法导入素材", "error", 3000);
    return;
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const base64 = String(dataUrl).replace(/^data:[^,]*;base64,/i, "").trim();
    if (!base64) throw new Error("文件内容为空");
    const result = await invoke("import_asset", { name: file.name, data_base64: base64 });
    if (!result || result.ok !== true || !result.path) {
      throw new Error(result && result.error ? String(result.error) : "后端拒绝导入");
    }
    setPath(cfg, targetPath, result.path);
    renderAll();
    await save();
    setStatus("素材已导入 · " + file.name, "ok", 3000);
  } catch (err) {
    setStatus("素材导入失败 · " + describeError(err), "error", 6000);
    warn("import_asset 失败：" + describeError(err), "error");
  }
}

async function handleExportPreset() {
  if (!ONLINE) {
    setStatus("未连接到后端 · 无法导出预设", "error", 3000);
    return;
  }
  const inlineBox = byId("inline-assets");
  const inlineAssets = Boolean(inlineBox && inlineBox.checked);
  try {
    const result = await invoke("export_preset", { inline_assets: inlineAssets });
    if (!result || result.ok !== true || !result.path) {
      throw new Error(result && result.error ? String(result.error) : "后端拒绝导出");
    }
    setStatus("预设已导出 · " + result.path, "ok", 5000);
  } catch (err) {
    setStatus("导出预设失败 · " + describeError(err), "error", 6000);
    warn("export_preset 失败：" + describeError(err), "error");
  }
}

async function handleImportPreset(file) {
  if (!ONLINE) {
    setStatus("未连接到后端 · 无法导入预设", "error", 3000);
    return;
  }
  try {
    const text = await readFileAsText(file);
    const result = await invoke("import_preset", { data: text });
    if (!result || result.ok !== true) {
      throw new Error(result && result.error ? String(result.error) : "后端拒绝导入预设");
    }
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    warnings.forEach((item) => warn("导入预设：" + item, "warn"));
    await loadConfig();
    bindModel();
    lastSavedPayload = JSON.stringify(cfg);
    if (loadError) {
      setStatus(loadError, "error", 0);
      return;
    }
    setStatus("预设已导入", "ok", 3000);
  } catch (err) {
    setStatus("导入预设失败 · " + describeError(err), "error", 6000);
    warn("import_preset 失败：" + describeError(err), "error");
  }
}

async function handleReset() {
  if (!ONLINE) {
    setStatus("未连接到后端 · 无法恢复默认", "error", 3000);
    return;
  }
  try {
    const result = await invoke("reset_config", {});
    if (result && result.ok === false) throw new Error("后端拒绝恢复默认");
    await loadConfig();
    bindModel();
    lastSavedPayload = JSON.stringify(cfg);
    if (loadError) {
      setStatus(loadError, "error", 0);
      return;
    }
    setStatus("已恢复默认配置", "ok", 3000);
  } catch (err) {
    setStatus("恢复默认失败 · " + describeError(err), "error", 6000);
    warn("reset_config 失败：" + describeError(err), "error");
  }
}

async function handleEmitRawEvent() {
  const box = byId("raw-event");
  const json = box ? String(box.value || "").trim() : "";
  if (!json) {
    setStatus("请先填写事件 JSON", "error", 3000);
    return;
  }
  try {
    JSON.parse(json);
  } catch (err) {
    setStatus("事件 JSON 语法错误 · " + describeError(err), "error", 5000);
    return;
  }
  if (!ONLINE) {
    setStatus("未连接到后端 · 无法发送事件", "error", 3000);
    return;
  }
  try {
    const result = await invoke("emit_raw_event", { json });
    if (result && result.ok === false) {
      throw new Error(result.error ? String(result.error) : "后端拒绝该事件");
    }
    setStatus("事件已发送 · " + json.length + " 字节", "ok", 2500);
  } catch (err) {
    setStatus("事件发送失败 · " + describeError(err), "error", 6000);
    appendDiag("error", "emit_raw_event 失败：" + describeError(err));
  }
}

async function simpleInvoke(command, args, okText) {
  if (!ONLINE) {
    setStatus("未连接到后端 · 无法执行", "error", 3000);
    return;
  }
  try {
    const result = await invoke(command, args || {});
    if (result && result.ok === false) {
      throw new Error(result.error ? String(result.error) : "后端返回 ok=false");
    }
    setStatus(okText, "ok", 3000);
  } catch (err) {
    setStatus("操作失败 · " + describeError(err), "error", 6000);
    warn(command + " 失败：" + describeError(err), "error");
  }
}

/* ---------------- 后端事件订阅 ---------------- */

function bindBackendEvents() {
  if (!listenEvent || diagBound) return;
  diagBound = true;
  try {
    const pending = listenEvent("veil://notice", (event) => {
      const payload = event && event.payload ? event.payload : {};
      appendDiag(payload.level || "info", payload.message || "（空通知）");
    });
    if (pending && typeof pending.catch === "function") {
      pending.catch((err) => warn("订阅 veil://notice 失败：" + describeError(err), "error"));
    }
  } catch (err) {
    warn("订阅 veil://notice 失败：" + describeError(err), "error");
  }
}

/* ---------------- 启动 ---------------- */

async function init() {
  bindStaticControls();
  await loadConfig();
  bindModel();
  lastSavedPayload = JSON.stringify(cfg);
  bindBackendEvents();

  if (!ONLINE) {
    document.body.classList.add("is-offline");
    setStatus("未连接到后端 · 只读预览", "error", 0);
    appendDiag("warn", "未检测到 window.__TAURI__，界面可预览但无法保存或执行后端命令。");
  } else if (loadError) {
    setStatus(loadError, "error", 0);
  } else {
    setStatus("就绪", "info", 1600);
  }
}

function bootstrap() {
  init().catch((err) => {
    console.error("[AI-Veil 设置] 初始化失败", err);
    appendDiag("error", "初始化失败：" + describeError(err));
    setStatus("初始化失败 · " + describeError(err), "error", 0);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
