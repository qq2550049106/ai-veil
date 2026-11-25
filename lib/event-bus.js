"use strict";
/**
 * lib/event-bus.js —— 事件总线（Electron 版，对应 Rust 的 event_bus.rs）
 *
 * 职责：
 *   1. 把原始 VeilEvent 校验成内部统一事件（缺字段补默认、未知字段忽略）
 *   2. 去重（5s）、乱序容错（会话结束后迟到的事件丢弃）、TTL 续期与超时兜底
 *   3. 按「事件 visual > [border.per_event] > 全局配置」解析出边框/横幅视图
 *   4. 产出前端契约的完整 state（字段名与 Tauri 版逐字一致，前端零改动）
 */

const { clamp, inDnd } = require("./config");

const KIND_BY_EVENT = {
  "session.start": "start",
  "session.end": "end",
  "action.before": "running",
  "action.after": "running",
  need_human: "need_human",
  error: "error",
  heartbeat: "running",
};

const SOUND_BY_KIND = { start: "start", end: "end", need_human: "alert", error: "error", running: null };
const SOUND_GATE = { start: "session_start", end: "session_end", alert: "need_human", error: "error" };
const DEDUPE_WINDOW_MS = 5000;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function hhmmss(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(ms) {
  const sec = Math.max(0, ms) / 1000;
  return `${sec.toFixed(1)}s`;
}

/** 模板插值：{agent} {action} {target} {duration} {time} */
function interpolate(template, vars) {
  return String(template === undefined || template === null ? "" : template).replace(/\{(\w+)\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
    return whole;
  });
}

/** 校验并补全一条原始事件；返回 null 表示这条事件不可用 */
function normalizeEvent(raw, now) {
  if (!isPlainObject(raw)) return null;
  const name = String(raw.event || "").trim();
  if (!name) return null;
  const ev = {
    event: name,
    ts: Number.isFinite(Number(raw.ts)) && Number(raw.ts) > 0 ? Number(raw.ts) : now,
    session_id: String(raw.session_id || "").trim() || "manual",
    agent: {
      name: String((isPlainObject(raw.agent) && raw.agent.name) || "unknown"),
      version: String((isPlainObject(raw.agent) && raw.agent.version) || "unknown"),
    },
    mode: String(raw.mode || "takeover").trim() || "takeover",
    scope: isPlainObject(raw.scope) ? raw.scope : {},
    action: isPlainObject(raw.action) ? raw.action : {},
    visual: isPlainObject(raw.visual) ? raw.visual : {},
    ttl_ms: Number.isFinite(Number(raw.ttl_ms)) && Number(raw.ttl_ms) > 0 ? Number(raw.ttl_ms) : null,
    cancel: isPlainObject(raw.cancel) ? raw.cancel : null,
  };
  return ev;
}

function rectOf(value) {
  if (!isPlainObject(value)) return null;
  const w = Number(value.w);
  const h = Number(value.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { x: Number(value.x) || 0, y: Number(value.y) || 0, w, h };
}

class EventBus {
  constructor() {
    this.hidden = false;
    this.sessions = new Map();
    this.dedupe = new Map();
    this.resolved = null;
    this.lastState = null;
  }

  /* ------------------------------ 去重 ------------------------------ */

  isDuplicate(ev, now) {
    const key = `${ev.event}|${ev.session_id}|${ev.ts}|${ev.action.target || ""}`;
    for (const [k, t] of this.dedupe) {
      if (now - t > DEDUPE_WINDOW_MS) this.dedupe.delete(k);
    }
    if (this.dedupe.has(key)) return true;
    this.dedupe.set(key, now);
    return false;
  }

  /* ------------------------------ 摄取 ------------------------------ */

  /**
   * @returns {{ok:boolean, reason?:string, resolved?:object, event?:string, suppressedSound?:boolean}}
   */
  ingest(raw, cfg, now, displayRect) {
    const ev = normalizeEvent(raw, now);
    if (!ev) return { ok: false, reason: "非法事件（缺少 event 字段）" };

    const ignore = new Set((cfg.rules.ignore_events || []).map((x) => String(x).toLowerCase()));
    const ignored = ignore.has(ev.event);

    // 乱序容错：会话已结束，迟到的旧事件不复活
    const session = this.sessions.get(ev.session_id) || { started_ts: ev.ts, last_ts: ev.ts, ended_ts: 0, action: "" };
    if (session.ended_ts && ev.ts <= session.ended_ts) {
      return { ok: false, reason: `会话 ${ev.session_id} 已结束，丢弃迟到事件 ${ev.event}` };
    }

    if (this.isDuplicate(ev, now)) {
      return { ok: false, reason: `重复事件已忽略：${ev.event}` };
    }

    // 任何事件都续期（heartbeat 与带 ttl_ms 的事件是主要用途）
    session.last_ts = Math.max(session.last_ts || 0, now);
    if (ev.event === "session.start" || !this.sessions.has(ev.session_id)) {
      if (ev.event === "session.start") session.started_ts = ev.ts;
    }
    if (ev.action && ev.action.target) session.action = String(ev.action.target);
    this.sessions.set(ev.session_id, session);

    if (ignored) {
      // 仅续期 TTL：必须同时刷新"当前视图"的时间戳，否则 tick 会拿陈旧时间判超时
      if (this.resolved && this.resolved.session_id === ev.session_id) {
        this.resolved.last_active_ts = now;
      }
      return { ok: false, reason: `${ev.event} 在 rules.ignore_events 中，仅续期 TTL` };
    }

    let active = ev.event !== "session.end";
    if (ev.event === "session.end") {
      session.ended_ts = ev.ts;
      active = false;
    }

    const resolved = this.resolve(ev, cfg, now, displayRect, {
      active,
      startedTs: session.started_ts,
      endedTs: active ? 0 : ev.ts,
    });

    this.resolved = active ? resolved : null;
    return { ok: true, resolved };
  }

  /** TTL 扫描：超时当作会话结束，返回一条“合成的结束” */
  tick(cfg, now, displayRect) {
    if (!this.resolved || !this.resolved.active) return null;
    const ttl = Math.max(500, Number(cfg.rules.ttl_ms) || 30000);
    const last = this.resolved.last_active_ts || 0;
    if (!last) return null;
    if (now - last <= ttl) return null;

    // 会话结束的时刻应当是"最后活跃 + TTL"，不是最后活跃本身，
    // 否则 duration=0 会命中"最小接管时长"分支，把该发的结束通知和声音吞掉。
    const endedTs = Math.min(now, last + ttl);
    const session = this.sessions.get(this.resolved.session_id);
    if (session) session.ended_ts = endedTs;

    const ev = {
      event: "session.end",
      ts: endedTs,
      session_id: this.resolved.session_id,
      agent: { name: this.resolved.agent, version: this.resolved.agent_version },
      mode: this.resolved.mode,
      scope: {},
      action: { target: "会话超时（TTL 兜底）" },
      visual: {},
      ttl_ms: null,
      cancel: null,
    };
    const resolved = this.resolve(ev, cfg, now, displayRect, {
      active: false,
      startedTs: this.resolved.started_ts,
      endedTs,
      reason: "ttl",
    });
    this.resolved = null;
    return resolved;
  }

  /** 用户/Agent 主动中止：立刻清掉视觉 */
  forceEnd(cfg, now, displayRect, reason) {
    const current = this.resolved;
    const sessionId = current ? current.session_id : "manual";
    const started = current ? current.started_ts : now;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.ended_ts = now;
      this.sessions.set(sessionId, session);
    }
    const ev = {
      event: "session.end",
      ts: now,
      session_id: sessionId,
      agent: { name: current ? current.agent : "unknown", version: current ? current.agent_version : "unknown" },
      mode: current ? current.mode : "takeover",
      scope: {},
      action: { target: reason || "已中止" },
      visual: {},
      ttl_ms: null,
      cancel: null,
    };
    const resolved = this.resolve(ev, cfg, now, displayRect, { active: false, startedTs: started, endedTs: now, reason: "abort" });
    this.resolved = null;
    return resolved;
  }

  toggleHidden() {
    this.hidden = !this.hidden;
    return this.hidden;
  }

  /* --------------------------- 视觉解析 --------------------------- */

  mergeBorder(base, override) {
    const out = clone(base);
    if (!isPlainObject(override)) return out;
    for (const key of [
      "visible",
      "scope",
      "width",
      "radius",
      "style",
      "color",
      "color_end",
      "glow",
      "animation",
      "animation_duration",
      "opacity",
      "inset",
      "follow_display",
    ]) {
      if (override[key] !== undefined && override[key] !== null) out[key] = override[key];
    }
    return out;
  }

  mergeBanner(base, override) {
    const out = clone(base);
    if (!isPlainObject(override)) return out;
    for (const key of [
      "visible",
      "shape",
      "variant",
      "anchor",
      "scale",
      "rotation",
      "opacity",
      "blur",
      "text_color",
      "align",
      "max_lines",
      "overflow",
    ]) {
      if (override[key] !== undefined && override[key] !== null) out[key] = override[key];
    }
    for (const key of ["offset", "size", "padding"]) {
      if (isPlainObject(override[key])) out[key] = Object.assign({}, out[key], override[key]);
    }
    if (isPlainObject(override.font)) out.font = Object.assign({}, out.font, override.font);
    if (isPlainObject(override.custom)) out.custom = Object.assign({}, out.custom, override.custom);
    if (isPlainObject(override.animation)) out.animation = Object.assign({}, out.animation, override.animation);
    if (typeof override.text === "string") out.text = override.text;
    return out;
  }

  resolve(ev, cfg, now, displayRect, meta) {
    const kind = KIND_BY_EVENT[ev.event] || "running";
    const actionTarget = String(ev.action.target || "");
    const actionType = String(ev.action.type || "");
    const targetLabel = actionTarget || actionType || "操作";

    const durationMs = Math.max(0, (meta.endedTs || now) - (meta.startedTs || now));
    const vars = {
      agent: ev.agent.name || "Agent",
      action: targetLabel,
      target: targetLabel,
      duration: formatDuration(durationMs),
      time: hhmmss(),
    };

    const templateKey = { start: "start", running: "running", need_human: "waiting", error: "error", end: "end" }[kind] || "running";
    const template = cfg.text[templateKey] || "";

    // ---- 边框：全局 → per_event → 事件 visual
    const perEvent = isPlainObject(cfg.border.per_event) ? cfg.border.per_event[ev.event] : null;
    let borderCfg = this.mergeBorder(cfg.border, perEvent);
    borderCfg = this.mergeBorder(borderCfg, isPlainObject(ev.visual.border) ? ev.visual.border : null);

    // ---- 横幅
    let bannerCfg = this.mergeBanner(cfg.banner, isPlainObject(ev.visual.banner) ? ev.visual.banner : null);
    const bannerText = typeof bannerCfg.text === "string" && bannerCfg.text
      ? interpolate(bannerCfg.text, vars)
      : interpolate(template, vars);

    const warnings = [];
    const display = displayRect || { x: 0, y: 0, w: 1920, h: 1080 };

    // ---- 区域
    const scopeType = String(ev.scope && ev.scope.type ? ev.scope.type : "fullscreen");
    let region = { x: display.x, y: display.y, w: display.w, h: display.h };
    if (scopeType === "region" || scopeType === "window") {
      const bounds = rectOf(ev.scope && ev.scope.bounds);
      if (bounds) {
        region = {
          x: Math.max(display.x, bounds.x),
          y: Math.max(display.y, bounds.y),
          w: Math.min(bounds.w, display.w - Math.max(0, bounds.x - display.x)),
          h: Math.min(bounds.h, display.h - Math.max(0, bounds.y - display.y)),
        };
      }
    }

    // ---- 边框视图
    let borderView = null;
    const borderVisible = borderCfg.visible !== false && String(borderCfg.scope || "fullscreen") !== "none";
    if (borderVisible) {
      const inset = Math.max(0, Number(borderCfg.inset) || 0);
      const rect = {
        x: region.x + inset,
        y: region.y + inset,
        w: Math.max(1, region.w - inset * 2),
        h: Math.max(1, region.h - inset * 2),
      };
      borderView = {
        visible: true,
        scope: String(borderCfg.scope || "fullscreen"),
        width: clamp(Number(borderCfg.width) || 4, 1, 32),
        radius: clamp(Number(borderCfg.radius) || 0, 0, 128),
        style: String(borderCfg.style || "solid"),
        color: String(borderCfg.color || "#FF7A18"),
        color_end: String(borderCfg.color_end || "#FFB347"),
        glow: String(borderCfg.glow || ""),
        animation: String(borderCfg.animation || "none"),
        animation_duration: Number(borderCfg.animation_duration) || 2,
        opacity: clamp(Number(borderCfg.opacity ?? 1), 0, 1),
        inset,
        rect,
      };
    }

    // ---- 横幅视图
    let bannerView = null;
    if (bannerCfg.visible !== false) {
      const idleRaw = bannerCfg.animation && bannerCfg.animation.idle;
      const idle = Array.isArray(idleRaw) ? idleRaw.filter((x) => x !== "none") : idleRaw && idleRaw !== "none" ? [String(idleRaw)] : [];
      bannerView = {
        visible: true,
        shape: String(bannerCfg.shape || "rect"),
        variant: String(bannerCfg.variant || "orange"),
        anchor: String(bannerCfg.anchor || "top-center"),
        offset: { x: Number(bannerCfg.offset && bannerCfg.offset.x) || 0, y: Number(bannerCfg.offset && bannerCfg.offset.y) || 0 },
        size: { w: Number(bannerCfg.size && bannerCfg.size.w) || 320, h: Number(bannerCfg.size && bannerCfg.size.h) || 96 },
        scale: Number(bannerCfg.scale) || 1,
        rotation: Number(bannerCfg.rotation) || 0,
        opacity: clamp(Number(bannerCfg.opacity ?? 1), 0, 1),
        blur: Number(bannerCfg.blur) || 0,
        padding: { x: Number(bannerCfg.padding && bannerCfg.padding.x) || 0, y: Number(bannerCfg.padding && bannerCfg.padding.y) || 0 },
        text: bannerText,
        text_color: String(bannerCfg.text_color || "#FFFFFF"),
        align: String(bannerCfg.align || "center"),
        max_lines: clamp(Number(bannerCfg.max_lines) || 2, 1, 6),
        overflow: String(bannerCfg.overflow || "ellipsis"),
        font: {
          family: String((bannerCfg.font && bannerCfg.font.family) || "system"),
          size: Number(bannerCfg.font && bannerCfg.font.size) || 15,
          weight: Number(bannerCfg.font && bannerCfg.font.weight) || 500,
          letter_spacing: Number(bannerCfg.font && bannerCfg.font.letter_spacing) || 0,
        },
        custom: {
          svg_path: String((bannerCfg.custom && bannerCfg.custom.svg_path) || ""),
          image_fit: String((bannerCfg.custom && bannerCfg.custom.image_fit) || "contain"),
          tint: String((bannerCfg.custom && bannerCfg.custom.tint) || "#FF7A18"),
        },
        animation: {
          idle,
          enter: String((bannerCfg.animation && bannerCfg.animation.enter) || "pop"),
          duration: Number(bannerCfg.animation && bannerCfg.animation.duration) || 0.35,
        },
      };
    }

    // ---- 视觉全关的底线：日志 + 一次通知 + 托盘黄色（由上层执行）
    // 注意：只有"会话进行中"才谈得上视觉全关；结束时清空视觉是正常收尾，不算告警。
    const visualOff = meta.active === true && !borderView && !bannerView;
    if (visualOff) {
      warnings.push("视觉反馈已全部关闭（边框与横幅均不渲染），中止通道/通知/声音仍然有效");
    }
    if (!meta.active) {
      borderView = null;
      bannerView = null;
    }

    // ---- 声音 / 通知：按事件 + 配置 + 免打扰 三层门控
    const dnd = inDnd(cfg);
    let sound = SOUND_BY_KIND[kind] || null;
    if (sound) {
      if (!cfg.sound.enabled) sound = null;
      else {
        const gate = SOUND_GATE[sound];
        if (gate && cfg.sound.events[gate] === false) sound = null;
        else if (dnd) sound = null;
      }
    }
    let notifyWanted = ["start", "end", "need_human", "error"].includes(kind);
    if (!cfg.notify.enabled || dnd) notifyWanted = false;

    // 最小接管时长：短会话不吵人（结束时判定；开始的通知/声音延迟到阈值后再发）
    const tooShort = Number(cfg.rules.min_takeover_ms) > 0 && durationMs < Number(cfg.rules.min_takeover_ms);
    if (!meta.active && tooShort) {
      sound = null;
      notifyWanted = false;
    }

    const tray = !meta.active ? "idle" : kind === "need_human" ? "alert" : kind === "error" ? "error" : visualOff ? "visual_off" : "active";

    return {
      active: meta.active,
      session_id: ev.session_id,
      agent: ev.agent.name,
      agent_version: ev.agent.version,
      mode: ev.mode,
      event: ev.event,
      kind,
      text: bannerView ? bannerView.text : interpolate(template, vars),
      border: borderView,
      banner: bannerView,
      region,
      display_id: (ev.scope && ev.scope.display_id) || 0,
      started_ts: meta.startedTs || now,
      ended_ts: meta.endedTs || 0,
      last_active_ts: now,
      duration_ms: durationMs,
      sound,
      notify: notifyWanted,
      notify_strong: kind === "need_human",
      tray,
      visual_off: visualOff,
      warnings,
      reason: meta.reason || "",
    };
  }
}

/** 前端契约：把 Resolved 组装成 state（字段名与 Tauri 版一致） */
function buildState(resolved, cfg, opts) {
  const display = opts.display || { x: 0, y: 0, w: 1920, h: 1080 };
  const active = Boolean(resolved && resolved.active);
  const border = active && resolved && resolved.border ? resolved.border : null;
  const banner = active && resolved && resolved.banner ? resolved.banner : null;

  return {
    seq: opts.seq,
    active,
    hidden: Boolean(opts.hidden),
    theme: String((cfg.meta && cfg.meta.theme) || "orange"),
    session_id: resolved ? resolved.session_id : "",
    agent: resolved ? resolved.agent : "",
    agent_version: resolved ? resolved.agent_version : "",
    mode: resolved ? resolved.mode : "takeover",
    event: resolved ? resolved.event : "",
    kind: resolved ? resolved.kind : "",
    text: resolved ? resolved.text : "",
    abort_label: String(cfg.text.cancel_button || "中止"),
    abort_hotkey: String(cfg.hotkeys.cancel || "Ctrl+Alt+Esc"),
    duration_text: formatDuration(resolved ? resolved.duration_ms : 0),
    viewport: { w: display.w, h: display.h },
    scale_factor: opts.scaleFactor || 1,
    region: resolved ? resolved.region : { x: display.x, y: display.y, w: display.w, h: display.h },
    border,
    banner,
    warnings: resolved ? resolved.warnings : [],
    sound: resolved ? resolved.sound : null,
  };
}

/** 空闲态：没有任何接管时的空状态（窗口隐藏） */
function idleState(cfg, opts) {
  return buildState(null, cfg, Object.assign({ hidden: false }, opts));
}

module.exports = { EventBus, buildState, idleState, interpolate, normalizeEvent, formatDuration, KIND_BY_EVENT };
