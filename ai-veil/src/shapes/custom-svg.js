// 自定义 SVG 形状渲染器：读取 custom.svg_path → 净化 → 内联 → 按 viewBox 自适应。
// render 同步返回结构（banner.js 同步调用），素材加载在内部异步完成后再替换底板。
// 任何失败都 ctx.warn("自定义 SVG 加载失败：…") 并保留自绘圆角矩形，绝不抛异常。
import { sanitizeSvg } from "./sanitize.js";

export const meta = { name: "custom_svg", label: "自定义 SVG", kind: "builtin" };

// 模块级提示标志：空配置与剥离提示各只提示一次，避免逐帧刷屏
let warnedEmpty = false;
let warnedRemoved = false;

/* ---------------- 基础工具 ---------------- */

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function n3(value) {
  return Math.round(value * 1000) / 1000;
}

function errText(err) {
  if (!err) return "未知错误";
  return err.message ? String(err.message) : String(err);
}

function warn(ctx, message) {
  try {
    if (ctx && typeof ctx.warn === "function") ctx.warn(message);
  } catch (err) {
    /* 警告通道自身失败时不再级联报错 */
  }
}

function docOf(ctx) {
  if (ctx && ctx.doc && typeof ctx.doc.createElement === "function") return ctx.doc;
  if (typeof document !== "undefined") return document;
  throw new Error("缺少可用的 Document");
}

function readSize(shape) {
  const size = (shape && shape.size) || {};
  const w = num(size.w, 0);
  const h = num(size.h, 0);
  return { w: w > 0 ? w : 320, h: h > 0 ? h : 96 };
}

function readPad(shape) {
  const pad = (shape && shape.padding) || {};
  return { x: Math.max(0, num(pad.x, 0)), y: Math.max(0, num(pad.y, 0)) };
}

function readOpacity(shape) {
  return Math.min(1, Math.max(0, num(shape && shape.opacity, 1)));
}

function readTextColor(shape) {
  const value = shape && shape.text_color;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readSvgPath(shape) {
  const custom = (shape && shape.custom) || {};
  const value = custom.svg_path;
  return typeof value === "string" ? value.trim() : "";
}

function readTint(shape) {
  const custom = (shape && shape.custom) || {};
  const value = custom.tint;
  return typeof value === "string" ? value.trim() : "";
}

// 素材上限优先取 ctx.config.assets，缺省时退回 examples/config.sample.toml 的默认值
function readLimits(ctx) {
  const config = (ctx && ctx.config) || {};
  const assets = config.assets || {};
  return {
    maxBytes: num(assets.max_bytes, 524288),
    maxPx: num(assets.max_px, 4096),
    sanitize: assets.sanitize_svg !== false
  };
}

function clampRect(rect, w, h) {
  const x = Math.min(Math.max(0, num(rect.x, 0)), w);
  const y = Math.min(Math.max(0, num(rect.y, 0)), h);
  const rw = Math.max(0, Math.min(num(rect.w, 0), w - x));
  const rh = Math.max(0, Math.min(num(rect.h, 0), h - y));
  return { x: n3(x), y: n3(y), w: n3(rw), h: n3(rh) };
}

function radiusOf(w, h) {
  return Math.max(2, Math.min(h * 0.22, 24, Math.min(w, h) / 2));
}

function roundRectPath(w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  if (rr <= 0) return "M0 0 H" + n3(w) + " V" + n3(h) + " H0 Z";
  return [
    "M" + n3(rr) + " 0",
    "H" + n3(w - rr),
    "A" + n3(rr) + " " + n3(rr) + " 0 0 1 " + n3(w) + " " + n3(rr),
    "V" + n3(h - rr),
    "A" + n3(rr) + " " + n3(rr) + " 0 0 1 " + n3(w - rr) + " " + n3(h),
    "H" + n3(rr),
    "A" + n3(rr) + " " + n3(rr) + " 0 0 1 0 " + n3(h - rr),
    "V" + n3(rr),
    "A" + n3(rr) + " " + n3(rr) + " 0 0 1 " + n3(rr) + " 0",
    "Z"
  ].join(" ");
}

function makeHitPath(w, h) {
  const radius = Math.max(2, Math.min(h * 0.22, 14, Math.min(w, h) / 2));
  return {
    d: roundRectPath(w, h, radius),
    clip: "inset(0 round " + n3(radius) + "px)",
    rect: { x: 0, y: 0, w: n3(w), h: n3(h) },
    contains: function contains(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return x >= 0 && y >= 0 && x <= w && y <= h;
    }
  };
}

function plateCss(radius, opacity) {
  return (
    "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;" +
    "border-radius:" + n3(radius) + "px;" +
    "background:var(--v-surface, rgba(20,20,24,.92));" +
    "border:1px solid var(--v-surface-stroke, rgba(255,255,255,.18));" +
    "opacity:" + n3(opacity) + ";"
  );
}

// 自绘圆角矩形：自定义素材失败时的统一降级出口
function fallbackRect(shape, ctx) {
  try {
    const doc = docOf(ctx);
    const size = readSize(shape);
    const w = size.w;
    const h = size.h;
    const radius = radiusOf(w, h);
    const root = doc.createElement("div");
    root.style.cssText = "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;";
    const plate = doc.createElement("div");
    plate.style.cssText = plateCss(radius, readOpacity(shape));
    root.appendChild(plate);
    return {
      root: root,
      hitPath: makeHitPath(w, h),
      textRect: clampRect({ x: 12, y: 10, w: w - 24, h: h - 20 }, w, h)
    };
  } catch (err) {
    return {
      root: null,
      hitPath: {
        d: null,
        clip: null,
        rect: { x: 0, y: 0, w: 320, h: 96 },
        contains: function contains() {
          return true;
        }
      },
      textRect: { x: 0, y: 0, w: 320, h: 96 }
    };
  }
}

/* ---------------- 异步素材填充 ---------------- */

// 加载 → 净化 → 内联 → tint；成功后隐藏兜底底板，失败抛出由上层统一 warn
async function fillSvg(root, plate, shape, ctx, doc, w, h, opacity) {
  const assets = ctx && ctx.assets;
  if (!assets || typeof assets.svg !== "function") {
    throw new Error("素材加载器不可用");
  }
  const path = readSvgPath(shape);
  const rawText = await assets.svg(path);
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("素材内容为空或不可读（" + path + "）");
  }

  const limits = readLimits(ctx);
  const result = sanitizeSvg(rawText, {
    maxBytes: limits.maxBytes,
    maxPx: limits.maxPx,
    sanitize: limits.sanitize,
    doc: doc
  });
  if (result.error || !result.svg) {
    throw new Error(result.error || "净化结果为空");
  }
  if (result.removed.length > 0 && !warnedRemoved) {
    warnedRemoved = true;
    warn(ctx, "自定义 SVG 已剥离不安全内容：" + result.removed.join("、"));
  }

  // 跨文档导入：sanitizeSvg 返回的是解析用文档里的节点
  const svg = doc.importNode(result.svg, true);

  // 按 viewBox 自适应：缺 viewBox 时用 width/height 或横幅尺寸补一个
  let viewBox = String(svg.getAttribute("viewBox") || "").trim();
  if (!viewBox) {
    const rawW = parseFloat(svg.getAttribute("width"));
    const rawH = parseFloat(svg.getAttribute("height"));
    if (Number.isFinite(rawW) && Number.isFinite(rawH) && rawW > 0 && rawH > 0) {
      viewBox = "0 0 " + n3(rawW) + " " + n3(rawH);
    } else {
      viewBox = "0 0 " + n3(w) + " " + n3(h);
    }
  }
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.cssText =
    "width:100%;height:100%;display:block;overflow:visible;pointer-events:none;opacity:" + n3(opacity) + ";";

  // tint 着色：在 root 上暴露 --v-tint，形状元素统一填充该变量
  const tint = readTint(shape);
  if (tint) {
    svg.setAttribute("data-tint", "1");
    root.style.setProperty("--v-tint", tint);
    const paintables = svg.querySelectorAll("path,circle,rect,polygon,ellipse");
    Array.prototype.forEach.call(paintables, function each(el) {
      el.style.fill = "var(--v-tint)";
    });
  }

  root.appendChild(svg);
  // 素材已就绪，隐藏兜底底板，避免在透明区域露出多余的方块
  if (plate) plate.style.display = "none";
}

/* ---------------- 对外渲染 ---------------- */

export function render(shape, ctx) {
  try {
    const doc = docOf(ctx);
    const size = readSize(shape);
    const w = size.w;
    const h = size.h;
    const pad = readPad(shape);
    const opacity = readOpacity(shape);
    const textColor = readTextColor(shape);
    const path = readSvgPath(shape);
    const radius = radiusOf(w, h);

    const root = doc.createElement("div");
    root.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;" +
      "display:flex;align-items:center;justify-content:center;overflow:hidden;" +
      "border-radius:" + n3(radius) + "px;";
    root.style.setProperty("--v-shape-w", n3(w) + "px");
    root.style.setProperty("--v-shape-h", n3(h) + "px");
    if (textColor) {
      root.style.color = textColor;
      root.style.setProperty("--v-text-color", textColor);
    }

    // 兜底底板：素材未就绪/加载失败时保证始终有可用形状
    const plate = doc.createElement("div");
    plate.style.cssText = plateCss(radius, opacity);
    root.appendChild(plate);

    const textRect = clampRect(
      { x: pad.x, y: pad.y, w: w - pad.x * 2, h: h - pad.y * 2 },
      w,
      h
    );

    if (!path) {
      if (!warnedEmpty) {
        warnedEmpty = true;
        warn(ctx, "自定义 SVG 加载失败：未配置 banner.custom.svg_path");
      }
      return { root: root, hitPath: makeHitPath(w, h), textRect: textRect };
    }

    fillSvg(root, plate, shape, ctx, doc, w, h, opacity).catch(function onFail(err) {
      warn(ctx, "自定义 SVG 加载失败：" + errText(err));
    });

    return { root: root, hitPath: makeHitPath(w, h), textRect: textRect };
  } catch (err) {
    warn(ctx, "自定义 SVG 加载失败：" + errText(err));
    return fallbackRect(shape, ctx);
  }
}
