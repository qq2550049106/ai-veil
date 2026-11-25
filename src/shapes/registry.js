// 形状注册表：以固定顺序登记全部内置形状模块，并对外提供查询接口。
// 注册时校验 mod.render 必须是函数，非法模块只 console.warn 并跳过，不抛异常。
// getShape 对未知名字返回 undefined（由 banner.js 决定降级），getFallback 恒返回 rect。
import * as rect from "./rect.js";
import * as pill from "./pill.js";
import * as speechBubble from "./speech-bubble.js";
import * as cat from "./cat.js";
import * as paw from "./paw.js";
import * as blob from "./blob.js";
import * as star from "./star.js";
import * as customSvg from "./custom-svg.js";
import * as image from "./image.js";

// Map 保留插入顺序，listShapes() 依赖该顺序稳定输出
const registry = new Map();

/**
 * 登记一个形状模块。
 * @param {string} name 形状名（用于 banner.shape 匹配）
 * @param {{meta?:object, render:Function}} mod 形状模块命名空间
 * @returns {boolean} 是否登记成功
 */
export function registerShape(name, mod) {
  try {
    if (typeof name !== "string" || !name.trim()) {
      console.warn("[ai-veil] 形状注册失败：name 必须是非空字符串", name);
      return false;
    }
    if (!mod || typeof mod.render !== "function") {
      console.warn("[ai-veil] 形状注册失败：" + name + " 缺少 render() 函数，已跳过");
      return false;
    }
    registry.set(name.trim(), mod);
    return true;
  } catch (err) {
    console.warn("[ai-veil] 形状注册异常，已跳过：" + name, err);
    return false;
  }
}

/**
 * 按名字取形状模块，未知名字返回 undefined。
 * @param {string} name
 * @returns {{meta?:object, render:Function}|undefined}
 */
export function getShape(name) {
  try {
    if (typeof name !== "string") return undefined;
    return registry.get(name.trim());
  } catch (err) {
    console.warn("[ai-veil] 形状查询异常：" + name, err);
    return undefined;
  }
}

/**
 * 列出全部已注册形状（按注册顺序）。
 * @returns {Array<{name:string, label:string}>}
 */
export function listShapes() {
  const result = [];
  try {
    registry.forEach(function each(mod, name) {
      const meta = (mod && mod.meta) || {};
      const label = typeof meta.label === "string" && meta.label ? meta.label : name;
      result.push({ name: name, label: label });
    });
  } catch (err) {
    console.warn("[ai-veil] 形状列表读取失败", err);
  }
  return result;
}

/**
 * 兜底形状：rect 模块（本仓库内置，一定可用）。
 * @returns {{meta?:object, render:Function}}
 */
export function getFallback() {
  return registry.get("rect") || rect;
}

// 内置注册顺序固定：rect, pill, speech_bubble, cat, paw, blob, star, custom_svg, image
const BUILTINS = [
  ["rect", rect],
  ["pill", pill],
  ["speech_bubble", speechBubble],
  ["cat", cat],
  ["paw", paw],
  ["blob", blob],
  ["star", star],
  ["custom_svg", customSvg],
  ["image", image]
];

for (const entry of BUILTINS) {
  try {
    registerShape(entry[0], entry[1]);
  } catch (err) {
    console.warn("[ai-veil] 内置形状注册异常，已跳过：" + entry[0], err);
  }
}
