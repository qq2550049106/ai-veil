// src/shapes/cat.js
// 内置 inline SVG 猫咪形状：耳朵 / 脸 / 眼睛 / 胡须 / 尾巴 + 脸下方气泡文字区。
// 支持 blink（眨眼）、wag（尾巴摆动）、float（浮动）三种待机动画，可独立开关；
// 提供橘猫 / 黑猫 / 白猫三个内置变体，用 banner.variant 切换。

export const meta = { name: "cat", label: "猫咪", kind: "builtin" };

const STYLE_ID = "veil-cat-style";

/** 三套内置配色（fur 毛色 / dark 描边 / inner 耳内 / eye 眼 / whisker 胡须 / bubble 气泡描边） */
const PALETTES = {
  orange: {
    fur: "#F5A24B",
    dark: "#C97A26",
    inner: "#FFC9D1",
    eye: "#2B2118",
    whisker: "#FFF3E6",
    nose: "#E2607A",
    bubble: "rgba(255,122,24,.85)",
  },
  black: {
    fur: "#2B2B31",
    dark: "#151519",
    inner: "#4B4B57",
    eye: "#FFE08A",
    whisker: "#D9D9DE",
    nose: "#E88FA0",
    bubble: "rgba(150,150,165,.85)",
  },
  white: {
    fur: "#F7F7F9",
    dark: "#D2D2DB",
    inner: "#FFC9D4",
    eye: "#2B2118",
    whisker: "#8A8A94",
    nose: "#E88FA0",
    bubble: "rgba(230,230,240,.9)",
  },
};

/** 待机动画：纯 CSS 关键帧，宿主元素加上 idle-* 类即生效（不注册任何 rAF） */
const CAT_CSS = `
.veil-cat { position: absolute; inset: 0; pointer-events: none; }
.veil-cat .cat-head { position: absolute; display: block; overflow: visible; }
.veil-cat .cat-bubble {
  position: absolute; box-sizing: border-box;
  background: var(--v-surface, rgba(20,20,24,.92));
  border: 2px solid var(--v-cat-stroke, rgba(255,122,24,.85));
  border-radius: 14px;
  box-shadow: 0 6px 22px rgba(0,0,0,.35), 0 0 18px var(--v-cat-glow, rgba(255,122,24,.35));
}
.veil-cat .cat-bubble-tail {
  position: absolute; width: 10px; height: 10px;
  background: var(--v-surface, rgba(20,20,24,.92));
  border-left: 2px solid var(--v-cat-stroke, rgba(255,122,24,.85));
  border-top: 2px solid var(--v-cat-stroke, rgba(255,122,24,.85));
  transform: rotate(45deg);
}
.veil-cat .cat-eyes { transform-box: fill-box; transform-origin: center center; }
.veil-cat .cat-tail { transform-box: fill-box; transform-origin: 4% 82%; }
.veil-cat .cat-head { transform-box: fill-box; transform-origin: center bottom; }

.idle-blink .veil-cat .cat-eyes,
.veil-cat.idle-blink .cat-eyes { animation: veil-cat-blink var(--v-anim-dur, 4s) infinite; }
@keyframes veil-cat-blink {
  0%, 92%, 100% { transform: scaleY(1); }
  94%, 96% { transform: scaleY(0.08); }
}

.idle-wag .veil-cat .cat-tail,
.veil-cat.idle-wag .cat-tail { animation: veil-cat-wag var(--v-anim-dur, 2.4s) ease-in-out infinite; }
@keyframes veil-cat-wag {
  0%, 100% { transform: rotate(-9deg); }
  50% { transform: rotate(13deg); }
}

.idle-float .veil-cat .cat-head,
.veil-cat.idle-float .cat-head { animation: veil-cat-float 3.2s ease-in-out infinite; }
@keyframes veil-cat-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}

.idle-wiggle .veil-cat .cat-head,
.veil-cat.idle-wiggle .cat-head { animation: veil-cat-wiggle 2.6s ease-in-out infinite; }
@keyframes veil-cat-wiggle {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(-2deg); }
  75% { transform: rotate(2deg); }
}

@media (prefers-reduced-motion: reduce) {
  .veil-cat .cat-eyes, .veil-cat .cat-tail, .veil-cat .cat-head { animation: none !important; }
}
`;

function ensureStyle(doc) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  try {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CAT_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  } catch (e) {
    /* 样式注入失败时动画失效，但形状仍可用：不抛异常 */
  }
}

function svgEl(doc, name, attrs) {
  const el = doc.createElementNS("http://www.w3.org/2000/svg", name);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
  }
  return el;
}

/** 画猫头（viewBox 160x120，宽高比 4:3，靠 preserveAspectRatio 等比缩放） */
function buildHead(doc, palette) {
  const svg = svgEl(doc, "svg", {
    class: "cat-head",
    viewBox: "0 0 160 120",
    preserveAspectRatio: "xMidYMid meet",
    "aria-hidden": "true",
  });
  svg.style.width = "100%";
  svg.style.height = "100%";

  // 尾巴：画在最底层，从右侧绕出
  const tail = svgEl(doc, "path", {
    class: "cat-tail",
    d: "M126 96 C150 100 154 70 138 60",
    fill: "none",
    stroke: palette.fur,
    "stroke-width": 9,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  // 尾巴尖
  const tailTip = svgEl(doc, "circle", {
    cx: 138,
    cy: 60,
    r: 6.5,
    fill: palette.inner,
    opacity: 0.9,
  });
  svg.appendChild(tail);
  svg.appendChild(tailTip);

  // 耳朵（先画，头会盖住耳根）
  svg.appendChild(
    svgEl(doc, "path", {
      d: "M40 40 L56 6 L76 38 Z",
      fill: palette.fur,
      stroke: palette.dark,
      "stroke-width": 2,
      "stroke-linejoin": "round",
    })
  );
  svg.appendChild(
    svgEl(doc, "path", {
      d: "M120 40 L104 6 L84 38 Z",
      fill: palette.fur,
      stroke: palette.dark,
      "stroke-width": 2,
      "stroke-linejoin": "round",
    })
  );
  // 耳内
  svg.appendChild(
    svgEl(doc, "path", { d: "M48 36 L56 16 L68 34 Z", fill: palette.inner, opacity: 0.95 })
  );
  svg.appendChild(
    svgEl(doc, "path", { d: "M112 36 L104 16 L92 34 Z", fill: palette.inner, opacity: 0.95 })
  );

  // 脸
  svg.appendChild(
    svgEl(doc, "ellipse", {
      cx: 80,
      cy: 62,
      rx: 52,
      ry: 46,
      fill: palette.fur,
      stroke: palette.dark,
      "stroke-width": 2.4,
    })
  );

  // 腮红
  svg.appendChild(
    svgEl(doc, "ellipse", { cx: 42, cy: 74, rx: 10, ry: 6, fill: palette.nose, opacity: 0.35 })
  );
  svg.appendChild(
    svgEl(doc, "ellipse", { cx: 118, cy: 74, rx: 10, ry: 6, fill: palette.nose, opacity: 0.35 })
  );

  // 眼睛（可眨眼的一组；data-part="eyes" 供 animation.js 的一次性眨眼定位）
  const eyes = svgEl(doc, "g", { class: "cat-eyes", "data-part": "eyes" });
  eyes.appendChild(svgEl(doc, "ellipse", { cx: 62, cy: 58, rx: 7.5, ry: 9, fill: palette.eye }));
  eyes.appendChild(svgEl(doc, "ellipse", { cx: 98, cy: 58, rx: 7.5, ry: 9, fill: palette.eye }));
  eyes.appendChild(
    svgEl(doc, "circle", { cx: 59.5, cy: 54.5, r: 2.4, fill: "#FFFFFF", opacity: 0.92 })
  );
  eyes.appendChild(
    svgEl(doc, "circle", { cx: 95.5, cy: 54.5, r: 2.4, fill: "#FFFFFF", opacity: 0.92 })
  );
  svg.appendChild(eyes);

  // 鼻子
  svg.appendChild(
    svgEl(doc, "path", { d: "M76 74 L84 74 L80 79 Z", fill: palette.nose, opacity: 0.95 })
  );
  // 嘴
  svg.appendChild(
    svgEl(doc, "path", {
      d: "M80 79 C80 85 74 86 71 83 M80 79 C80 85 86 86 89 83",
      fill: "none",
      stroke: palette.dark,
      "stroke-width": 1.8,
      "stroke-linecap": "round",
    })
  );

  // 胡须
  const whiskers = [
    "M36 68 L12 63",
    "M36 74 L10 74",
    "M36 80 L12 85",
    "M124 68 L148 63",
    "M124 74 L150 74",
    "M124 80 L148 85",
  ];
  for (const d of whiskers) {
    svg.appendChild(
      svgEl(doc, "path", {
        d,
        fill: "none",
        stroke: palette.whisker,
        "stroke-width": 1.6,
        "stroke-linecap": "round",
        opacity: 0.85,
      })
    );
  }
  return svg;
}

/** 降级形态：纯圆角矩形（连 SVG 都建不出来时保底） */
function fallback(doc, W, H, shape) {
  const root = doc.createElement("div");
  root.className = "veil-cat";
  const box = doc.createElement("div");
  box.style.position = "absolute";
  box.style.inset = "0";
  box.style.borderRadius = "14px";
  box.style.background = "var(--v-surface, rgba(20,20,24,.92))";
  box.style.border = "2px solid var(--v-cat-stroke, rgba(255,122,24,.85))";
  root.appendChild(box);
  const pad = shape.padding || { x: 18, y: 12 };
  return {
    root,
    hitPath: {
      d: null,
      clip: "inset(0 round 14px)",
      rect: { x: 0, y: 0, w: W, h: H },
      contains: (x, y) => x >= 0 && y >= 0 && x <= W && y <= H,
    },
    textRect: {
      x: pad.x,
      y: pad.y,
      w: Math.max(20, W - pad.x * 2),
      h: Math.max(12, H - pad.y * 2),
    },
  };
}

export function render(shape, ctx) {
  const doc = (ctx && ctx.doc) || document;
  const warn = (ctx && ctx.warn) || (() => {});
  const W = Math.max(120, Number(shape && shape.size && shape.size.w) || 320);
  const H = Math.max(48, Number(shape && shape.size && shape.size.h) || 96);

  try {
    ensureStyle(doc);
    const variant = PALETTES[shape.variant] ? shape.variant : "orange";
    const palette = { ...PALETTES[variant] };

    const tint = (shape.custom && shape.custom.tint) || "";
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(tint)) {
      palette.bubble = tint;
    }

    const root = doc.createElement("div");
    root.className = "veil-cat";
    // 待机动画：把这个形状自己支持的 idle 名加到根节点上（与 animation.js 双保险）
    const idle = Array.isArray(shape.animation && shape.animation.idle)
      ? shape.animation.idle
      : [];
    for (const name of idle) {
      if (["blink", "wag", "float", "wiggle"].includes(name)) {
        root.classList.add(`idle-${name}`);
      }
    }
    if (tint) {
      root.style.setProperty("--v-cat-stroke", tint);
      root.style.setProperty("--v-cat-glow", hexToRgba(tint, 0.35));
    } else {
      root.style.setProperty("--v-cat-stroke", palette.bubble);
      root.style.setProperty("--v-cat-glow", hexToRgba(PALETTES[variant].fur, 0.35));
    }

    // 猫头尺寸：宽高比固定 4:3，高度占整体的 60%（视觉主体），下方气泡区至少留一行半文字
    const headH = Math.min(H * 0.6, W * 0.38);
    const headW = headH / 0.75;
    const headLeft = (W - headW) / 2;
    const headTop = Math.max(0, H * 0.01);

    const head = buildHead(doc, palette);
    head.style.left = `${headLeft}px`;
    head.style.top = `${headTop}px`;
    head.style.width = `${headW}px`;
    head.style.height = `${headH}px`;
    root.appendChild(head);

    // 气泡：压住猫脸下巴约 10%，占据剩余高度作为文字区
    const margin = Math.max(3, W * 0.02);
    const bubbleTop = Math.max(headTop + headH * 0.9, H * 0.45);
    const bubbleLeft = margin;
    const bubbleW = Math.max(40, W - margin * 2);
    const bubbleH = Math.max(16, H - bubbleTop - Math.max(1, H * 0.015));
    const bubble = doc.createElement("div");
    bubble.className = "cat-bubble";
    bubble.style.left = `${bubbleLeft}px`;
    bubble.style.top = `${bubbleTop}px`;
    bubble.style.width = `${bubbleW}px`;
    bubble.style.height = `${bubbleH}px`;
    root.appendChild(bubble);

    // 气泡尖角（朝上，指向猫脸）
    const tailW = Math.max(8, Math.min(14, bubbleH * 0.5));
    const tail = doc.createElement("i");
    tail.className = "cat-bubble-tail";
    tail.style.left = `${bubbleW / 2 - tailW / 2}px`;
    tail.style.top = `${-tailW / 2 - 1}px`;
    tail.style.width = `${tailW}px`;
    tail.style.height = `${tailW}px`;
    bubble.appendChild(tail);

    // 文字安全区（不再叠加 padding，交给 banner.js）
    const safePad = 6;
    const textRect = {
      x: bubbleLeft + safePad,
      y: bubbleTop + safePad,
      w: Math.max(16, bubbleW - safePad * 2),
      h: Math.max(10, bubbleH - safePad * 2),
    };

    // 命中区：猫脸椭圆 ∪ 气泡矩形
    const cx = headLeft + headW / 2;
    const cy = headTop + headH * 0.52;
    const rx = headW * 0.34;
    const ry = headH * 0.42;
    const inEllipse = (x, y) => {
      const dx = (x - cx) / (rx || 1);
      const dy = (y - cy) / (ry || 1);
      return dx * dx + dy * dy <= 1;
    };
    const inBubble = (x, y) =>
      x >= bubbleLeft && x <= bubbleLeft + bubbleW && y >= bubbleTop && y <= bubbleTop + bubbleH;

    return {
      root,
      hitPath: {
        d: null,
        clip: null,
        rect: { x: 0, y: 0, w: W, h: H },
        contains: (x, y) => inEllipse(x, y) || inBubble(x, y),
      },
      textRect,
    };
  } catch (e) {
    warn(`猫咪形状渲染失败，已降级为圆角矩形：${e && e.message ? e.message : e}`);
    return fallback(doc, W, H, shape || {});
  }
}

function hexToRgba(hex, alpha) {
  try {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  } catch (e) {
    return `rgba(255,122,24,${alpha})`;
  }
}
