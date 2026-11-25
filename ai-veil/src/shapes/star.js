// 五角星形状渲染器：10 个顶点的星形多边形（几何尖角，便于 clip-path 精确表达）。
// 命中判定用 isPointInFill 做真实路径测试；文字收窄到星心 55% 宽、45% 高。
// 说明：星形为尖角轮廓，backdrop-filter 会让边缘发虚，故忽略 shape.blur。
export const meta = { name: "star", label: "五角星", kind: "builtin" };

const SVG_NS = "http://www.w3.org/2000/svg";

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

function clampRect(rect, w, h) {
  const x = Math.min(Math.max(0, num(rect.x, 0)), w);
  const y = Math.min(Math.max(0, num(rect.y, 0)), h);
  const rw = Math.max(0, Math.min(num(rect.w, 0), w - x));
  const rh = Math.max(0, Math.min(num(rect.h, 0), h - y));
  return { x: n3(x), y: n3(y), w: n3(rw), h: n3(rh) };
}

/* ---------------- 路径命中探测 ---------------- */

let probePath = null;
let probeDoc = null;

function probe(doc, d) {
  try {
    if (!probePath || probeDoc !== doc) {
      const svg = doc.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
      svg.setAttribute("aria-hidden", "true");
      svg.style.cssText =
        "position:fixed;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;";
      const path = doc.createElementNS(SVG_NS, "path");
      svg.appendChild(path);
      (doc.body || doc.documentElement).appendChild(svg);
      probePath = path;
      probeDoc = doc;
    }
    probePath.setAttribute("d", d);
    return probePath;
  } catch (err) {
    return null;
  }
}

function pathContains(doc, d, w, h, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < -2 || y < -2 || x > w + 2 || y > h + 2) return false;
  try {
    const path = probe(doc, d);
    if (path && typeof path.isPointInFill === "function") {
      let point = null;
      const win = doc.defaultView || null;
      const PointCtor = (win && win.DOMPoint) || (typeof DOMPoint !== "undefined" ? DOMPoint : null);
      if (PointCtor) {
        point = new PointCtor(x, y);
      } else {
        const svg = path.ownerSVGElement;
        if (svg && typeof svg.createSVGPoint === "function") {
          point = svg.createSVGPoint();
          point.x = x;
          point.y = y;
        }
      }
      if (point) return path.isPointInFill(point);
    }
  } catch (err) {
    /* 继续走外接矩形退化 */
  }
  return true;
}

/* ---------------- 几何计算 ---------------- */

// 标准五角星：外接半径取短边 49%，内接半径为外接的 0.382（正五角星比例）
function starPoints(w, h, scale) {
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.min(w, h) * 0.49 * scale;
  const inner = outer * 0.382;
  const points = [];
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = ((-90 + i * 36) * Math.PI) / 180;
    points.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    });
  }
  return points;
}

function starPath(w, h, scale) {
  const points = starPoints(w, h, scale);
  const parts = [];
  for (let i = 0; i < points.length; i += 1) {
    parts.push((i === 0 ? "M" : "L") + n3(points[i].x) + " " + n3(points[i].y));
  }
  parts.push("Z");
  return parts.join(" ");
}

// 星形是简单多边形，clip-path 用 polygon() 可精确表达
function starClip(w, h) {
  const points = starPoints(w, h, 1);
  const parts = [];
  for (let i = 0; i < points.length; i += 1) {
    parts.push(n3(points[i].x) + "px " + n3(points[i].y) + "px");
  }
  return "polygon(" + parts.join(", ") + ")";
}

function makeHitPath(doc, d, w, h) {
  return {
    d: d,
    clip: starClip(w, h),
    rect: { x: 0, y: 0, w: n3(w), h: n3(h) },
    contains: function contains(x, y) {
      return pathContains(doc, d, w, h, x, y);
    }
  };
}

function fallbackRect(shape, ctx) {
  try {
    const doc = docOf(ctx);
    const size = readSize(shape);
    const w = size.w;
    const h = size.h;
    const radius = Math.max(2, Math.min(h * 0.22, 24, Math.min(w, h) / 2));
    const root = doc.createElement("div");
    root.style.cssText = "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;";
    const plate = doc.createElement("div");
    plate.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;" +
      "border-radius:" + n3(radius) + "px;" +
      "background:var(--v-surface, rgba(20,20,24,.92));" +
      "border:1px solid var(--v-surface-stroke, rgba(255,255,255,.18));";
    root.appendChild(plate);
    return {
      root: root,
      hitPath: {
        d: null,
        clip: "inset(0 round " + n3(radius) + "px)",
        rect: { x: 0, y: 0, w: n3(w), h: n3(h) },
        contains: function contains(x, y) {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
          return x >= 0 && y >= 0 && x <= w && y <= h;
        }
      },
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
    const d = starPath(w, h, 1);
    const innerD = starPath(w, h, 0.72);
    const strokeWidth = Math.max(1.2, Math.min(w, h) * 0.016);

    const root = doc.createElement("div");
    root.style.cssText = "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;";
    root.style.setProperty("--v-shape-w", n3(w) + "px");
    root.style.setProperty("--v-shape-h", n3(h) + "px");
    if (textColor) {
      root.style.color = textColor;
      root.style.setProperty("--v-text-color", textColor);
    }

    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + n3(w) + " " + n3(h));
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;" +
      "opacity:" + n3(opacity) + ";";

    // 星形填充：背景板色 + 主色描边
    const body = doc.createElementNS(SVG_NS, "path");
    body.setAttribute("d", d);
    body.style.fill = "var(--v-surface, rgba(20,20,24,.92))";
    body.style.stroke = "var(--v-accent, #FF7A18)";
    body.setAttribute("stroke-width", n3(strokeWidth));
    body.setAttribute("stroke-linejoin", "round");
    svg.appendChild(body);

    // 内层细描边：增强层次感，不参与命中判定
    const innerLine = doc.createElementNS(SVG_NS, "path");
    innerLine.setAttribute("d", innerD);
    innerLine.setAttribute("fill", "none");
    innerLine.style.stroke = "var(--v-accent, #FF7A18)";
    innerLine.style.strokeOpacity = "0.3";
    innerLine.setAttribute("stroke-width", n3(Math.max(1, strokeWidth * 0.55)));
    innerLine.setAttribute("stroke-linejoin", "round");
    svg.appendChild(innerLine);

    root.appendChild(svg);

    // 文字安全区：星心 55% 宽、45% 高，再扣掉 padding
    // 文字安全区：星形中段（宽 50%、高 50%）。
    // 说明：五角星的内接五边形很小，任何文字都会压到星臂 —— 这是形状本身的几何特性，
    // 因此这里取"视觉重心"而不是"绝对不越线"；需要更宽松请调大 banner.size 或缩短文案。
    // padding 由 banner.js 统一叠加，这里不重复扣除。
    const tw = w * 0.5;
    const th = h * 0.5;
    // 文字安全区：星心 55% 宽、45% 高。
    // padding 由 banner.js 统一叠加，这里不再重复扣除（否则 96px 高的横幅只剩一行字的高度）。
    const textRect = clampRect(
      {
        x: (w - tw) / 2,
        y: (h - th) / 2,
        w: tw,
        h: th
      },
      w,
      h
    );

    return { root: root, hitPath: makeHitPath(doc, d, w, h), textRect: textRect };
  } catch (err) {
    warn(ctx, "五角星渲染失败，已降级为最小可用形状：" + errText(err));
    return fallbackRect(shape, ctx);
  }
}
