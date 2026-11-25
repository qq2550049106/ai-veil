// 爪印形状渲染器：1 个掌垫 + 4 个脚趾的 SVG 路径轮廓，内部半透明填充。
// 命中判定用 SVGGeometryElement.isPointInFill 做真实路径测试，失败退化外接矩形。
// 说明：爪印由多个椭圆拼成，边缘不连续，backdrop-filter 会破坏轮廓，故忽略 shape.blur。
export const meta = { name: "paw", label: "爪印", kind: "builtin" };

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

// 复用一个隐藏的 <path> 做 isPointInFill 探测，避免每次判定都创建节点
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

// 真实路径命中：先用外接矩形粗筛，再走 isPointInFill，异常时退化为粗筛结果
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

// 两个半圆弧拼成的椭圆子路径，统一顺时针，保证多子路径并集可被填充命中
function ellipsePath(cx, cy, rx, ry) {
  const x0 = cx - rx;
  const x1 = cx + rx;
  return (
    "M" + n3(x0) + " " + n3(cy) +
    " A" + n3(rx) + " " + n3(ry) + " 0 0 1 " + n3(x1) + " " + n3(cy) +
    " A" + n3(rx) + " " + n3(ry) + " 0 0 1 " + n3(x0) + " " + n3(cy) + " Z"
  );
}

function pawGeometry(w, h) {
  return {
    palm: { cx: w / 2, cy: h * 0.665, rx: w * 0.29, ry: h * 0.27 },
    toes: [
      { cx: w * 0.205, cy: h * 0.36, rx: w * 0.082, ry: h * 0.112 },
      { cx: w * 0.385, cy: h * 0.255, rx: w * 0.088, ry: h * 0.122 },
      { cx: w * 0.615, cy: h * 0.255, rx: w * 0.088, ry: h * 0.122 },
      { cx: w * 0.795, cy: h * 0.36, rx: w * 0.082, ry: h * 0.112 }
    ]
  };
}

function pawPath(w, h) {
  const geo = pawGeometry(w, h);
  const parts = [ellipsePath(geo.palm.cx, geo.palm.cy, geo.palm.rx, geo.palm.ry)];
  for (const toe of geo.toes) {
    parts.push(ellipsePath(toe.cx, toe.cy, toe.rx, toe.ry));
  }
  return parts.join(" ");
}

function makeHitPath(doc, d, w, h) {
  return {
    d: d,
    // 爪印是多段椭圆并集，clip-path 无法精确表达，故为 null
    clip: null,
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
    const strokeWidth = Math.max(1.5, Math.min(w, h) * 0.028);
    const d = pawPath(w, h);
    const geo = pawGeometry(w, h);

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

    // 掌内衬底：主色微透明，让文字在爪心更易读
    const backer = doc.createElementNS(SVG_NS, "ellipse");
    backer.setAttribute("cx", n3(geo.palm.cx));
    backer.setAttribute("cy", n3(geo.palm.cy + geo.palm.ry * 0.06));
    backer.setAttribute("rx", n3(geo.palm.rx * 0.62));
    backer.setAttribute("ry", n3(geo.palm.ry * 0.58));
    backer.style.fill = "var(--v-accent, #FF7A18)";
    backer.setAttribute("fill-opacity", "0.16");
    backer.setAttribute("aria-hidden", "true");
    svg.appendChild(backer);

    // 爪印轮廓：内部半透明填充 + 主色描边
    const silhouette = doc.createElementNS(SVG_NS, "path");
    silhouette.setAttribute("d", d);
    silhouette.style.fill = "var(--v-surface, rgba(20,20,24,.92))";
    silhouette.setAttribute("fill-opacity", "0.55");
    silhouette.style.stroke = "var(--v-accent, #FF7A18)";
    silhouette.setAttribute("stroke-width", n3(strokeWidth));
    silhouette.setAttribute("stroke-linejoin", "round");
    svg.appendChild(silhouette);
    root.appendChild(svg);

    // 文字安全区收窄到掌内（避开四趾）。
    // 注意：这里不再预先扣除 banner.padding —— 契约规定 padding 由 banner.js 统一叠加，
    // 否则小尺寸横幅会被扣两次 padding，文字区直接归零。
    const textRect = clampRect(
      {
        x: geo.palm.cx - geo.palm.rx * 0.86,
        y: geo.palm.cy - geo.palm.ry * 0.62,
        w: geo.palm.rx * 1.72,
        h: geo.palm.ry * 1.5
      },
      w,
      h
    );

    return { root: root, hitPath: makeHitPath(doc, d, w, h), textRect: textRect };
  } catch (err) {
    warn(ctx, "爪印渲染失败，已降级为最小可用形状：" + errText(err));
    return fallbackRect(shape, ctx);
  }
}
