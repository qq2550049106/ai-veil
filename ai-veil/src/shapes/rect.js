// 圆角矩形形状渲染器：负责背景板、顶部高光与圆角命中判定。
// 只生成本地 DOM 结构并返回几何信息，不渲染文字、不设置 transform。
// 颜色取自 CSS 变量（带后备值）；blur 通过 backdrop-filter 实现。
export const meta = { name: "rect", label: "圆角矩形", kind: "builtin" };

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

/* ---------------- 几何计算 ---------------- */

// 圆角对文字安全区的横向挤压：保证文字四角仍落在圆角内部
function cornerInset(radius, halfH, padY) {
  const rad = Math.max(0, Math.min(radius, halfH));
  const dy = Math.max(0, halfH - padY);
  if (dy >= rad || rad <= 0) return 0;
  return rad - Math.sqrt(Math.max(0, rad * rad - dy * dy));
}

// 顺时针的真实圆角矩形路径（d 可直接用于调试与描边）
function roundRectPath(w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  if (rr <= 0) {
    return "M0 0 H" + n3(w) + " V" + n3(h) + " H0 Z";
  }
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

// 圆角矩形的真实几何命中判定（四个角用 1/4 圆判定）
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

function makeHitPath(w, h, r) {
  return {
    d: roundRectPath(w, h, r),
    clip: "inset(0 round " + n3(r) + "px)",
    rect: { x: 0, y: 0, w: n3(w), h: n3(h) },
    contains: function contains(x, y) {
      return pointInRounded(x, y, w, h, r);
    }
  };
}

// 自绘的最小可用圆角矩形（所有降级路径的唯一出口，内部再兜一层 try）
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
      hitPath: makeHitPath(w, h, radius),
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
    const radius = Math.max(2, Math.min(h * 0.24, 28, Math.min(w, h) / 2));
    const blur = readBlur(shape);
    const opacity = readOpacity(shape);
    const textColor = readTextColor(shape);

    const root = doc.createElement("div");
    root.style.cssText = "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;";
    root.style.setProperty("--v-shape-w", n3(w) + "px");
    root.style.setProperty("--v-shape-h", n3(h) + "px");
    root.style.setProperty("--v-shape-radius", n3(radius) + "px");
    if (textColor) {
      root.style.color = textColor;
      root.style.setProperty("--v-text-color", textColor);
    }

    const plateCss = [
      "position:absolute",
      "inset:0",
      "width:100%",
      "height:100%",
      "box-sizing:border-box",
      "overflow:hidden",
      "border-radius:" + n3(radius) + "px",
      "background:var(--v-surface, rgba(20,20,24,.92))",
      "border:1px solid var(--v-surface-stroke, rgba(255,255,255,.18))",
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.14)",
      "opacity:" + n3(opacity)
    ];
    if (blur > 0) {
      plateCss.push("backdrop-filter:blur(" + n3(blur) + "px)");
      plateCss.push("-webkit-backdrop-filter:blur(" + n3(blur) + "px)");
    }
    const plate = doc.createElement("div");
    plate.style.cssText = plateCss.join(";") + ";";

    // 顶部高光：一半高度的柔和白色渐变，制造玻璃质感
    const sheen = doc.createElement("div");
    sheen.style.cssText =
      "position:absolute;left:0;right:0;top:0;height:52%;box-sizing:border-box;pointer-events:none;" +
      "border-radius:" + n3(radius) + "px " + n3(radius) + "px 0 0;" +
      "background:linear-gradient(180deg, rgba(255,255,255,.20), rgba(255,255,255,0));";
    plate.appendChild(sheen);
    root.appendChild(plate);

    const insetX = Math.max(pad.x, cornerInset(radius, h / 2, pad.y));
    const textRect = clampRect(
      { x: insetX, y: pad.y, w: w - insetX * 2, h: h - pad.y * 2 },
      w,
      h
    );

    return { root: root, hitPath: makeHitPath(w, h, radius), textRect: textRect };
  } catch (err) {
    warn(ctx, "圆角矩形渲染失败，已降级为最小可用形状：" + errText(err));
    return fallbackRect(shape, ctx);
  }
}
