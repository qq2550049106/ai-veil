"use strict";
/**
 * lib/tray-icons.js —— 运行时绘制托盘图标（对应 Tauri 版 tray_image()）
 *
 * 五种状态用颜色区分，且形状本身有细微差别（error 是实心+深色、visual_off 是黄色环），
 * 色弱用户也能靠轮廓分辨。全部用 4 倍超采样再降采样，16px 下也不毛边。
 */

const { encodePng } = require("./png");

const COLORS = {
  active: [255, 122, 24],
  alert: [255, 59, 48],
  error: [193, 18, 31],
  visual_off: [255, 214, 10],
  idle: [142, 142, 147],
};

const INK = [26, 20, 16];

/**
 * @param {"active"|"alert"|"error"|"visual_off"|"idle"} state
 * @param {number} size 像素边长（默认 32，系统会自动缩到 16/24）
 * @returns {Buffer} PNG 字节
 */
function makeTrayPng(state, size = 32) {
  const color = COLORS[state] || COLORS.idle;
  const ss = 4;
  const big = size * ss;
  const acc = new Float64Array(size * size * 4);

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const nx = (x + 0.5) / big * 2 - 1;
      const ny = (y + 0.5) / big * 2 - 1;
      const d = Math.sqrt(nx * nx + ny * ny);

      let rgba = null;
      if (d <= 0.94 && d > 0.82) {
        // 外圈：主色
        rgba = [color[0], color[1], color[2], 255];
      } else if (d <= 0.82 && d > 0.34) {
        // 环带：主色（中间留空，形成"光环"）
        rgba = [color[0], color[1], color[2], 255];
      } else if (d <= 0.34) {
        // 中心点：状态色（error 用更醒目的实心）
        rgba = state === "error" ? [color[0], color[1], color[2], 255] : [color[0], color[1], color[2], 235];
      } else if (d <= 0.94) {
        rgba = [INK[0], INK[1], INK[2], 255];
      }

      if (!rgba) continue;
      const px = Math.floor(x / ss);
      const py = Math.floor(y / ss);
      const idx = (py * size + px) * 4;
      acc[idx] += rgba[0];
      acc[idx + 1] += rgba[1];
      acc[idx + 2] += rgba[2];
      acc[idx + 3] += rgba[3];
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const per = ss * ss;
  for (let i = 0; i < out.length; i++) out[i] = Math.round(acc[i] / per);
  return encodePng(size, size, out);
}

module.exports = { makeTrayPng, COLORS };
