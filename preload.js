"use strict";
/**
 * preload.js —— 隔离世界与渲染器之间的唯一通道
 *
 * 这里刻意实现了 **Tauri 2 兼容层**（window.__TAURI__），
 * 于是 src/ 下的前端代码（overlay.js / settings.js / banner.js …）可以一行不改地跑在 Electron 上。
 *
 * 同时暴露 window.__VEIL__：Electron 原生的干净 API，供后续新代码使用。
 */

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (command, args) => ipcRenderer.invoke(`veil:${command}`, args || {});

/** 把绝对路径转成可 <img>/<audio> 使用的 URL（当前走 file://，Chromium 允许本地页面加载本地资源） */
function convertFileSrc(filePath) {
  const text = String(filePath || "");
  if (!text) return "";
  const normalized = text.replace(/\\/g, "/");
  return encodeURI(`file:///${normalized.replace(/^\/+/, "")}`);
}

const listeners = new Map();

function listen(name, handler) {
  // 通道名直接用前端传入的名字（前端用的是 "veil://state" 这种），不要再加前缀，
  // 否则主进程 send("veil://state") 与 ipcRenderer.on("veil:evt:veil://state") 对不上。
  const channel = String(name);
  const wrapped = (_event, payload) => {
    try {
      handler({ event: name, id: 0, payload });
    } catch (error) {
      // 渲染器回调抛错不能污染主进程
      console.error("[ai-veil] 事件回调异常", error);
    }
  };
  ipcRenderer.on(channel, wrapped);
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(wrapped);
  return Promise.resolve(() => {
    ipcRenderer.removeListener(channel, wrapped);
    const set = listeners.get(channel);
    if (set) set.delete(wrapped);
  });
}

contextBridge.exposeInMainWorld("__TAURI__", {
  core: { invoke, convertFileSrc },
  event: { listen },
  // 兼容极少数会探测 app/window 的代码路径；没有真实实现，返回空壳
  app: { getVersion: () => invoke("get_runtime", {}).then((r) => (r && r.version) || "1.0.0") },
});

contextBridge.exposeInMainWorld("__VEIL__", {
  platform: process.platform,
  versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
  invoke,
  convertFileSrc,
  listen,
  onState: (handler) =>
    listen("veil://state", (payload) => handler(payload && payload.payload ? payload.payload : payload)),
  onNotice: (handler) =>
    listen("veil://notice", (payload) => handler(payload && payload.payload ? payload.payload : payload)),
});
