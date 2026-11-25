// Blob 形状渲染器：用三次贝塞尔曲线勾出略有不对称的有机轮廓。
// 填充层用 HTML 元素 + clip-path: path() 实现 backdrop-filter 背景模糊，
// 描边由上层 SVG 单独绘制；命中判定走 isPointInFill，失败退化外接矩形。
export const meta = { name: "blob", label: "有机曲线", kind: "builtin" };

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

function readBlur(shape) {
  const value = num(shape && shape.blur, 0);
  if (!(value > 0)) return 0;
  return Math.min(value, 64);
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

function supportsClipPathPath(doc) {
  try {
    const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
    if (win && win.CSS && typeof win.CSS.supports === "function") {
      return win.CSS.supports("clip-path", 'path("M0 0 L10 0 L10 10 Z")');
    }
  } catch (err) {
    /* 保守处理：探测失败时改用 SVG 填充 */
  }
  return false;
}

/* ---------------- 路径命中探测 ---------------- */

let probePath = null;
let probeDoc = null;

// 复用一个隐藏的 <path> 做 isPointInFill 探测
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

// 全程使用相对比例，四段贝塞尔首尾相接；左右/上下不对称以取得"有机"感
function blobPath(w, h) {
  const x = function (f) {
    return n3(w * f);
  };
  const y = function (f) {
    return n3(h * f);
  };
  const p = function (fx, fy) {
    return x(fx) + " " + y(fy);
  };
  return [
    "M" + p(0.30, 0.10),
    "C" + p(0.55, 0.02) + " " + p(0.86, 0.09) + " " + p(0.93, 0.32),
    "C" + p(0.98, 0.56) + " " + p(0.86, 0.88) + " " + p(0.62, 0.93),
    "C" + p(0.37, 0.98) + " " + p(0.09, 0.87) + " " + p(0.06, 0.62),
    "C" + p(0.03, 0.39) + " " + p(0.11, 0.16) + " " + p(0.30, 0.10),
    "Z"
  ].join(" ");
}

function makeHitPath(doc, d, w, h) {
  return {
    d: d,
    clip: 'path("' + d + '")',
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
    const blur = readBlur(shape);
    const opacity = readOpacity(shape);
    const textColor = readTextColor(shape);
    const d = blobPath(w, h);

    const root = doc.createElement("div");
    root.style.cssText = "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;";
    root.style.setProperty("--v-shape-w", n3(w) + "px");
    root.style.setProperty("--v-shape-h", n3(h) + "px");
    if (textColor) {
      root.style.color = textColor;
      root.style.setProperty("--v-text-color", textColor);
    }

    if (supportsClipPathPath(doc)) {
      const plateCss = [
        "position:absolute",
        "inset:0",
        "width:100%",
        "height:100%",
        "box-sizing:border-box",
        'clip-path:path("' + d + '")',
        "background:var(--v-surface, rgba(20,20,24,.92))",
        "opacity:" + n3(opacity)
      ];
      if (blur > 0) {
        plateCss.push("backdrop-filter:blur(" + n3(blur) + "px)");
        plateCss.push("-webkit-backdrop-filter:blur(" + n3(blur) + "px)");
      }
      const plate = doc.createElement("div");
      plate.style.cssText = plateCss.join(";") + ";";
      root.appendChild(plate);
    } else {
      // 不支持 clip-path:path() 时用 SVG 填充保证轮廓，代价是失去背景模糊
      const fillSvg = doc.createElementNS(SVG_NS, "svg");
      fillSvg.setAttribute("viewBox", "0 0 " + n3(w) + " " + n3(h));
      fillSvg.setAttribute("preserveAspectRatio", "none");
      fillSvg.setAttribute("aria-hidden", "true");
      fillSvg.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;" +
        "opacity:" + n3(opacity) + ";";
      const fillPath = doc.createElementNS(SVG_NS, "path");
      fillPath.setAttribute("d", d);
      fillPath.style.fill = "var(--v-surface, rgba(20,20,24,.92))";
      fillSvg.appendChild(fillPath);
      root.appendChild(fillSvg);
    }

    // 描边层：独立 SVG 画轮廓，避免被裁切削掉线宽
    const outline = doc.createElementNS(SVG_NS, "svg");
    outline.setAttribute("viewBox", "0 0 " + n3(w) + " " + n3(h));
    outline.setAttribute("preserveAspectRatio", "none");
    outline.setAttribute("aria-hidden", "true");
    outline.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;";
    const outlinePath = doc.createElementNS(SVG_NS, "path");
    outlinePath.setAttribute("d", d);
    outlinePath.setAttribute("fill", "none");
    outlinePath.style.stroke = "var(--v-surface-stroke, rgba(255,255,255,.18))";
    outlinePath.setAttribute("stroke-width", "1");
    outlinePath.setAttribute("stroke-linejoin", "round");
    outlinePath.setAttribute("vector-effect", "non-scaling-stroke");
    outline.appendChild(outlinePath);
    root.appendChild(outline);

    // 文字安全区：四周各收窄 12%，再扣掉 padding
    const insetX = w * 0.12 + pad.x;
    const insetY = h * 0.12 + pad.y;
    const textRect = clampRect(
      { x: insetX, y: insetY, w: w - insetX * 2, h: h - insetY * 2 },
      w,
      h
    );

    return { root: root, hitPath: makeHitPath(doc, d, w, h), textRect: textRect };
  } catch (err) {
    warn(ctx, "有机曲线渲染失败，已降级为最小可用形状：" + errText(err));
    return fallbackRect(shape, ctx);
  }
}
