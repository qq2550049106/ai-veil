// 横幅层渲染器：选形状 → 渲染形状 → 定位 / 缩放 / 旋转 → 排版文字 → 放置中止按钮 → 应用动画。
// 同形状同尺寸时复用已有 DOM，只更新文字 / 颜色，避免 action.before 反复重建导致闪烁。
// 形状来自 src/shapes/*（本文件只调用其公开 API：getShape / getFallback / render）。
import { getShape, getFallback } from "../shapes/registry.js";
import { computeAnchor, computeTransform, originFor } from "./layout.js";
import { applyIdle, applyEnter, clearAnimations, playBlinkOnce } from "./animation.js";

const FALLBACK_FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';
const ABORT_MARGIN = 10;
const MIN_FONT_SIZE = 9;

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

function errorText(error) {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  try {
    return String(error);
  } catch (nested) {
    return "未知错误";
  }
}

/**
 * 挂载横幅层。
 * @param {HTMLElement} layerEl #banner-layer
 * @param {{assets?: object, warn?: Function, onAbortRect?: Function, abortLabel?: string|Function, hotkey?: string|Function}} ctx
 * @returns {{ update: (state: object, config: object) => void, clear: () => void, destroy: () => void }}
 */
export function mountBannerLayer(layerEl, ctx) {
  const c = ctx || {};
  const doc = document;

  let bannerEl = null;
  let innerEl = null;
  let textEl = null;
  let bodyEl = null;
  let abortEl = null;
  let shapeRoot = null;
  let hitPath = null;
  let textRect = null;
  let currentKey = "";
  let pendingEnter = true;
  let destroyed = false;

  function warn(message) {
    try {
      if (typeof c.warn === "function") c.warn(message);
      else console.warn("[AI-Veil]", message);
    } catch (error) {
      // 警告通道自身失败时不能影响渲染
    }
  }

  /** ctx 里的 abortLabel / hotkey 允许是字符串或取当前值的函数 */
  function resolveCtxString(key, fallback) {
    try {
      const raw = c[key];
      const value = typeof raw === "function" ? raw() : raw;
      if (typeof value === "string" && value.trim()) return value;
    } catch (error) {
      // 忽略
    }
    return fallback;
  }

  function normSize(banner) {
    const size = (banner && banner.size) || {};
    return {
      w: Math.max(40, num(size.w, 320)),
      h: Math.max(32, num(size.h, 96))
    };
  }

  function normPad(padding) {
    return {
      x: Math.max(0, num(padding && padding.x, 18)),
      y: Math.max(0, num(padding && padding.y, 12))
    };
  }

  function normViewport(viewport) {
    return {
      w: Math.max(1, num(viewport && viewport.w, window.innerWidth || 1)),
      h: Math.max(1, num(viewport && viewport.h, window.innerHeight || 1))
    };
  }

  function fontFamily(raw) {
    if (!raw || raw === "system") return FALLBACK_FONT;
    return String(raw);
  }

  /** textRect 允许形状返回不完整数据，统一补成可用矩形 */
  function normalizeRect(rect, size) {
    const w = num(rect && rect.w, 0);
    const h = num(rect && rect.h, 0);
    if (w > 0 && h > 0) {
      return { x: num(rect.x, 0), y: num(rect.y, 0), w, h };
    }
    const pad = 12;
    return { x: pad, y: pad, w: Math.max(8, size.w - pad * 2), h: Math.max(8, size.h - pad * 2) };
  }

  /** 最后一道兜底形状：不依赖 shapes/*，保证任何情况下都有可见图形 */
  function localShape(banner) {
    const size = normSize(banner);
    const radius = Math.min(24, Math.round(size.h / 4));
    const root = doc.createElement("div");
    root.className = "vb-fallback";
    root.style.position = "absolute";
    root.style.inset = "0";
    root.style.boxSizing = "border-box";
    root.style.borderRadius = `${radius}px`;
    root.style.background = "var(--v-surface)";
    root.style.border = "1px solid var(--v-surface-stroke)";
    root.style.boxShadow = "inset 0 1px 0 rgba(255,255,255,.16)";

    return {
      root,
      hitPath: {
        d: null,
        clip: `inset(0 round ${radius}px)`,
        rect: { x: 0, y: 0, w: size.w, h: size.h },
        contains(x, y) {
          const w = size.w;
          const h = size.h;
          const r = radius;
          if (x < 0 || y < 0 || x > w || y > h) return false;
          if (x < r && y < r) return (x - r) * (x - r) + (y - r) * (y - r) <= r * r;
          if (x > w - r && y < r) return (x - (w - r)) * (x - (w - r)) + (y - r) * (y - r) <= r * r;
          if (x < r && y > h - r) return (x - r) * (x - r) + (y - (h - r)) * (y - (h - r)) <= r * r;
          if (x > w - r && y > h - r) {
            return (x - (w - r)) * (x - (w - r)) + (y - (h - r)) * (y - (h - r)) <= r * r;
          }
          return true;
        }
      },
      textRect: { x: 12, y: 12, w: Math.max(8, size.w - 24), h: Math.max(8, size.h - 24) }
    };
  }

  function resolveFallback() {
    try {
      const mod = getFallback();
      if (mod && typeof mod.render === "function") return mod;
    } catch (error) {
      warn(`获取降级形状失败：${errorText(error)}`);
    }
    return { render: (banner) => localShape(banner) };
  }

  function resolveShape(name) {
    let mod = null;
    try {
      mod = getShape(name);
    } catch (error) {
      mod = null;
      warn(`查询形状 ${name} 失败：${errorText(error)}`);
    }
    if (mod && typeof mod.render === "function") return mod;
    return resolveFallback();
  }

  function ensureDom() {
    if (bannerEl && bannerEl.isConnected) return;

    bannerEl = doc.createElement("div");
    bannerEl.className = "veil-banner";

    innerEl = doc.createElement("div");
    innerEl.className = "vb-inner";

    textEl = doc.createElement("div");
    textEl.className = "vb-text";

    bodyEl = doc.createElement("div");
    bodyEl.className = "vb-text-body";

    textEl.appendChild(bodyEl);
    innerEl.appendChild(textEl);
    bannerEl.appendChild(innerEl);
    layerEl.appendChild(bannerEl);
    pendingEnter = true;
  }

  /** 形状渲染：同 shape 名 + 同尺寸 + 同 variant 直接复用，否则重建 */
  function syncShape(banner, state) {
    const size = normSize(banner);
    const name = String(banner.shape || "rect");
    const key = `${name}|${Math.round(size.w)}x${Math.round(size.h)}|${String(banner.variant || "")}`;
    if (key === currentKey && shapeRoot && shapeRoot.isConnected) return;

    try {
      if (shapeRoot && shapeRoot.parentNode) shapeRoot.parentNode.removeChild(shapeRoot);
    } catch (error) {
      warn(`移除旧形状节点失败：${errorText(error)}`);
    }
    shapeRoot = null;
    hitPath = null;
    textRect = null;

    const shapeCtx = {
      doc,
      assets: c.assets,
      warn,
      event: state && state.event,
      // 形状读取素材上限（max_bytes / max_px / sanitize_svg）时使用；优先取实时配置
      config: typeof c.getConfig === "function" ? c.getConfig() : c.config || null
    };

    let out = null;
    try {
      out = resolveShape(name).render(banner, shapeCtx);
    } catch (error) {
      warn(`形状 ${name} 渲染异常，已降级：${errorText(error)}`);
      out = null;
    }

    if (!out || !out.root) {
      try {
        out = resolveFallback().render(banner, shapeCtx);
      } catch (error) {
        warn(`降级形状渲染失败：${errorText(error)}`);
        out = null;
      }
    }
    if (!out || !out.root) out = localShape(banner);

    shapeRoot = out.root;
    hitPath = out.hitPath || null;
    textRect = out.textRect || null;

    try {
      if (!shapeRoot.parentNode) innerEl.insertBefore(shapeRoot, textEl);
    } catch (error) {
      warn(`挂载形状节点失败：${errorText(error)}`);
    }

    bannerEl.setAttribute("data-shape", name);
    currentKey = key;
    pendingEnter = true;
  }

  function applyLayout(banner, state) {
    const size = normSize(banner);
    const scale = Math.max(0.05, num(banner.scale, 1));
    const rotation = num(banner.rotation, 0);
    const anchor = String(banner.anchor || "top-center");
    // 注意：锚点按「未缩放」尺寸计算。因为 transform-origin 落在贴边那一侧，
    // scale 围绕该点缩放后视觉尺寸依然是 size*scale，二者不会互相打架。
    const pos = computeAnchor(anchor, banner.offset || {}, size, normViewport(state && state.viewport));

    bannerEl.style.left = "0px";
    bannerEl.style.top = "0px";
    bannerEl.style.width = `${size.w}px`;
    bannerEl.style.height = `${size.h}px`;
    bannerEl.style.transformOrigin = originFor(anchor);
    bannerEl.style.transform = computeTransform(scale, rotation, { x: pos.x, y: pos.y });
    bannerEl.setAttribute("data-anchor", anchor);
  }

  /**
   * 文字溢出策略。
   * 关键点：任何模式下如果"连最小字号装不下"，都会走 shrink 的二分收敛，
   * 避免矮形状（star/paw 的安全区很扁）把第二行字直接切掉。
   */
  function applyOverflow(banner, baseSize, availableHeight) {
    const mode = String(banner.overflow || "ellipsis");
    const maxLines = Math.max(1, Math.round(num(banner.max_lines, 2)));

    textEl.setAttribute("data-overflow", mode);
    bodyEl.style.display = "";
    bodyEl.style.webkitBoxOrient = "";
    bodyEl.style.webkitLineClamp = "";
    bodyEl.style.overflow = "";
    bodyEl.style.fontSize = `${baseSize}px`;

    if (mode === "ellipsis") {
      bodyEl.style.display = "-webkit-box";
      bodyEl.style.webkitBoxOrient = "vertical";
      bodyEl.style.webkitLineClamp = String(maxLines);
      bodyEl.style.overflow = "hidden";
      // 行数被裁掉一半时静默缩字号（比截断半行更可读）
      if (availableHeight > 0 && bodyEl.scrollHeight > availableHeight + 0.5) {
        shrinkToFit(baseSize, availableHeight);
      }
      return;
    }

    if (mode === "shrink") {
      shrinkToFit(baseSize, availableHeight);
      return;
    }

    // wrap：自然换行，装不下时同样缩字号，避免溢出安全区
    if (availableHeight > 0 && bodyEl.scrollHeight > availableHeight + 0.5) {
      shrinkToFit(baseSize, availableHeight);
    }
  }

  /** 二分收缩字号：最多 8 次迭代，下限 MIN_FONT_SIZE */
  function shrinkToFit(baseSize, availableHeight) {
    if (!(availableHeight > 0)) return;
    if (bodyEl.scrollHeight <= availableHeight + 0.5) return;
    let low = MIN_FONT_SIZE;
    let high = baseSize;
    let best = MIN_FONT_SIZE;
    for (let i = 0; i < 8 && high - low > 0.5; i += 1) {
      const mid = (low + high) / 2;
      bodyEl.style.fontSize = `${mid}px`;
      if (bodyEl.scrollHeight <= availableHeight + 0.5) {
        best = mid;
        low = mid;
      } else {
        high = mid;
      }
    }
    const finalSize = Math.max(MIN_FONT_SIZE, Math.round(best * 10) / 10);
    bodyEl.style.fontSize = `${finalSize}px`;
  }

  /**
   * padding 作为「距形状边缘的最小内边距」与形状已让出的安全区取较大者，
   * 这样形状若已把 padding 算进 textRect（不重复叠加），若没算也依然能拿到正确留白。
   */
  function resolveTextBox(rect, pad, size) {
    const padLeft = Math.max(0, pad.x - rect.x);
    const padTop = Math.max(0, pad.y - rect.y);
    const padRight = Math.max(0, pad.x - (size.w - rect.x - rect.w));
    const padBottom = Math.max(0, pad.y - (size.h - rect.y - rect.h));
    return {
      x: rect.x + padLeft,
      y: rect.y + padTop,
      w: Math.max(8, rect.w - padLeft - padRight),
      h: Math.max(8, rect.h - padTop - padBottom)
    };
  }

  function applyText(banner, state) {
    const size = normSize(banner);
    const rect = normalizeRect(textRect, size);
    const box = resolveTextBox(rect, normPad(banner.padding), size);

    // 中止按钮固定在形状右下角，这里按"能不能把按钮挪到文字下方"来决定让位方式：
    //   - 高度够：文字区减高，按钮独占底部一条（文字垂直居中在剩余区域）
    //   - 高度不够：文字区减宽，按钮独占右侧一条（文字整体左移）
    const btnW = abortEl ? abortEl.offsetWidth || 64 : 0;
    const btnH = abortEl ? abortEl.offsetHeight || 26 : 0;

    textEl.style.left = `${box.x}px`;
    textEl.style.top = `${box.y}px`;
    textEl.style.width = `${box.w}px`;
    textEl.style.height = `${box.h}px`;

    const align = String(banner.align || "center");
    bodyEl.style.textAlign = align === "left" || align === "right" ? align : "center";

    const font = banner.font || {};
    const baseSize = Math.max(MIN_FONT_SIZE, num(font.size, 15));
    bodyEl.style.fontFamily = fontFamily(font.family);
    bodyEl.style.fontWeight = String(num(font.weight, 500));
    bodyEl.style.letterSpacing = `${num(font.letter_spacing, 0.3)}px`;
    bodyEl.style.color = typeof banner.text_color === "string" && banner.text_color ? banner.text_color : "var(--v-text-color)";

    let width = box.w;
    let height = box.h;
    const abortPos = bannerEl ? bannerEl.getAttribute("data-abort-pos") : null;
    if (btnW > 0 && btnH > 0 && abortPos && abortPos !== "below") {
      const oneLine = baseSize * 1.35;
      if (abortPos === "top-right" || abortPos === "middle-right") {
        // 按钮在右侧：让出右边一条
        width = Math.max(24, width - btnW - 8);
      } else if (height >= oneLine + btnH + 10) {
        // 按钮在底部且高度够：让出底部一条
        height = Math.max(8, height - btnH - 8);
      } else {
        width = Math.max(24, width - btnW - 8);
      }
    }
    textEl.style.width = `${width}px`;
    textEl.style.height = `${height}px`;

    const text = state && typeof state.text === "string" ? state.text : "";
    if (bodyEl.textContent !== text) bodyEl.textContent = text;

    applyOverflow(banner, baseSize, height);
  }

  function applyColors(banner) {
    if (typeof banner.text_color === "string" && banner.text_color) {
      bannerEl.style.setProperty("--v-text-color", banner.text_color);
    }
    bannerEl.style.setProperty("--v-banner-opacity", String(clamp01(num(banner.opacity, 0.95))));
    bannerEl.style.setProperty("--v-banner-blur", `${Math.max(0, num(banner.blur, 20))}px`);
    bannerEl.setAttribute("data-shape", String(banner.shape || "rect"));
    bannerEl.setAttribute("data-variant", String(banner.variant || ""));
  }

  function reportRect(rect) {
    if (typeof c.onAbortRect !== "function") return;
    try {
      if (!rect) {
        c.onAbortRect(null);
        return;
      }
      c.onAbortRect({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      });
    } catch (error) {
      warn(`上报中止按钮矩形失败：${errorText(error)}`);
    }
  }

  function invokeAbort(reason) {
    try {
      const tauri = window.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
        const pending = tauri.core.invoke("abort", { reason });
        if (pending && typeof pending.catch === "function") {
          pending.catch((error) => warn(`中止请求失败：${errorText(error)}`));
        }
        return;
      }
    } catch (error) {
      warn(`中止请求异常：${errorText(error)}`);
      return;
    }
    // 浏览器预览模式：仅记录，不报错
    console.warn("[AI-Veil] 预览模式：忽略中止请求");
  }

  function onAbortClick(event) {
    try {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (abortEl) {
        abortEl.classList.add("is-pressed");
        abortEl.disabled = true;
      }
      invokeAbort("overlay button");
      // 先给出按压反馈再清空（80ms），避免「点了没反应」的观感
      setTimeout(() => {
        try {
          clear();
        } catch (error) {
          warn(`清空横幅失败：${errorText(error)}`);
        }
      }, 80);
    } catch (error) {
      warn(`中止按钮处理失败：${errorText(error)}`);
    }
  }

  /** 把中止按钮放在形状安全区内；逐个候选位置做命中测试，全都落在形状外才退到横幅下方 */
  function positionAbort(banner) {
    if (!abortEl) return;
    const scale = Math.max(0.05, num(banner.scale, 1));
    const btnW = abortEl.offsetWidth || 64;
    const btnH = abortEl.offsetHeight || 26;
    const rootEl = shapeRoot && shapeRoot.isConnected ? shapeRoot : bannerEl;
    if (!rootEl) return;

    const rect = rootEl.getBoundingClientRect();
    const margin = ABORT_MARGIN;

    // 候选位置（锚点：按钮左上角）：只信任"形状右下角"这一个位置，
    // 因为它是所有内置形状里唯一稳定落在轮廓内的角落；其余角落对五角星/爪印来说都在轮廓外。
    const candidates = [
      { name: "bottom-right", x: rect.right - btnW - margin, y: rect.bottom - btnH - margin },
      { name: "bottom-right-inset", x: rect.right - btnW - margin - 8, y: rect.bottom - btnH - margin - 8 },
    ];

    let chosen = null;
    for (const candidate of candidates) {
      if (!(rect.width > 0 && rect.height > 0)) break;
      const localX = (candidate.x + btnW / 2 - rect.left) / scale;
      const localY = (candidate.y + btnH / 2 - rect.top) / scale;
      let inside = true;
      if (hitPath && typeof hitPath.contains === "function") {
        try {
          inside = hitPath.contains(localX, localY) === true;
        } catch (error) {
          inside = false;
        }
      }
      if (inside) {
        chosen = candidate;
        break;
      }
    }

    let x;
    let y;
    if (chosen) {
      x = chosen.x;
      y = chosen.y;
      bannerEl.setAttribute("data-abort-pos", chosen.name);
    } else {
      // 形状内部找不到不压字的空位（如爪印/五角星），退到横幅正下方 8px
      x = rect.left + Math.max(0, (rect.width - btnW) / 2);
      y = rect.bottom + 8;
      bannerEl.setAttribute("data-abort-pos", "below");
    }

    // 夹紧到视口内，保证按钮永远点得到
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (vw > 0) x = Math.min(Math.max(8, x), Math.max(8, vw - btnW - 8));
    if (vh > 0) y = Math.min(Math.max(8, y), Math.max(8, vh - btnH - 8));

    abortEl.style.left = `${Math.round(x)}px`;
    abortEl.style.top = `${Math.round(y)}px`;
    abortEl.style.visibility = "visible";
    reportRect(abortEl.getBoundingClientRect());
  }

  function updateAbort(banner, state) {
    if (!abortEl) {
      abortEl = doc.createElement("button");
      abortEl.id = "veil-abort";
      abortEl.className = "veil-abort";
      abortEl.type = "button";
      abortEl.addEventListener("click", onAbortClick, false);
      layerEl.appendChild(abortEl);
    }

    const label = (state && state.abort_label) || resolveCtxString("abortLabel", "中止");
    if (abortEl.textContent !== label) abortEl.textContent = label;

    const hotkey = (state && state.abort_hotkey) || resolveCtxString("hotkey", "");
    abortEl.title = hotkey ? `${label}（${hotkey}）` : label;
    abortEl.setAttribute("aria-label", hotkey ? `${label} ${hotkey}` : label);
    positionAbort(banner);
  }

  function applyAnimations(banner) {
    const animation = (banner && banner.animation) || {};
    const isCat = String(banner.shape || "") === "cat";
    if (isCat) {
      // 猫咪的待机动画由 shapes/cat.js 自己挂在形状根节点上（idle-* 类），
      // 这里不能给容器再套一层，否则整枚横幅会跟着摆动/浮动。
      for (const name of ["blink", "wag", "float", "wiggle"]) {
        innerEl.classList.remove(`idle-${name}`);
      }
      if (shapeRoot) applyIdle(shapeRoot, animation.idle);
    } else {
      applyIdle(innerEl, animation.idle);
    }

    if (pendingEnter) {
      pendingEnter = false;
      const enter = String(animation.enter || "none").toLowerCase();
      const duration = num(animation.duration, 0.35);
      applyEnter(innerEl, enter, duration).catch(() => {
        // applyEnter 内部已兜底，这里只防止未捕获的 rejection
      });

      // cat 形状的眨眼由形状自身 CSS 处理；这里只在 wag 场景额外手动眨一次眼
      const idleText = String(Array.isArray(animation.idle) ? animation.idle.join(" ") : animation.idle || "").toLowerCase();
      if (isCat && idleText.indexOf("wag") >= 0) {
        playBlinkOnce(shapeRoot);
      }
    }
  }

  function clear() {
    try {
      if (innerEl) clearAnimations(innerEl);
    } catch (error) {
      // 忽略
    }
    try {
      if (abortEl) {
        abortEl.removeEventListener("click", onAbortClick, false);
        if (abortEl.parentNode) abortEl.parentNode.removeChild(abortEl);
      }
    } catch (error) {
      warn(`移除中止按钮失败：${errorText(error)}`);
    }
    try {
      if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    } catch (error) {
      warn(`移除横幅节点失败：${errorText(error)}`);
    }

    abortEl = null;
    bannerEl = null;
    innerEl = null;
    textEl = null;
    bodyEl = null;
    shapeRoot = null;
    hitPath = null;
    textRect = null;
    currentKey = "";
    pendingEnter = true;
    reportRect(null);
  }

  function update(state, config) {
    if (destroyed) return;
    try {
      const banner = state && state.banner;
      if (!banner || banner.visible === false || (state && state.hidden === true)) {
        clear();
        return;
      }
      ensureDom();
      syncShape(banner, state);
      applyLayout(banner, state);
      // 先放按钮再排文字：文字排版要按按钮实际尺寸决定让位方式
      updateAbort(banner, state);
      applyText(banner, state);
      applyColors(banner);
      applyAnimations(banner);
    } catch (error) {
      warn(`横幅渲染失败：${errorText(error)}`);
    }
  }

  return {
    update,
    clear,
    destroy() {
      destroyed = true;
      clear();
    }
  };
}
