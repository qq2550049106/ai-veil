// 图片形状渲染器：读取 custom.svg_path（图片路径）→ imageUrl → <img> + object-fit。
// render 同步返回结构（banner.js 同步调用），图片地址在内部异步解析后挂载。
// 上层叠一层 rgba(0,0,0,.35) 遮罩保证文字可读；加载失败保留圆角底板并 warn。
export const meta = { name: "image", label: "图片", kind: "builtin" };

// 模块级提示标志：空配置只提示一次，避免逐帧刷屏
let warnedEmpty = false;

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

function readImagePath(shape) {
  const custom = (shape && shape.custom) || {};
  const value = custom.svg_path;
  return typeof value === "string" ? value.trim() : "";
}

// object-fit 只接受标准取值，非法值退回 contain
function readFit(shape) {
  const custom = (shape && shape.custom) || {};
  const value = typeof custom.image_fit === "string" ? custom.image_fit.trim().toLowerCase() : "";
  const allowed = ["contain", "cover", "fill", "none", "scale-down"];
  return allowed.indexOf(value) === -1 ? "contain" : value;
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
  const radius = radiusOf(w, h);
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

// 自绘圆角矩形：图片缺失或加载失败时的统一降级出口
function fallbackRect(shape, ctx) {
  try {
    const doc = docOf(ctx);
    const size = readSize(shape);
    const w = size.w;
    const h = size.h;
    const radius = radiusOf(w, h);
    const root = doc.createElement("div");
    root.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;overflow:hidden;" +
      "border-radius:" + n3(radius) + "px;";
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

// 图片加载失败：摘掉自身节点、恢复底板，不触碰其它子节点
function degradeInPlace(root, img, shade, plate) {
  try {
    if (img && img.parentNode === root) root.removeChild(img);
    if (shade && shade.parentNode === root) root.removeChild(shade);
    if (plate) plate.style.display = "";
  } catch (err) {
    /* 降级自身失败时保持现状，不抛异常 */
  }
}

/* ---------------- 异步图片挂载 ---------------- */

async function fillImage(root, plate, shape, ctx, doc, radius, fit, opacity) {
  const assets = ctx && ctx.assets;
  if (!assets || typeof assets.imageUrl !== "function") {
    throw new Error("素材加载器不可用");
  }
  const path = readImagePath(shape);
  const url = await assets.imageUrl(path);
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("无法生成可用地址（" + path + "）");
  }

  // 半透明遮罩：压暗底图，保证横幅文字对比度（先建好，供 onerror 降级时摘除）
  const shade = doc.createElement("div");
  shade.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,.35);pointer-events:none;";

  const img = doc.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.draggable = false;
  img.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;display:block;" +
    "object-fit:" + fit + ";object-position:center;" +
    "opacity:" + n3(opacity) + ";";
  img.addEventListener(
    "error",
    function onError() {
      warn(ctx, "图片素材加载失败：资源无法加载（" + path + "）");
      degradeInPlace(root, img, shade, plate);
    },
    { once: true }
  );
  img.src = url;
  root.appendChild(img);
  root.appendChild(shade);
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
    const path = readImagePath(shape);
    const fit = readFit(shape);
    const radius = radiusOf(w, h);

    const root = doc.createElement("div");
    root.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;overflow:hidden;" +
      "border-radius:" + n3(radius) + "px;";
    root.style.setProperty("--v-shape-w", n3(w) + "px");
    root.style.setProperty("--v-shape-h", n3(h) + "px");
    root.style.setProperty("--v-shape-radius", n3(radius) + "px");
    if (textColor) {
      root.style.color = textColor;
      root.style.setProperty("--v-text-color", textColor);
    }

    // 兜底底板：图片未就绪/加载失败时保证始终有可用形状
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
        warn(ctx, "图片素材加载失败：未配置 banner.custom.svg_path");
      }
      return { root: root, hitPath: makeHitPath(w, h), textRect: textRect };
    }

    fillImage(root, plate, shape, ctx, doc, radius, fit, opacity).catch(function onFail(err) {
      warn(ctx, "图片素材加载失败：" + errText(err));
    });

    return { root: root, hitPath: makeHitPath(w, h), textRect: textRect };
  } catch (err) {
    warn(ctx, "图片形状渲染失败：" + errText(err));
    return fallbackRect(shape, ctx);
  }
}
