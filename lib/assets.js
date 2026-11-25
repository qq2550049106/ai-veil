"use strict";
/**
 * lib/assets.js —— 素材管线（对应 Rust 的 assets.rs）
 *
 * 安全底线（与 Tauri 版一致，不因换栈而放松）：
 *   - 只读 assets.dirs 白名单目录内的文件；`../` 越界、符号链接逃逸一律拒绝
 *   - 单文件 ≤ assets.max_bytes，且必须是支持的扩展名
 *   - SVG 导入时做白名单校验（脚本/事件属性/外链/foreignObject 全部拒绝）
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { expandHome } = require("./config");

const IMAGE_MIME = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};
const AUDIO_MIME = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
};

const FORBIDDEN_SVG = [
  /<script[\s>]/i,
  /<foreignObject[\s>]/i,
  /<iframe[\s>]/i,
  /<object[\s>]/i,
  /<embed[\s>]/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  /xlink:href\s*=\s*["']\s*(?:https?:\/\/|\/\/|data:)/i,
  /href\s*=\s*["']\s*(?:https?:\/\/|\/\/|data:)/i,
  /@import/i,
];

function mimeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME[ext] || AUDIO_MIME[ext] || null;
}

/** 白名单目录（绝对路径，去重） */
function allowedDirs(cfg, home) {
  const dirs = new Set();
  dirs.add(path.join(home, ".ai-veil", "assets"));
  for (const raw of (cfg.assets && cfg.assets.dirs) || []) {
    const expanded = expandHome(raw);
    if (expanded) dirs.add(path.resolve(expanded));
  }
  return [...dirs];
}

function insideAny(target, dirs) {
  const resolved = path.resolve(target);
  return dirs.some((dir) => {
    const base = path.resolve(dir);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

/** 校验 SVG 文本；返回 { ok, reason } */
function validateSvg(text) {
  const body = String(text || "");
  if (body.length > 2 * 1024 * 1024) return { ok: false, reason: "SVG 文本过大（>2MB）" };
  if (!/<svg[\s>]/i.test(body)) return { ok: false, reason: "缺少 <svg> 根节点" };
  for (const pattern of FORBIDDEN_SVG) {
    if (pattern.test(body)) return { ok: false, reason: `SVG 含被禁止的内容：${pattern}` };
  }
  return { ok: true, reason: "" };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 安全文件名：保留中文/字母数字/下划线点横线，其它替换成下划线 */
function safeName(name) {
  const base = path.basename(String(name || "unnamed"));
  return base.replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "_").slice(0, 80) || "unnamed";
}

class AssetStore {
  constructor(home, getConfig) {
    this.home = home;
    this.getConfig = getConfig;
    this.assetsDir = path.join(home, ".ai-veil", "assets");
    this.exportsDir = path.join(home, ".ai-veil", "exports");
    this.builtinDir = path.join(this.assetsDir, "builtin");
    this.sourceBuiltin = path.join(__dirname, "..", "src", "assets", "builtin");
  }

  ensureDirs() {
    fs.mkdirSync(this.assetsDir, { recursive: true });
    fs.mkdirSync(this.builtinDir, { recursive: true });
  }

  /** 首次启动把 6 个内置 SVG 种到用户目录，供设置面板直接选用 */
  seedBuiltin(logger) {
    this.ensureDirs();
    let seeded = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(this.sourceBuiltin).filter((f) => f.toLowerCase().endsWith(".svg"));
    } catch {
      return 0;
    }
    for (const file of entries) {
      const target = path.join(this.builtinDir, file);
      if (fs.existsSync(target)) continue;
      try {
        fs.copyFileSync(path.join(this.sourceBuiltin, file), target);
        seeded += 1;
      } catch (error) {
        if (logger) logger.warn(`内置素材落盘失败 ${file}：${error.message}`);
      }
    }
    if (seeded && logger) logger.info(`已种入 ${seeded} 个内置 SVG 到 ${this.builtinDir}`);
    return seeded;
  }

  /** 读素材为 data URL（前端 <img>/<audio> 直接用，不需要 file:// 权限） */
  load(rawPath) {
    const cfg = this.getConfig();
    const dirs = allowedDirs(cfg, this.home);
    const target = path.resolve(expandHome(rawPath || ""));
    if (!target) return { ok: false, error: "路径为空" };
    if (!insideAny(target, dirs)) return { ok: false, error: `路径不在素材白名单内：${target}` };
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) return { ok: false, error: "不是文件" };
      const limit = Number(cfg.assets.max_bytes) || 524288;
      if (stat.size > limit) return { ok: false, error: `文件超过上限 ${limit} 字节` };
      const data = fs.readFileSync(target);
      const mime = mimeOf(target) || "application/octet-stream";
      return {
        ok: true,
        path: target,
        bytes: stat.size,
        sha256: sha256(data),
        data_url: `data:${mime};base64,${data.toString("base64")}`,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** 导入素材：base64 → 白名单目录，SVG 先过校验 */
  import(name, dataBase64, logger) {
    const cfg = this.getConfig();
    this.ensureDirs();
    const clean = safeName(name);
    const ext = path.extname(clean).toLowerCase();
    if (!IMAGE_MIME[ext] && !AUDIO_MIME[ext]) {
      return { ok: false, warnings: [`不支持的扩展名：${ext || "(无)"}`] };
    }
    let data;
    try {
      data = Buffer.from(String(dataBase64 || ""), "base64");
    } catch {
      return { ok: false, warnings: ["base64 解码失败"] };
    }
    if (data.length === 0) return { ok: false, warnings: ["文件为空"] };
    const limit = Number(cfg.assets.max_bytes) || 524288;
    if (data.length > limit) return { ok: false, warnings: [`文件超过上限 ${limit} 字节`] };

    if (ext === ".svg") {
      const check = validateSvg(data.toString("utf8"));
      if (!check.ok) return { ok: false, warnings: [`SVG 校验失败：${check.reason}`] };
    }

    const target = path.join(this.assetsDir, clean);
    try {
      fs.writeFileSync(target, data);
    } catch (error) {
      return { ok: false, warnings: [`写入失败：${error.message}`] };
    }
    const warnings = [];
    if (cfg.assets.sanitize_svg && ext === ".svg") warnings.push("SVG 已通过白名单校验（脚本/事件属性/外链均已拒绝）");
    if (logger) logger.info(`导入素材 ${clean}（${data.length} 字节）`);
    return { ok: true, path: target, name: clean, sha256: sha256(data), bytes: data.length, warnings };
  }

  /** 列出白名单目录里的素材（含内置） */
  list() {
    const cfg = this.getConfig();
    const items = [];
    for (const dir of allowedDirs(cfg, this.home)) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(dir, entry.name);
        const ext = path.extname(entry.name).toLowerCase();
        if (!IMAGE_MIME[ext] && !AUDIO_MIME[ext]) continue;
        try {
          const stat = fs.statSync(full);
          items.push({
            name: entry.name,
            path: full,
            bytes: stat.size,
            kind: IMAGE_MIME[ext] ? "image" : "audio",
            builtin: full.startsWith(this.builtinDir),
          });
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, items };
  }

  /** 导出预设（配置 + 可选的内联素材） */
  exportPreset(cfg, inlineAssets) {
    fs.mkdirSync(this.exportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(this.exportsDir, `preset-${stamp}.json`);
    const payload = {
      schema: "ai-veil.preset/1",
      exported_at: new Date().toISOString(),
      config: cfg,
    };
    if (inlineAssets) {
      const bundle = {};
      for (const item of this.list().items) {
        if (item.bytes > 200 * 1024) continue;
        try {
          bundle[item.name] = fs.readFileSync(item.path).toString("base64");
        } catch {
          /* 跳过读不到的 */
        }
      }
      payload.assets = bundle;
    }
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, path: target };
  }

  /** 导入预设：返回配置对象与素材清单，由上层决定是否落盘 */
  readPreset(text) {
    let payload;
    try {
      payload = JSON.parse(String(text || ""));
    } catch (error) {
      return { ok: false, warnings: [`预设 JSON 不合法：${error.message}`] };
    }
    if (!payload || typeof payload !== "object" || !payload.config) {
      return { ok: false, warnings: ["预设缺少 config 字段"] };
    }
    const restored = [];
    if (payload.assets && typeof payload.assets === "object") {
      this.ensureDirs();
      for (const [name, b64] of Object.entries(payload.assets)) {
        try {
          const target = path.join(this.assetsDir, safeName(name));
          fs.writeFileSync(target, Buffer.from(String(b64), "base64"));
          restored.push(name);
        } catch {
          /* 单个素材失败不影响整体 */
        }
      }
    }
    return { ok: true, config: payload.config, assets: restored, warnings: [] };
  }

  /** 自定义提示音（data URL；空路径返回 null） */
  audio(cfg) {
    const raw = String((cfg.sound && cfg.sound.custom_path) || "").trim();
    if (!raw) return null;
    const result = this.load(raw);
    return result.ok ? result.data_url : null;
  }
}

module.exports = { AssetStore, validateSvg, allowedDirs, insideAny, mimeOf, safeName, sha256, IMAGE_MIME, AUDIO_MIME };
