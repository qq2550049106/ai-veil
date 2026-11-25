"use strict";
/**
 * lib/config.js —— 配置：默认值、归一化、读写（Electron 版）
 *
 * 与 Rust 版 config.rs 一一对应：
 *   - 默认值 == examples/config.sample.toml（93 个叶子键，这是权威）
 *   - 缺键用默认值补齐（等价 serde(default)），部分表也补齐（`padding = { x = 20 }` → y=12）
 *   - 非法值不抛错：钳制/回退，并产出中文告警
 *   - 原子写：先写 .tmp 再 rename；损坏文件备份为 config.toml.broken-<时间戳>
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const toml = require("./toml");

const THEMES = ["orange", "cyan", "mono", "contrast"];
const BORDER_SCOPES = ["fullscreen", "region", "window", "none"];
const BORDER_STYLES = ["solid", "dashed", "dotted", "double", "gradient"];
const BORDER_ANIMS = ["none", "breathe", "dash", "scan", "pulse"];
const SHAPES = ["rect", "pill", "speech_bubble", "cat", "paw", "blob", "star", "custom_svg", "image"];
const VARIANTS = ["orange", "black", "white"];
const ANCHORS = ["top-center", "top-left", "top-right", "bottom-center", "custom"];
const ALIGNS = ["left", "center", "right"];
const OVERFLOWS = ["ellipsis", "wrap", "shrink"];
const FITS = ["contain", "cover", "fill"];
const ENTER_ANIMS = ["none", "fade", "slide", "pop"];
const IDLE_ANIMS = ["none", "blink", "wag", "float", "wiggle"];
const WAVES = ["sine", "square", "sawtooth", "triangle"];
const PER_EVENT_KEYS = ["session.start", "session.end", "action.before", "action.after", "need_human", "error", "heartbeat"];

/** 默认配置：与 examples/config.sample.toml 完全一致 */
const DEFAULT = {
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
    animation_duration: 2,
    opacity: 1,
    inset: 0,
    follow_display: true,
    per_event: {
      need_human: { color: "#FF3B30", animation: "pulse", width: 6 },
      error: { color: "#FF3B30", animation: "scan" },
      heartbeat: { visible: false },
    },
  },
  banner: {
    visible: true,
    shape: "cat",
    variant: "orange",
    anchor: "top-center",
    offset: { x: 0, y: 24 },
    size: { w: 320, h: 96 },
    scale: 1,
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
    animation: { idle: "blink", enter: "pop", duration: 0.35 },
  },
  text: {
    start: "{agent} 正在接管你的电脑",
    running: "{agent} 正在操控 · {action}",
    waiting: "需要你介入 · {action}",
    end: "操控已结束 · 共 {duration}",
    error: "操控异常中断 · {action}",
    cancel_button: "中止",
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
      alert_dur: 0.25,
    },
    events: { session_start: true, session_end: true, need_human: true, error: true, action: false },
  },
  notify: { enabled: true, duration_sec: 5, thumbnail: false, silent: false },
  rules: {
    ttl_ms: 30000,
    min_takeover_ms: 600,
    ignore_events: ["heartbeat"],
    dnd_start: "",
    dnd_end: "",
    process_whitelist: [],
    process_blacklist: [],
  },
  hotkeys: { cancel: "Ctrl+Alt+Esc", toggle_visible: "Ctrl+Alt+V", next_theme: "Ctrl+Alt+T" },
  assets: { dirs: ["~/.ai-veil/assets/"], max_bytes: 524288, max_px: 4096, sanitize_svg: true },
  privacy: { upload_enabled: false, log_dir: "~/.ai-veil/logs" },
};

/* ------------------------------ 基础工具 ------------------------------ */

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function nowMs() {
  return Date.now();
}

function clamp(v, lo, hi) {
  if (typeof v !== "number" || Number.isNaN(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function hexColor(value) {
  return typeof value === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value.trim());
}

function parseHhmm(value) {
  const text = String(value || "").trim();
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function validHhmm(value) {
  return parseHhmm(value) !== null;
}

/** 展开 ~ 与 ~/ 开头路径 */
function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2));
  return text;
}

/** 把 "4"/"true" 这类字符串按默认值的类型纠回来（比 Rust 版更宽容，见 ASSUMPTIONS S13） */
function coerceLike(value, template) {
  if (value === undefined || value === null) return clone(template);
  if (typeof template === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : clone(template);
  }
  if (typeof template === "boolean") {
    if (typeof value === "string") {
      const low = value.trim().toLowerCase();
      if (low === "true") return true;
      if (low === "false") return false;
    }
    return Boolean(value);
  }
  if (typeof template === "string") return String(value);
  return value;
}

/** 深合并：用户值覆盖默认值，缺的键与半个表都由默认值补齐 */
function mergeDeep(base, patch) {
  // 数组必须整体替换：默认值可能是标量（例如 idle="blink"），用户却可以写成 ["blink","wag"]
  if (Array.isArray(patch)) return clone(patch);
  if (!isPlainObject(base)) return coerceLike(patch, base);
  const out = {};
  const source = isPlainObject(patch) ? patch : {};
  for (const key of Object.keys(base)) out[key] = mergeDeep(base[key], source[key]);
  // 默认值里没有的键（例如 per_event 下自定义事件名）原样保留
  for (const key of Object.keys(source)) {
    if (!(key in out)) out[key] = clone(source[key]);
  }
  return out;
}

/* ------------------------------ 归一化 ------------------------------ */

function makeFixer(warns) {
  return {
    enum(field, holder, key, list, fallback) {
      const raw = holder[key];
      const low = String(raw === undefined || raw === null ? "" : raw).trim().toLowerCase();
      if (list.includes(low)) holder[key] = low;
      else {
        warns.push(`配置项 ${field} 的值 \`${raw}\` 非法，已回退为 \`${fallback}\``);
        holder[key] = fallback;
      }
    },
    color(field, holder, key, fallback) {
      if (!hexColor(holder[key])) {
        warns.push(`配置项 ${field} 不是合法颜色，已回退为 ${fallback}`);
        holder[key] = fallback;
      }
    },
    num(field, holder, key, lo, hi) {
      const before = holder[key];
      const after = clamp(before, lo, hi);
      holder[key] = after;
      if (before !== after) warns.push(`配置项 ${field} 超出范围 [${lo},${hi}]，已钳制为 ${after}`);
    },
    int(field, holder, key, lo, hi) {
      const before = Math.round(Number(holder[key]));
      let after = before;
      if (!Number.isFinite(before)) after = lo;
      else if (before < lo) after = lo;
      else if (before > hi) after = hi;
      holder[key] = after;
      if (before !== after) warns.push(`配置项 ${field} 超出范围 [${lo},${hi}]，已钳制为 ${after}`);
    },
  };
}

/** 校验并归一化；返回中文告警数组（永不抛错） */
function normalize(cfg) {
  const warns = [];
  const fix = makeFixer(warns);

  fix.enum("meta.theme", cfg.meta, "theme", THEMES, "orange");
  if (!cfg.meta.version) cfg.meta.version = 1;

  // ---- border
  fix.enum("border.scope", cfg.border, "scope", BORDER_SCOPES, "fullscreen");
  fix.enum("border.style", cfg.border, "style", BORDER_STYLES, "solid");
  fix.enum("border.animation", cfg.border, "animation", BORDER_ANIMS, "none");
  fix.color("border.color", cfg.border, "color", "#FF7A18");
  fix.color("border.color_end", cfg.border, "color_end", "#FFB347");
  fix.num("border.width", cfg.border, "width", 1, 32);
  fix.num("border.radius", cfg.border, "radius", 0, 128);
  fix.num("border.animation_duration", cfg.border, "animation_duration", 0.1, 10);
  fix.num("border.opacity", cfg.border, "opacity", 0, 1);
  fix.num("border.inset", cfg.border, "inset", 0, 400);

  const perEvent = isPlainObject(cfg.border.per_event) ? cfg.border.per_event : {};
  for (const key of Object.keys(perEvent)) {
    if (!PER_EVENT_KEYS.includes(key)) {
      warns.push(`border.per_event.${key} 不是合法事件名，已移除`);
      delete perEvent[key];
      continue;
    }
    const ov = isPlainObject(perEvent[key]) ? perEvent[key] : {};
    perEvent[key] = ov;
    if (ov.width !== undefined) ov.width = clamp(ov.width, 1, 32);
    if (ov.radius !== undefined) ov.radius = clamp(ov.radius, 0, 128);
    if (ov.opacity !== undefined) ov.opacity = clamp(ov.opacity, 0, 1);
    if (ov.animation_duration !== undefined) ov.animation_duration = clamp(ov.animation_duration, 0.1, 10);
    for (const key2 of ["color", "color_end"]) {
      if (ov[key2] !== undefined && !hexColor(ov[key2])) {
        warns.push(`border.per_event.${key}.${key2} 非法，已忽略该项`);
        delete ov[key2];
      }
    }
    if (ov.animation !== undefined) {
      const low = String(ov.animation).trim().toLowerCase();
      if (BORDER_ANIMS.includes(low)) ov.animation = low;
      else {
        warns.push(`border.per_event.${key}.animation 非法，已移除`);
        delete ov.animation;
      }
    }
    if (ov.style !== undefined) {
      const low = String(ov.style).trim().toLowerCase();
      if (BORDER_STYLES.includes(low)) ov.style = low;
      else {
        warns.push(`border.per_event.${key}.style 非法，已移除`);
        delete ov.style;
      }
    }
    if (ov.scope !== undefined) {
      const low = String(ov.scope).trim().toLowerCase();
      ov.scope = BORDER_SCOPES.includes(low) ? low : "";
      if (!ov.scope) delete ov.scope;
    }
  }
  cfg.border.per_event = perEvent;

  // ---- banner
  fix.enum("banner.shape", cfg.banner, "shape", SHAPES, "rect");
  fix.enum("banner.variant", cfg.banner, "variant", VARIANTS, "orange");
  fix.enum("banner.anchor", cfg.banner, "anchor", ANCHORS, "top-center");
  fix.enum("banner.align", cfg.banner, "align", ALIGNS, "center");
  fix.enum("banner.overflow", cfg.banner, "overflow", OVERFLOWS, "ellipsis");
  fix.enum("banner.custom.image_fit", cfg.banner.custom, "image_fit", FITS, "contain");
  fix.enum("banner.animation.enter", cfg.banner.animation, "enter", ENTER_ANIMS, "pop");
  fix.color("banner.text_color", cfg.banner, "text_color", "#FFFFFF");
  if (String(cfg.banner.custom.tint || "").trim() !== "") {
    fix.color("banner.custom.tint", cfg.banner.custom, "tint", "#FF7A18");
  }
  fix.num("banner.size.w", cfg.banner.size, "w", 120, 1600);
  fix.num("banner.size.h", cfg.banner.size, "h", 40, 800);
  fix.num("banner.scale", cfg.banner, "scale", 0.2, 5);
  fix.num("banner.rotation", cfg.banner, "rotation", -180, 180);
  fix.num("banner.opacity", cfg.banner, "opacity", 0, 1);
  fix.num("banner.blur", cfg.banner, "blur", 0, 60);
  fix.num("banner.padding.x", cfg.banner.padding, "x", 0, 120);
  fix.num("banner.padding.y", cfg.banner.padding, "y", 0, 120);
  fix.num("banner.offset.x", cfg.banner.offset, "x", -10000, 10000);
  fix.num("banner.offset.y", cfg.banner.offset, "y", -10000, 10000);
  fix.num("banner.font.size", cfg.banner.font, "size", 8, 48);
  fix.num("banner.font.letter_spacing", cfg.banner.font, "letter_spacing", -5, 20);
  fix.num("banner.animation.duration", cfg.banner.animation, "duration", 0.05, 5);
  if (cfg.banner.font.weight < 100 || cfg.banner.font.weight > 900) {
    warns.push("配置项 banner.font.weight 超出 [100,900]，已回退为 500");
    cfg.banner.font.weight = 500;
  }
  if (cfg.banner.max_lines < 1 || cfg.banner.max_lines > 6) {
    warns.push("配置项 banner.max_lines 超出 [1,6]，已钳制");
    cfg.banner.max_lines = clamp(Math.round(cfg.banner.max_lines), 1, 6);
  }

  // idle 允许 "blink" 或 ["blink","wag"]
  const rawIdle = cfg.banner.animation.idle;
  if (Array.isArray(rawIdle)) {
    const valid = rawIdle
      .map((x) => String(x).trim().toLowerCase())
      .filter((x) => IDLE_ANIMS.includes(x));
    if (valid.length !== rawIdle.length) warns.push("配置项 banner.animation.idle 含非法动画名，已剔除");
    cfg.banner.animation.idle = valid;
  } else {
    const single = String(rawIdle === undefined || rawIdle === null ? "" : rawIdle).trim().toLowerCase();
    cfg.banner.animation.idle = IDLE_ANIMS.includes(single) ? single : "none";
  }

  // ---- text
  if (String(cfg.text.cancel_button || "").trim() === "") {
    warns.push("text.cancel_button 为空，已回退为「中止」");
    cfg.text.cancel_button = "中止";
  }

  // ---- sound
  fix.num("sound.volume", cfg.sound, "volume", 0, 1);
  if (cfg.sound.throttle_ms < 0) {
    warns.push("sound.throttle_ms 不能为负，已置 0");
    cfg.sound.throttle_ms = 0;
  }
  if (cfg.sound.throttle_ms > 10000) {
    warns.push("sound.throttle_ms 过大，已钳制到 10000");
    cfg.sound.throttle_ms = 10000;
  }
  for (const name of ["start_wave", "end_wave", "alert_wave"]) {
    fix.enum(`sound.synth.${name}`, cfg.sound.synth, name, WAVES, "sine");
  }
  fix.num("sound.synth.start_freq", cfg.sound.synth, "start_freq", 100, 4000);
  fix.num("sound.synth.end_freq", cfg.sound.synth, "end_freq", 100, 4000);
  fix.num("sound.synth.alert_freq", cfg.sound.synth, "alert_freq", 100, 4000);
  fix.num("sound.synth.start_dur", cfg.sound.synth, "start_dur", 0.01, 2);
  fix.num("sound.synth.end_dur", cfg.sound.synth, "end_dur", 0.01, 2);
  fix.num("sound.synth.alert_dur", cfg.sound.synth, "alert_dur", 0.01, 2);

  // ---- notify
  if (cfg.notify.duration_sec < 1 || cfg.notify.duration_sec > 60) {
    warns.push("notify.duration_sec 超出 [1,60]，已钳制");
    cfg.notify.duration_sec = clamp(Math.round(cfg.notify.duration_sec), 1, 60);
  }

  // ---- rules
  if (cfg.rules.ttl_ms < 500) {
    warns.push("rules.ttl_ms 小于 500ms，已回退为 30000");
    cfg.rules.ttl_ms = 30000;
  }
  if (cfg.rules.ttl_ms > 600000) {
    warns.push("rules.ttl_ms 大于 600000ms，已钳制");
    cfg.rules.ttl_ms = 600000;
  }
  if (cfg.rules.min_takeover_ms < 0) {
    warns.push("rules.min_takeover_ms 不能为负，已置 0");
    cfg.rules.min_takeover_ms = 0;
  }
  for (const name of ["dnd_start", "dnd_end"]) {
    const value = String(cfg.rules[name] || "").trim();
    if (value !== "" && !validHhmm(value)) {
      warns.push(`rules.${name} 不是 HH:MM 格式，已清空`);
      cfg.rules[name] = "";
    } else cfg.rules[name] = value;
  }
  cfg.rules.ignore_events = (Array.isArray(cfg.rules.ignore_events) ? cfg.rules.ignore_events : [])
    .map((x) => String(x).trim().toLowerCase())
    .filter((x) => x !== "");
  cfg.rules.process_whitelist = (Array.isArray(cfg.rules.process_whitelist) ? cfg.rules.process_whitelist : []).map(String);
  cfg.rules.process_blacklist = (Array.isArray(cfg.rules.process_blacklist) ? cfg.rules.process_blacklist : []).map(String);

  // ---- hotkeys（中止通道不可关闭）
  if (String(cfg.hotkeys.cancel || "").trim() === "") {
    warns.push("hotkeys.cancel 为空，已回退为 Ctrl+Alt+Esc（中止通道不可关闭）");
    cfg.hotkeys.cancel = "Ctrl+Alt+Esc";
  }
  if (String(cfg.hotkeys.toggle_visible || "").trim() === "") cfg.hotkeys.toggle_visible = "Ctrl+Alt+V";
  if (String(cfg.hotkeys.next_theme || "").trim() === "") cfg.hotkeys.next_theme = "Ctrl+Alt+T";

  // ---- assets
  cfg.assets.max_bytes = Math.min(Math.max(Number(cfg.assets.max_bytes) || 1024, 1024), 5242880);
  cfg.assets.max_px = Math.min(Math.max(Number(cfg.assets.max_px) || 16, 16), 16384);
  if (!Array.isArray(cfg.assets.dirs) || cfg.assets.dirs.length === 0) cfg.assets.dirs = ["~/.ai-veil/assets/"];
  cfg.assets.dirs = cfg.assets.dirs.map(String);

  // ---- privacy：上传永远关闭
  if (cfg.privacy.upload_enabled) {
    warns.push("privacy.upload_enabled 被强制关闭（数据仅本机处理）");
    cfg.privacy.upload_enabled = false;
  }

  return warns;
}

/** 默认配置 + 用户值 → 完整且已归一化的配置 */
function buildConfig(parsed) {
  const cfg = mergeDeep(DEFAULT, isPlainObject(parsed) ? parsed : {});
  const warnings = normalize(cfg);
  return { config: cfg, warnings };
}

/** 主题是否在免打扰时段（支持跨午夜） */
function inDnd(cfg, date = new Date()) {
  const start = String(cfg.rules.dnd_start || "").trim();
  const end = String(cfg.rules.dnd_end || "").trim();
  if (!start || !end) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  const s = parseHhmm(start);
  const e = parseHhmm(end);
  if (s === null || e === null) return false;
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

/* ------------------------------ 读写 ------------------------------ */

class ConfigStore {
  constructor(home) {
    this.home = home;
    this.configPath = path.join(home, ".ai-veil", "config.toml");
    this.config = null;
    this.warnings = [];
    this.generation = 0;
    this.mtimeMs = 0;
    this.size = 0;
  }

  ensureDir() {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
  }

  /** 读盘；文件不存在则落一份默认配置。损坏则备份并回退默认 */
  load(logger) {
    this.ensureDir();
    let parsed = {};
    let loadWarnings = [];
    try {
      if (fs.existsSync(this.configPath)) {
        const text = fs.readFileSync(this.configPath, "utf8");
        parsed = toml.parse(text);
        this.rememberStat();
      } else {
        parsed = {};
      }
    } catch (error) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const broken = `${this.configPath}.broken-${stamp}`;
      try {
        fs.copyFileSync(this.configPath, broken);
        loadWarnings.push(`配置文件解析失败，已备份为 ${path.basename(broken)} 并回退默认值：${error.message}`);
      } catch (copyError) {
        loadWarnings.push(`配置文件解析失败且备份失败：${error.message}`);
      }
      if (logger) logger.warn(`配置解析失败：${error.message}`);
      parsed = {};
    }

    const built = buildConfig(parsed);
    this.config = built.config;
    this.warnings = loadWarnings.concat(built.warnings);

    if (!fs.existsSync(this.configPath)) {
      this.save(this.config, logger);
      if (logger) logger.info(`已生成默认配置：${this.configPath}`);
    }
    return this.config;
  }

  rememberStat() {
    try {
      const st = fs.statSync(this.configPath);
      this.mtimeMs = st.mtimeMs;
      this.size = st.size;
    } catch {
      this.mtimeMs = 0;
      this.size = 0;
    }
  }

  /** 原子写：.tmp → rename，避免读方看到半个文件 */
  save(cfg, logger) {
    this.ensureDir();
    const tmp = `${this.configPath}.tmp`;
    const text = toml.stringify(cfg);
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, this.configPath);
    this.generation += 1;
    this.config = cfg;
    this.rememberStat();
    if (logger) logger.info(`配置已保存（gen=${this.generation}）`);
  }

  /** 外部是否改动过（轮询用；自己刚写过的这次会因 mtime/size 一致而跳过） */
  changedExternally() {
    try {
      const st = fs.statSync(this.configPath);
      return st.mtimeMs !== this.mtimeMs || st.size !== this.size;
    } catch {
      return false;
    }
  }

  snapshot() {
    return clone(this.config);
  }

  /** 用前端传回的对象替换配置；返回告警 */
  replace(next, logger) {
    const built = buildConfig(next);
    this.config = built.config;
    this.warnings = built.warnings;
    this.save(this.config, logger);
    return built.warnings;
  }

  reset(logger) {
    const built = buildConfig({});
    this.config = built.config;
    this.warnings = built.warnings;
    this.save(this.config, logger);
    return built.warnings;
  }
}

module.exports = {
  DEFAULT,
  ConfigStore,
  buildConfig,
  normalize,
  mergeDeep,
  inDnd,
  hexColor,
  expandHome,
  validHhmm,
  parseHhmm,
  nowMs,
  clamp,
  THEMES,
  SHAPES,
  PER_EVENT_KEYS,
  BORDER_SCOPES,
  BORDER_STYLES,
  BORDER_ANIMS,
  VARIANTS,
  ANCHORS,
  IDLE_ANIMS,
};
