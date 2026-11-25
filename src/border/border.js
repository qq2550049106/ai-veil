// 边框层渲染器：把 state.border 渲染成「环形描边 + 外发光 + 可选扫描线」。
// 尺寸 / 位置变化只更新内联样式，不重建 DOM；只有 style / animation 变化才改 data-* 属性。
// animation === "none" 时不添加任何 anim-* 类，也不创建 .vb-scan 节点。

const STYLE_NAMES = ["solid", "dashed", "dotted", "double", "gradient"];
const ANIM_NAMES = ["breathe", "dash", "scan", "pulse"];

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 挂载边框层。
 * @param {HTMLElement} layerEl  #border-layer
 * @returns {{ update: (state: object) => void, clear: () => void, destroy: () => void }}
 */
export function mountBorderLayer(layerEl) {
  let root = null;
  let glowEl = null;
  let strokeEl = null;
  let scanEl = null;
  let currentStyle = "";
  let currentAnim = "";

  /** 首次需要时创建 .veil-border 骨架；之后复用同一个节点 */
  function ensureDom() {
    if (root && root.isConnected) return root;
    root = document.createElement("div");
    root.className = "veil-border";
    root.setAttribute("data-style", "solid");
    root.setAttribute("data-anim", "none");

    glowEl = document.createElement("div");
    glowEl.className = "vb-glow";

    strokeEl = document.createElement("div");
    strokeEl.className = "vb-stroke";

    root.appendChild(glowEl);
    root.appendChild(strokeEl);
    layerEl.appendChild(root);

    currentStyle = "";
    currentAnim = "";
    return root;
  }

  /** 按 state 计算几何量（全部是遮罩窗口内的 CSS 像素） */
  function geometry(state) {
    const border = (state && state.border) || {};
    const viewport = (state && state.viewport) || {};
    const fallbackW = Math.max(1, num(viewport.w, window.innerWidth || 1));
    const fallbackH = Math.max(1, num(viewport.h, window.innerHeight || 1));
    const rect = border.rect && num(border.rect.w, 0) > 0 && num(border.rect.h, 0) > 0
      ? border.rect
      : { x: 0, y: 0, w: fallbackW, h: fallbackH };
    const inset = Math.max(0, num(border.inset, 0));

    return {
      x: num(rect.x, 0) + inset,
      y: num(rect.y, 0) + inset,
      w: Math.max(1, num(rect.w, fallbackW) - inset * 2),
      h: Math.max(1, num(rect.h, fallbackH) - inset * 2),
      radius: Math.max(0, num(border.radius, 12)),
      width: Math.max(0.5, num(border.width, 4)),
      opacity: clamp01(num(border.opacity, 1)),
      duration: Math.max(0.05, num(border.animation_duration, 2)),
      color: typeof border.color === "string" ? border.color : "",
      colorEnd: typeof border.color_end === "string" ? border.color_end : "",
      glow: typeof border.glow === "string" ? border.glow : ""
    };
  }

  /** 只改内联样式：位置 / 尺寸 / 圆角 / 透明度 / 宽度 / 时长 */
  function applyGeometry(geo) {
    root.style.left = `${geo.x}px`;
    root.style.top = `${geo.y}px`;
    root.style.width = `${geo.w}px`;
    root.style.height = `${geo.h}px`;
    root.style.borderRadius = `${geo.radius}px`;
    root.style.opacity = String(geo.opacity);
    root.style.setProperty("--v-bw", `${geo.width}px`);
    root.style.setProperty("--v-border-radius", `${geo.radius}px`);
    root.style.setProperty("--v-border-dur", `${geo.duration}s`);
    root.style.setProperty("--v-border-opacity", String(geo.opacity));

    // 逐事件覆盖色在这里落地，保证 per_event 的颜色优先级高于全局变量
    if (geo.color) root.style.setProperty("--v-border-color", geo.color);
    if (geo.colorEnd) root.style.setProperty("--v-border-color-end", geo.colorEnd);
    if (geo.glow) root.style.setProperty("--v-border-glow", geo.glow);
  }

  function applyStyleAttr(border) {
    const raw = String(border.style || "solid").toLowerCase();
    const style = STYLE_NAMES.indexOf(raw) >= 0 ? raw : "solid";
    if (style === currentStyle) return;
    currentStyle = style;
    root.setAttribute("data-style", style);
  }

  function removeScan() {
    if (scanEl && scanEl.parentNode) {
      try {
        scanEl.parentNode.removeChild(scanEl);
      } catch (error) {
        console.warn("[AI-Veil] 移除扫描线失败", error);
      }
    }
    scanEl = null;
  }

  function ensureScan() {
    if (scanEl && scanEl.isConnected) return;
    scanEl = document.createElement("div");
    scanEl.className = "vb-scan";
    root.appendChild(scanEl);
  }

  function applyAnimAttr(border) {
    const raw = String(border.animation || "none").toLowerCase();
    const anim = ANIM_NAMES.indexOf(raw) >= 0 ? raw : "none";

    if (anim === currentAnim) {
      // 已同步：仍然守住「none 不得存在扫描线」这条约束
      if (anim === "none") removeScan();
      return;
    }
    currentAnim = anim;
    root.setAttribute("data-anim", anim);

    // 先清掉全部动画类，再按需添加，绝不留旧动画残留
    for (const name of ANIM_NAMES) root.classList.remove(`anim-${name}`);

    if (anim === "none") {
      removeScan();
      return;
    }

    root.classList.add(`anim-${anim}`);
    if (anim === "scan") ensureScan();
    else removeScan();
  }

  function clear() {
    try {
      if (root && root.parentNode) root.parentNode.removeChild(root);
    } catch (error) {
      console.warn("[AI-Veil] 清空边框层失败", error);
    }
    root = null;
    glowEl = null;
    strokeEl = null;
    scanEl = null;
    currentStyle = "";
    currentAnim = "";
  }

  function update(state) {
    try {
      const border = state && state.border;
      if (!border || border.visible === false) {
        clear();
        return;
      }
      ensureDom();
      applyGeometry(geometry(state));
      applyStyleAttr(border);
      applyAnimAttr(border);
    } catch (error) {
      console.warn("[AI-Veil] 边框渲染失败：", error);
    }
  }

  return {
    update,
    clear,
    destroy() {
      clear();
    }
  };
}
