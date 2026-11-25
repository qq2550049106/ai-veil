"use strict";
/**
 * lib/toml.js —— 最小 TOML 子集解析/序列化（零依赖）
 *
 * 为什么自己写：项目要求零运行时依赖、且配置样例是权威格式。只用得到 TOML 的一小撮语法：
 *   - 注释 `#`、空行
 *   - `[table]` / `[table.sub]`
 *   - `key = value`，key 可带引号、可写成 `a.b.c` 点号形式
 *   - 字符串 "…"（含 \" \\ \n \t \uXXXX 转义）与 '…'（原样）
 *   - 整数、浮点、true/false
 *   - 数组 [ … ]（可跨行、允许尾逗号、可嵌套）
 *   - 内联表 { k = v, k2 = v2 }
 *
 * 明确不支持（样例里没有，遇到就退化成字符串，不抛错）：
 *   多行字符串、日期时间、十六进制/八进制整数、表数组 [[x]]
 */

/** 去掉字符串之外的部分里的 `#` 注释 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** 括号是否配平（忽略字符串内部） */
function balanced(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth <= 0;
}

/** 在顶层（忽略字符串/括号内）按分隔符切分 */
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseKeyPath(text) {
  const raw = splitTopLevel(text.trim(), ".");
  return raw.map((part) => {
    const p = part.trim();
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      return parseValue(p);
    }
    return p;
  });
}

function parseString(text) {
  const quote = text[0];
  const body = text.slice(1, -1);
  if (quote === "'") return body;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[i + 1];
    i++;
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === '"') out += '"';
    else if (next === "\\") out += "\\";
    else if (next === "u") {
      const hex = body.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else out += "u";
    } else if (next === "U") {
      const hex = body.slice(i + 1, i + 9);
      if (/^[0-9a-fA-F]{8}$/.test(hex)) {
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 8;
      } else out += "U";
    } else out += next === undefined ? "" : next;
  }
  return out;
}

function parseValue(raw) {
  const text = String(raw).trim();
  if (text === "") return "";
  if (text.startsWith('"')) return parseString(text);
  if (text.startsWith("'")) return parseString(text);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => parseValue(part));
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const inner = text.slice(1, -1).trim();
    const table = {};
    if (!inner) return table;
    for (const pair of splitTopLevel(inner, ",")) {
      const item = pair.trim();
      if (!item) continue;
      const eq = item.indexOf("=");
      if (eq < 0) continue;
      const keyPath = parseKeyPath(item.slice(0, eq));
      assign(table, keyPath, parseValue(item.slice(eq + 1)));
    }
    return table;
  }
  if (/^[+-]?\d+$/.test(text)) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : text;
  }
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number(text);
  if (text === "inf" || text === "+inf") return Infinity;
  if (text === "-inf") return -Infinity;
  if (text === "nan") return NaN;
  // 未识别的字面量：当成字符串，宽容优先（不因一个奇怪的值毁掉整份配置）
  return text;
}

function assign(target, keyPath, value) {
  let node = target;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (!node[key] || typeof node[key] !== "object" || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[keyPath[keyPath.length - 1]] = value;
}

function ensureTable(root, keyPath) {
  let node = root;
  for (const key of keyPath) {
    if (!node[key] || typeof node[key] !== "object" || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  return node;
}

/** 解析 TOML 文本为普通对象；语法错误抛出带行号的 Error */
function parse(text) {
  const root = {};
  let cur = root;
  const lines = String(text).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      cur = ensureTable(root, parseKeyPath(header[1]));
      continue;
    }

    const kv = line.match(/^([^\s=]+)\s*=\s*(.*)$/);
    if (!kv) throw new Error(`第 ${i + 1} 行不是合法的 TOML 语句：${lines[i]}`);

    const keyPath = parseKeyPath(kv[1]);
    let rest = kv[2];
    let guard = 0;
    while (!balanced(rest) && i + 1 < lines.length && guard++ < 200) {
      i++;
      rest += "\n" + stripComment(lines[i]).trim();
    }
    assign(cur, keyPath, parseValue(rest));
  }
  return root;
}

/* ------------------------------- 序列化 ------------------------------- */

function quoteString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 只有标量/标量数组值的对象 → 用内联表表示（保持样例的书写风格） */
function isInlineTable(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((key) => {
    const v = value[key];
    if (isPlainObject(v)) return isInlineTable(v);
    if (Array.isArray(v)) return v.every((item) => !isPlainObject(item));
    return true;
  });
}

function formatValue(value) {
  if (typeof value === "string") return quoteString(value);
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(formatValue).join(", ") + "]";
  if (isPlainObject(value)) {
    const inner = Object.keys(value)
      .map((key) => `${key} = ${formatValue(value[key])}`)
      .join(", ");
    return "{ " + inner + " }";
  }
  return '""';
}

function emitTable(node, path, out) {
  const scalars = [];
  const nested = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (isPlainObject(value) && !isInlineTable(value)) nested.push([key, value]);
    else scalars.push([key, value]);
  }
  if (scalars.length && path.length) out.push(`[${path.join(".")}]`);
  for (const [key, value] of scalars) out.push(`${key} = ${formatValue(value)}`);
  if (scalars.length) out.push("");
  for (const [key, value] of nested) emitTable(value, path.concat(key), out);
}

/** 把配置对象序列化回 TOML（与 examples/config.sample.toml 的排版风格一致） */
function stringify(obj) {
  const out = [];
  emitTable(obj, [], out);
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

module.exports = { parse, stringify, parseValue, formatValue };
