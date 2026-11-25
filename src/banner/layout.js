// 横幅布局计算：锚点定位、越界夹紧、transform 字符串与 transform-origin 推导。
// 输入输出一律是遮罩窗口内的 CSS 像素；size 传进来的是已经乘过 scale 的视觉效果尺寸。
// 纯函数，不读 DOM、不写 DOM，方便设置窗口预览复用。

const EDGE_MARGIN = 8;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 归一化视口尺寸，缺省时退回浏览器窗口尺寸，保证永远有可用值 */
function viewportSize(viewport) {
  const w = num(viewport && viewport.w, 0);
  const h = num(viewport && viewport.h, 0);
  const fallbackW = typeof window === "undefined" ? 1 : window.innerWidth || 1;
  const fallbackH = typeof window === "undefined" ? 1 : window.innerHeight || 1;
  return { w: w > 0 ? w : fallbackW, h: h > 0 ? h : fallbackH };
}

/** 单轴夹紧：至少留 EDGE_MARGIN，最多贴到对边 EDGE_MARGIN */
function clampAxis(value, size, total) {
  if (!Number.isFinite(value)) return EDGE_MARGIN;
  const upper = Math.max(EDGE_MARGIN, total - Math.max(0, size) - EDGE_MARGIN);
  return Math.min(Math.max(value, EDGE_MARGIN), upper);
}

/**
 * 计算横幅左上角坐标。
 * @param {string} anchor  top-center | top-left | top-right | bottom-center | bottom-left | bottom-right | custom
 * @param {{x:number,y:number}} offset 偏移；custom 时是绝对坐标
 * @param {{w:number,h:number}} size 视觉效果尺寸（已含 scale）
 * @param {{w:number,h:number}} viewport 遮罩窗口尺寸
 * @returns {{x:number,y:number}}
 */
export function computeAnchor(anchor, offset, size, viewport) {
  const vp = viewportSize(viewport);
  const w = Math.max(0, num(size && size.w, 0));
  const h = Math.max(0, num(size && size.h, 0));
  const ox = num(offset && offset.x, 0);
  const oy = num(offset && offset.y, 0);
  let x = (vp.w - w) / 2 + ox;
  let y = oy;

  switch (String(anchor || "top-center")) {
    case "top-left":
      x = ox;
      y = oy;
      break;
    case "top-right":
      x = vp.w - w - ox;
      y = oy;
      break;
    case "bottom-center":
      x = (vp.w - w) / 2 + ox;
      y = vp.h - h - oy;
      break;
    case "bottom-left":
      x = ox;
      y = vp.h - h - oy;
      break;
    case "bottom-right":
      x = vp.w - w - ox;
      y = vp.h - h - oy;
      break;
    case "custom":
      x = ox;
      y = oy;
      break;
    case "top-center":
    default:
      x = (vp.w - w) / 2 + ox;
      y = oy;
      break;
  }

  return { x: clampAxis(x, w, vp.w), y: clampAxis(y, h, vp.h) };
}

/**
 * 生成 CSS transform：把缩放与旋转叠在平移上。
 * anchorPoint 可传 {x, y} 作为左上角平移量；传其它对象时只取 x/y 数值。
 * @param {number} scale
 * @param {number} rotation 角度
 * @param {{x:number,y:number}|null} anchorPoint
 * @returns {string}
 */
export function computeTransform(scale, rotation, anchorPoint) {
  const s = num(scale, 1) || 1;
  const r = num(rotation, 0);
  const point = anchorPoint && typeof anchorPoint === "object" ? anchorPoint : {};
  const tx = num(point.x, 0);
  const ty = num(point.y, 0);

  const parts = [
    `translate3d(${Math.round(tx * 100) / 100}px, ${Math.round(ty * 100) / 100}px, 0)`,
    `scale(${Math.round(s * 10000) / 10000})`
  ];
  if (r !== 0) parts.push(`rotate(${Math.round(r * 1000) / 1000}deg)`);
  return parts.join(" ");
}

/**
 * 由锚点推导 transform-origin，让缩放 / 旋转围绕贴边那一侧进行，视觉上不会「飘走」。
 * @param {string} anchor
 * @returns {string}
 */
export function originFor(anchor) {
  switch (String(anchor || "top-center")) {
    case "top-left":
      return "left top";
    case "top-right":
      return "right top";
    case "bottom-center":
      return "center bottom";
    case "bottom-left":
      return "left bottom";
    case "bottom-right":
      return "right bottom";
    case "custom":
    case "top-center":
    default:
      return "center top";
  }
}
