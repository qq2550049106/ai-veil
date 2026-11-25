// 对话气泡形状渲染器：圆角矩形主体 + 底部朝下的三角尾巴（尾巴固定 14px）。
// 主体用 clip-path: path() 精确裁切以获得 backdrop-filter 背景模糊；
// 描边由上层 SVG 单独绘制，避免裁切吃掉一半线宽；文字安全区自动扣掉尾巴。
export const meta = { name: "speech_bubble", label: "对话气泡", kind: "builtin" };

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

/* ---------------- 几何计算 ---------------- */

// 尾巴高度固定 14px；小尺寸时按比例收缩，避免主体被压扁
function tailHeight(h) {
  const wanted = Math.min(14, h * 0.26);
  return Math.max(4, Math.min(wanted, h * 0.4));
}

// 圆角对文字安全区的横向挤压：保证文字四角仍落在圆角内部
function cornerInset(radius, halfH, padY) {
  const rad = Math.max(0, Math.min(radius, halfH));
  const dy = Math.max(0, halfH - padY);
  if (dy >= rad || rad <= 0) return 0;
  return rad - Math.sqrt(Math.max(0, rad * rad - dy * dy));
}

// 主体圆角矩形与尾巴拼成一条闭合路径（顺时针），尾巴底点在 (w/2, bodyH + tail)
function bubblePath(w, bodyH, r, half, tail) {
  const rr = Math.max(0, Math.min(r, Math.min(w, bodyH) / 2));
  const cx = w / 2;
  const left = cx - half;
  const right = cx + half;
  const tip = bodyH + tail;
  if (rr <= 0) {
    return [
      "M0 0",
      "H" + n3(w),
      "V" + n3(bodyH),
      "L" + n3(cx) + " " + n3(tip),
      "L0 " + n3(bodyH),
      "Z"
    ].join(" ");
  }
  return [
    "M" + n3(rr) + " 0",
    "H" + n3(w - rr),
    "A" + n3(rr) + " " + n3(rr) + " 0 0 1 " + n3(w) + " " + n3(rr),
    "V" + n3(bodyH - rr),
    "A" + n3(rr) + " " + n3(rr) + " 0 0 1 " + n3(w - rr) + " " + n3(bodyH),
    "H" + n3(right),
    "L" + n3(cx) + " " + n3(tip),
    "L" + n3(left) + " " + n3(bodyH),
    "H" + n3(rr),
    "A" + n3(rr) + " " + n3(rr) + " 0 0 1 0 " + n3(bodyH - rr),
    "V" + n3(rr),
    "A" + n3(rr) + " " + n3(rr) + " 0 0 1 " + n3(rr) + " 0",
    "Z"
  ].join(" ");
}

// 圆角矩形判定（用于主体区域）
function pointInRounded(x, y, w, h, r) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  if (rad <= 0) return true;
  const cx = x < rad ? rad : x > w - rad ? w - rad : x;
  const cy = y < rad ? rad : y > h - rad ? h - rad : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rad * rad + 0.25;
}

// 尾巴三角形判定（重心坐标符号法，边界算命中）
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function makeHitPath(w, h, bodyH, r, half, d) {
  const cx = w / 2;
  return {
    d: d,
    clip: 'path("' + d + '")',
    rect: { x: 0, y: 0, w: n3(w), h: n3(h) },
    contains: function contains(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      if (x < 0 || y < 0 || x > w || y > h) return false;
      if (pointInRounded(x, y, w, bodyH, r)) return true;
      return pointInTriangle(x, y, cx - half, bodyH, cx, h, cx + half, bodyH);
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
          return pointInRounded(x, y, w, h, radius);
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
    const tail = tailHeight(h);
    const bodyH = Math.max(1, h - tail);
    const r = Math.max(2, Math.min(bodyH * 0.28, 26, Math.min(w, bodyH) / 2));
    const cx = w / 2;
    const half = Math.max(4, Math.min(w * 0.09, 15, Math.max(4, Math.min(cx - r, w - cx - r))));
    const blur = readBlur(shape);
    const opacity = readOpacity(shape);
    const textColor = readTextColor(shape);
    const d = bubblePath(w, bodyH, r, half, tail);

    const root = doc.createElement("div");
    root.style.cssText = "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;";
    root.style.setProperty("--v-shape-w", n3(w) + "px");
    root.style.setProperty("--v-shape-h", n3(h) + "px");
    root.style.setProperty("--v-shape-radius", n3(r) + "px");
    root.style.setProperty("--v-shape-tail", n3(tail) + "px");
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
      // 不支持 clip-path:path() 时用 SVG 填充保证轮廓正确，代价是失去背景模糊
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

    // 描边层：独立 SVG 画轮廓，避免被 clip-path 削掉一半线宽
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

    const insetX = Math.max(pad.x, cornerInset(r, bodyH / 2, pad.y));
    const textRect = clampRect(
      { x: insetX, y: pad.y, w: w - insetX * 2, h: bodyH - pad.y * 2 },
      w,
      h
    );

    return {
      root: root,
      hitPath: makeHitPath(w, h, bodyH, r, half, d),
      textRect: textRect
    };
  } catch (err) {
    warn(ctx, "对话气泡渲染失败，已降级为最小可用形状：" + errText(err));
    return fallbackRect(shape, ctx);
  }
}
