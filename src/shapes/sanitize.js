// SVG 素材安全净化器：解析、剥离危险标签/属性、清理样式中的外部引用。
// 同时校验素材字节数与像素尺寸，超限直接返回中文错误，全程不抛异常。
// opts.sanitize=false 只会记录一条提示，黑名单剥离属于强制安全策略、不可关闭。
const SVG_NS = "http://www.w3.org/2000/svg";

// 一律整块删除的标签（SVG 语境下这些标签都可用于脚本或外链）
const BLOCKED_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "applet",
  "frame",
  "frameset",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "meta",
  "base",
  "audio",
  "video",
  "canvas",
  "source",
  "track"
]);

/* ---------------- 基础工具 ---------------- */

function errText(err) {
  if (!err) return "未知错误";
  return err.message ? String(err.message) : String(err);
}

function trimNum(value) {
  return Math.round(value * 100) / 100;
}

function pushOnce(list, item) {
  if (list.indexOf(item) === -1) list.push(item);
}

function removeNode(node) {
  try {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  } catch (err) {
    /* 已脱离文档时忽略 */
  }
}

function positiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// UTF-8 字节数：优先 TextEncoder，退化时按码点估算
function utf8Bytes(text) {
  try {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  } catch (err) {
    /* 退化到手工估算 */
  }
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) total += 1;
    else if (code < 0x800) total += 2;
    else if (code < 0x10000) total += 3;
    else total += 4;
  }
  return total;
}

function parseLength(raw) {
  if (raw === null || raw === undefined) return null;
  const matched = String(raw).trim().match(/^(-?\d+(?:\.\d+)?)\s*(px)?$/i);
  if (!matched) return null;
  const value = parseFloat(matched[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ---------------- 样式文本清理 ---------------- */

// 清除 @import、指向外部协议的 url()、javascript: 与 expression(
// 注意：url(#gradient) 与 data: 内联数据属于合法引用，必须保留
function cleanCssText(css) {
  let out = String(css || "");
  out = out.replace(/@import[^;]*;?/gi, "");
  out = out.replace(/url\(\s*(['"]?)\s*(?!#|data:)[^)]*\)/gi, "none");
  out = out.replace(/javascript\s*:/gi, "");
  out = out.replace(/expression\s*\(/gi, "");
  return out;
}

function sanitizeCssElement(el, removed) {
  const raw = String(el.textContent || "");
  const hadImport = /@import/i.test(raw);
  const hadRemote = /url\(\s*['"]?\s*(?!#|data:)/i.test(raw);
  const cleaned = cleanCssText(raw);
  if (!cleaned.trim()) {
    removeNode(el);
    pushOnce(removed, "<style> 内的外部样式规则");
    return;
  }
  if (cleaned !== raw) {
    el.textContent = cleaned;
    if (hadImport) pushOnce(removed, "<style> 内的 @import");
    if (hadRemote) pushOnce(removed, "<style> 内的 url(http…)");
  }
}

/* ---------------- 属性与节点清理 ---------------- */

function dropUnsafeAttributes(el, removed) {
  const attrs = Array.from(el.attributes || []);
  for (const attr of attrs) {
    const name = String(attr.name || "").toLowerCase();
    const value = String(attr.value || "");
    // 所有 on* 事件属性
    if (name.indexOf("on") === 0) {
      el.removeAttribute(attr.name);
      pushOnce(removed, name + " 属性");
      continue;
    }
    // href / xlink:href：只允许同文档片段引用 #id
    if (name === "href" || name.slice(-5) === ":href") {
      if (value.trim().charAt(0) !== "#") {
        el.removeAttribute(attr.name);
        pushOnce(removed, name + " 外部引用");
      }
      continue;
    }
    // src / srcset 一律移除：素材只允许自包含矢量
    if (name === "src" || name === "srcset") {
      el.removeAttribute(attr.name);
      pushOnce(removed, name + " 属性");
      continue;
    }
    // 内联 style 走同一套清理
    if (name === "style") {
      const cleaned = cleanCssText(value);
      if (cleaned !== value) {
        el.setAttribute(attr.name, cleaned);
        pushOnce(removed, "style 内不安全样式");
      }
      continue;
    }
    // 其它属性值里的 javascript: 协议
    if (/javascript\s*:/i.test(value)) {
      el.removeAttribute(attr.name);
      pushOnce(removed, name + " 属性内的 javascript: 协议");
      continue;
    }
  }
}

function sanitizeNode(el, removed) {
  const tag = String(el.nodeName || "").toLowerCase();
  if (BLOCKED_TAGS.has(tag)) {
    pushOnce(removed, "<" + tag + "> 标签");
    removeNode(el);
    return;
  }
  if (tag === "style") sanitizeCssElement(el, removed);
  dropUnsafeAttributes(el, removed);
  const children = Array.from(el.childNodes || []);
  for (const child of children) {
    if (child.nodeType === 1) sanitizeNode(child, removed);
  }
}

/* ---------------- 尺寸与解析错误 ---------------- */

function findParseError(parsed) {
  try {
    const direct = parsed.getElementsByTagName("parsererror");
    if (direct && direct.length > 0) {
      const detail = String(direct[0].textContent || "").trim().slice(0, 300);
      return detail || "XML 语法错误";
    }
    const byNs = parsed.getElementsByTagNameNS
      ? parsed.getElementsByTagNameNS("*", "parsererror")
      : null;
    if (byNs && byNs.length > 0) {
      const detail = String(byNs[0].textContent || "").trim().slice(0, 300);
      return detail || "XML 语法错误";
    }
  } catch (err) {
    /* 查询失败时交由根节点校验兜底 */
  }
  return null;
}

// 同时读取 viewBox 与 width/height，取较大值做上限校验（保守判定）
function measureSvg(svg) {
  let vbW = 0;
  let vbH = 0;
  const viewBox = String(svg.getAttribute("viewBox") || "").trim();
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    const valid = parts.length === 4 && parts.every(function each(v) {
      return Number.isFinite(v);
    });
    if (valid && parts[2] > 0 && parts[3] > 0) {
      vbW = parts[2];
      vbH = parts[3];
    }
  }
  const attrW = parseLength(svg.getAttribute("width"));
  const attrH = parseLength(svg.getAttribute("height"));
  return {
    w: Math.max(vbW, attrW === null ? 0 : attrW),
    h: Math.max(vbH, attrH === null ? 0 : attrH)
  };
}

/* ---------------- 对外接口 ---------------- */

/**
 * 净化 SVG 文本。
 * @param {string} rawText 原始 SVG 文本
 * @param {{maxBytes?:number,maxPx?:number,sanitize?:boolean,doc?:Document}} opts
 * @returns {{svg: SVGSVGElement|null, removed: string[], error: string|null}}
 */
export function sanitizeSvg(rawText, opts) {
  const options = opts || {};
  const removed = [];
  const text = typeof rawText === "string" ? rawText : "";
  const doc = options.doc || (typeof document !== "undefined" ? document : null);
  if (!doc) {
    return { svg: null, removed: removed, error: "缺少可用的 Document，无法解析素材" };
  }

  const maxBytes = positiveOrNull(options.maxBytes);
  const maxPx = positiveOrNull(options.maxPx);

  const bytes = utf8Bytes(text);
  if (maxBytes !== null && bytes > maxBytes) {
    return {
      svg: null,
      removed: removed,
      error: "素材大小 " + bytes + " 字节超出上限 " + maxBytes + " 字节"
    };
  }
  if (!text.trim()) {
    return { svg: null, removed: removed, error: "素材内容为空" };
  }

  let parsed = null;
  try {
    const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
    if (!win || typeof win.DOMParser !== "function") {
      return { svg: null, removed: removed, error: "当前环境缺少 DOMParser" };
    }
    parsed = new win.DOMParser().parseFromString(text, "image/svg+xml");
  } catch (err) {
    return { svg: null, removed: removed, error: "素材解析失败：" + errText(err) };
  }

  const parseError = findParseError(parsed);
  if (parseError) {
    return { svg: null, removed: removed, error: "素材解析失败：" + parseError };
  }

  const root = parsed.documentElement;
  if (!root || String(root.nodeName).toLowerCase() !== "svg") {
    return { svg: null, removed: removed, error: "素材根节点不是 <svg>，已拒绝加载" };
  }
  if (root.namespaceURI && root.namespaceURI !== SVG_NS) {
    return { svg: null, removed: removed, error: "素材命名空间不是 SVG，已拒绝加载" };
  }

  try {
    sanitizeNode(root, removed);
  } catch (err) {
    return { svg: null, removed: removed, error: "素材净化失败：" + errText(err) };
  }

  if (options.sanitize === false) {
    pushOnce(removed, "配置已关闭素材净化（sanitize=false），黑名单剥离仍强制生效");
  }

  const size = measureSvg(root);
  if (maxPx !== null && (size.w > maxPx || size.h > maxPx)) {
    return {
      svg: null,
      removed: removed,
      error: "素材尺寸 " + trimNum(size.w) + "×" + trimNum(size.h) + " 超出上限 " + maxPx + " px"
    };
  }

  return { svg: root, removed: removed, error: null };
}
