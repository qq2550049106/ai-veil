// Electron 版功能自检（纯 Node，不需要 Electron 运行时）
//   node _veil_electron_test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// 本脚本放在 <项目>/scripts/ 下，项目根 = 上一级
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toml = require(path.join(ROOT, "lib/toml.js"));
const configLib = require(path.join(ROOT, "lib/config.js"));
const { EventBus, buildState } = require(path.join(ROOT, "lib/event-bus.js"));

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? "  · " + detail : ""}`);
  } else {
    fail++;
    failures.push(name + (detail ? " · " + detail : ""));
    console.log(`FAIL  ${name}${detail ? "  · " + detail : ""}`);
  }
}

/* ---------- 1. TOML 解析：样例 = 权威 ---------- */
const sampleText = fs.readFileSync(path.join(ROOT, "examples/config.sample.toml"), "utf8");
const sample = toml.parse(sampleText);

function leaves(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) leaves(v, p, out);
    else out[p] = v;
  }
  return out;
}
const sampleLeaves = leaves(sample);
const defaultLeaves = leaves(configLib.DEFAULT);

// per_event 的子键是自由事件名，单独比
const perEventPrefix = "border.per_event.";
const sampleKeys = Object.keys(sampleLeaves).filter((k) => !k.startsWith(perEventPrefix));
const defaultKeys = Object.keys(defaultLeaves).filter((k) => !k.startsWith(perEventPrefix));

ok("样例叶子键数量 = 93", Object.keys(sampleLeaves).length === 93, `${Object.keys(sampleLeaves).length} 个`);
ok("默认配置叶子键与样例键集合一致", JSON.stringify(sampleKeys.sort()) === JSON.stringify(defaultKeys.sort()), `样例 ${sampleKeys.length} / 默认 ${defaultKeys.length}`);

const mismatched = [];
for (const key of sampleKeys) {
  const a = JSON.stringify(sampleLeaves[key]);
  const b = JSON.stringify(defaultLeaves[key]);
  if (a !== b) mismatched.push(`${key}: 样例=${a} 默认=${b}`);
}
ok("默认值与样例逐键相同", mismatched.length === 0, mismatched.slice(0, 5).join(" | "));

/* ---------- 2. TOML 往返 ---------- */
const regenerated = toml.stringify(configLib.DEFAULT);
const reparsed = toml.parse(regenerated);
const roundtripLeaves = leaves(reparsed);
const rtDiff = Object.keys(defaultLeaves).filter((k) => JSON.stringify(defaultLeaves[k]) !== JSON.stringify(roundtripLeaves[k]));
ok("默认配置 stringify→parse 往返无损", rtDiff.length === 0, rtDiff.slice(0, 5).join(","));

/* ---------- 3. 深合并：半个表也补齐（对应 Rust 侧 Offset2/Padding2 修复） ---------- */
const partial = configLib.buildConfig({ banner: { padding: { x: 20 } }, border: { per_event: { need_human: { color: "#00FF00" } } } });
ok("padding 只写 x 时 y 回到默认 12", partial.config.banner.padding.y === 12, `y=${partial.config.banner.padding.y}`);
ok("padding.x 保留用户值 20", partial.config.banner.padding.x === 20);
ok("缺 offset 时默认 y=24", partial.config.banner.offset.y === 24, `y=${partial.config.banner.offset.y}`);
ok("per_event 覆盖项与默认项合并", partial.config.border.per_event.need_human.width === 6 && partial.config.border.per_event.need_human.color === "#00FF00");

/* ---------- 4. 归一化：非法值钳制 + 中文告警 ---------- */
const bad = configLib.buildConfig({
  meta: { theme: "purple" },
  border: { width: 99, color: "red", animation: "wobble" },
  banner: { size: { w: 10, h: 9999 }, max_lines: 99, animation: { idle: ["blink", "nope"] } },
  sound: { volume: 5, throttle_ms: -3 },
  rules: { ttl_ms: 10, dnd_start: "25:99" },
  hotkeys: { cancel: "  " },
  privacy: { upload_enabled: true },
});
ok("非法主题回退 orange", bad.config.meta.theme === "orange");
ok("border.width 钳到 32", bad.config.border.width === 32);
ok("非法颜色回退 #FF7A18", bad.config.border.color === "#FF7A18");
ok("非法动画回退 none", bad.config.border.animation === "none");
ok("banner.size 上下钳制", bad.config.banner.size.w === 120 && bad.config.banner.size.h === 800);
ok("max_lines 钳到 6", bad.config.banner.max_lines === 6);
ok("idle 过滤非法动画名", JSON.stringify(bad.config.banner.animation.idle) === '["blink"]');
ok("sound.volume 钳到 1", bad.config.sound.volume === 1);
ok("throttle_ms 负数置 0", bad.config.sound.throttle_ms === 0);
ok("ttl_ms 过小回退 30000", bad.config.rules.ttl_ms === 30000);
ok("dnd_start 非法清空", bad.config.rules.dnd_start === "");
ok("中止热键为空时回退", bad.config.hotkeys.cancel === "Ctrl+Alt+Esc");
ok("upload_enabled 强制 false", bad.config.privacy.upload_enabled === false);
ok("告警是中文且非空", bad.warnings.length >= 8 && bad.warnings.every((w) => /[\u4e00-\u9fa5]/.test(w)), `${bad.warnings.length} 条`);

/* ---------- 5. 事件总线 ---------- */
const display = { x: 0, y: 0, w: 1920, h: 1080 };
const mockLines = fs
  .readFileSync(path.join(ROOT, "examples/mock-events.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

{
  const bus = new EventBus();
  const cfg = configLib.buildConfig({}).config;
  let now = mockLines[0].ts;

  const start = bus.ingest(mockLines[0], cfg, now, display);
  ok("session.start 被接收", start.ok, start.reason);
  ok("横幅可见且文案含 Agent 名", !!start.resolved.banner && start.resolved.banner.text.includes("deepseek-harness"), start.resolved.banner && start.resolved.banner.text);
  ok("边框可见（全屏）", !!start.resolved.border && start.resolved.border.rect.w === 1920);
  ok("开始事件要求通知+声音", start.resolved.notify === true && start.resolved.sound === "start");
  ok("托盘状态 active", start.resolved.tray === "active");

  const dup = bus.ingest(mockLines[0], cfg, now + 100, display);
  ok("5 秒内重复事件被去重", !dup.ok, dup.reason);

  const state = buildState(start.resolved, cfg, { seq: 1, hidden: false, display, scaleFactor: 1 });
  ok("state 契约字段齐全", ["seq", "active", "hidden", "theme", "session_id", "agent", "kind", "text", "abort_label", "abort_hotkey", "duration_text", "viewport", "region", "border", "banner", "warnings", "sound"].every((k) => k in state));
  ok("duration_text 形如 0.0s", /^\d+\.\d+s$/.test(state.duration_text), state.duration_text);

  // 区域事件：region 生效
  now = mockLines[1].ts;
  const region = bus.ingest(mockLines[1], cfg, now, display);
  ok("action.before 更新为 running", region.ok && region.resolved.kind === "running", region.reason);
  ok("区域事件把边框收缩到 bounds", region.resolved.border.rect.w === 960 && region.resolved.border.rect.x === 320);

  // need_human：红框 + 强提醒
  now = mockLines[5].ts;
  const need = bus.ingest(mockLines[5], cfg, now, display);
  ok("need_human 触发 alert", need.ok && need.resolved.tray === "alert" && need.resolved.sound === "alert");
  ok("need_human 用事件 visual 覆盖颜色", need.resolved.border.color === "#FF3B30", need.resolved.border.color);
  ok("事件级 banner 覆盖文案", need.resolved.banner.shape === "speech_bubble", need.resolved.banner.shape);

  // 结束：视觉清空
  const endTs = mockLines[10].ts;
  const end = bus.ingest(mockLines[10], cfg, endTs, display);
  ok("session.end 被接收", end.ok, end.reason);
  ok("结束时 active=false 且视觉为空", end.resolved.active === false && end.resolved.border === null && end.resolved.banner === null);

  // 迟到事件被丢弃：同一 session 结束后，更早 ts 的事件不能复活它
  bus.ingest({ event: "session.start", ts: 5000, session_id: "late-1", agent: { name: "a" } }, cfg, 5000, display);
  bus.ingest({ event: "session.end", ts: 6000, session_id: "late-1", agent: { name: "a" } }, cfg, 6000, display);
  const late = bus.ingest({ event: "action.before", ts: 5500, session_id: "late-1", agent: { name: "a" } }, cfg, 6500, display);
  ok("会话结束后迟到的事件被丢弃", !late.ok, late.reason);

  // 新的会话可以重新开始
  const again = bus.ingest(Object.assign({}, mockLines[0], { ts: endTs + 900, session_id: "demo-again" }), cfg, endTs + 900, display);
  ok("结束之后新会话可重新接管", again.ok && again.resolved.active === true);
}

/* ---------- 6. TTL 兜底 ---------- */
{
  const bus = new EventBus();
  const cfg = configLib.buildConfig({}).config;
  const t0 = 1760000000000;
  bus.ingest(Object.assign({}, mockLines[0], { ts: t0 }), cfg, t0, display);
  const notYet = bus.tick(cfg, t0 + 10000, display);
  ok("未超时不动作", notYet === null);
  const expired = bus.tick(cfg, t0 + 31000, display);
  ok("超时后合成 session.end", !!expired && expired.active === false && expired.reason === "ttl");
  ok("TTL 兜底也要发通知", expired && expired.notify === true && expired.sound === "end");
}

/* ---------- 7. 心跳续期 ---------- */
{
  const bus = new EventBus();
  const cfg = configLib.buildConfig({}).config;
  const t0 = 1760000000000;
  bus.ingest(Object.assign({}, mockLines[0], { ts: t0 }), cfg, t0, display);
  const hb = bus.ingest({ event: "heartbeat", ts: t0 + 20000, session_id: "demo-001", agent: { name: "deepseek-harness" } }, cfg, t0 + 20000, display);
  ok("heartbeat 被 ignore_events 拦下（仅续期）", !hb.ok, hb.reason);
  ok("心跳后续期有效（+50s 才超时）", bus.tick(cfg, t0 + 45000, display) === null && bus.tick(cfg, t0 + 59000, display) !== null);
}

/* ---------- 8. 视觉全关的底线 ---------- */
{
  const bus = new EventBus();
  const cfg = configLib.buildConfig({ border: { visible: false }, banner: { visible: false } }).config;
  const t0 = 1760000000000;
  const out = bus.ingest(Object.assign({}, mockLines[0], { ts: t0 }), cfg, t0, display);
  ok("边框与横幅都关时仍接收事件", out.ok);
  ok("产出「视觉反馈已全部关闭」告警", out.resolved.warnings.some((w) => w.includes("视觉全部关闭")) || out.resolved.visual_off === true, out.resolved.warnings.join("|"));
  ok("托盘转为 visual_off", out.resolved.tray === "visual_off");
  ok("通知与声音不受影响", out.resolved.notify === true && out.resolved.sound === "start");
}

/* ---------- 9. 文件收件箱（真实文件 + 增量消费） ---------- */
await (async () => {
  const { create } = require(path.join(ROOT, "lib/adapters/file-inbox.js"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "veil-inbox-"));
  const inbox = path.join(tmp, "events.jsonl");
  process.env.AI_VEIL_INBOX = inbox;
  fs.writeFileSync(inbox, JSON.stringify({ event: "session.start", ts: 1, session_id: "old" }) + "\n", "utf8");

  const received = [];
  const adapter = create({ home: tmp, logger: { info() {}, warn() {}, error() {} }, emit: (e) => received.push(e) });
  await new Promise((r) => setTimeout(r, 200));
  ok("从文件末尾开始，不回放历史", received.length === 0, `收到 ${received.length} 条`);

  fs.appendFileSync(inbox, JSON.stringify({ event: "need_human", ts: 2, session_id: "s1" }) + "\n", "utf8");
  await new Promise((r) => setTimeout(r, 250));
  ok("新写入的事件被消费", received.length === 1 && received[0].event === "need_human");

  // 半行：先写一半，不应触发；补完再触发
  const line = JSON.stringify({ event: "error", ts: 3, session_id: "s1" }) + "\n";
  fs.appendFileSync(inbox, line.slice(0, 12), "utf8");
  await new Promise((r) => setTimeout(r, 250));
  const afterHalf = received.length;
  fs.appendFileSync(inbox, line.slice(12), "utf8");
  await new Promise((r) => setTimeout(r, 300));
  ok("半行不触发，补全后触发", afterHalf === 1 && received.length === 2 && received[1].event === "error");

  // 中文多字节：整行一次写入
  fs.appendFileSync(inbox, JSON.stringify({ event: "action.before", ts: 4, session_id: "s1", action: { target: "保存文件 · 中文测试" } }) + "\n", "utf8");
  await new Promise((r) => setTimeout(r, 300));
  ok("UTF-8 中文事件正确解析", received.length === 3 && received[2].action.target.includes("中文测试"));

  // 截断
  fs.writeFileSync(inbox, "", "utf8");
  await new Promise((r) => setTimeout(r, 200));
  fs.appendFileSync(inbox, JSON.stringify({ event: "session.end", ts: 5, session_id: "s1" }) + "\n", "utf8");
  await new Promise((r) => setTimeout(r, 300));
  ok("文件被截断后仍能继续消费", received.length === 4 && received[3].event === "session.end");

  adapter.close();
  delete process.env.AI_VEIL_INBOX;
})();

/* ---------- 10. 托盘图标（运行时绘制） ---------- */
{
  const { makeTrayPng } = require(path.join(ROOT, "lib/tray-icons.js"));
  const states = ["active", "alert", "error", "visual_off", "idle"];
  const buffers = states.map((s) => makeTrayPng(s, 32));
  const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  ok("五种托盘状态都能生成合法 PNG", buffers.every(isPng), buffers.map((b) => b.length + "B").join(", "));
  const distinct = new Set(buffers.map((b) => b.toString("base64")));
  ok("五种状态图标互不相同", distinct.size === 5);
}

console.log(`\n===== Electron 版自检：PASS ${pass} / FAIL ${fail} =====`);
if (fail) {
  console.log("失败项：");
  for (const f of failures) console.log(" - " + f);
}
process.exit(fail === 0 ? 0 : 1);
