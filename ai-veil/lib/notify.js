"use strict";
/**
 * lib/notify.js —— 桌面通知 + 可选截屏缩略图（Electron 版）
 *
 * 与 Tauri 版的差异（诚实记录）：
 *   - Tauri 2 没有跨平台内联图片附件，只能把截图落盘并记录路径；
 *   - Electron 的 Notification 支持 icon，但**不支持**正文内联大图，仍然是"落盘 + 日志记录路径"。
 *   两者行为一致：截图只写本机 ~/.ai-veil/logs/，绝不上传。
 */

const fs = require("node:fs");
const path = require("node:path");

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * 发一条系统通知
 * @param {{title:string, body:string, silent?:boolean, iconPath?:string}} opts
 */
function sendNotice(opts) {
  let Notification;
  try {
    ({ Notification } = require("electron"));
  } catch {
    return { ok: false, error: "不在 Electron 主进程内" };
  }
  if (!Notification || !Notification.isSupported()) return { ok: false, error: "当前系统不支持通知" };
  try {
    const notice = new Notification({
      title: String(opts.title || "AI-Veil"),
      body: String(opts.body || ""),
      silent: Boolean(opts.silent),
      timeoutType: "default",
      icon: opts.iconPath && fs.existsSync(opts.iconPath) ? opts.iconPath : undefined,
    });
    notice.show();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 截一张主屏缩略图并落盘（隐私优先：默认关闭，只在 notify.thumbnail=true 时调用）
 * @returns {Promise<{ok:boolean, path?:string, error?:string}>}
 */
async function captureThumbnail(logDir, maxWidth = 960) {
  let desktopCapturer;
  let screen;
  try {
    ({ desktopCapturer, screen } = require("electron"));
  } catch {
    return { ok: false, error: "不在 Electron 主进程内" };
  }
  try {
    const display = screen.getPrimaryDisplay();
    const ratio = display.bounds.height / Math.max(1, display.bounds.width);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(maxWidth * display.scaleFactor), height: Math.round(maxWidth * ratio * display.scaleFactor) },
      fetchWindowIcons: false,
    });
    if (!sources.length) return { ok: false, error: "拿不到屏幕画面" };
    const png = sources[0].thumbnail.toPNG();
    fs.mkdirSync(logDir, { recursive: true });
    const target = path.join(logDir, `thumb-${stamp()}.png`);
    fs.writeFileSync(target, png);
    return { ok: true, path: target, bytes: png.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { sendNotice, captureThumbnail };
