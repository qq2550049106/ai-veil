# AI-Veil · 假设与待验证点（ASSUMPTIONS）

> 这份文件回答两个问题：**哪些地方我在猜**、**猜错了怎么办**。
> 每条都给了"如果不对"的回退方案，没有一条会让人卡死。

---

## 1. 技术栈选择

### 1.1 为什么是 Electron（这一版按用户要求从 Tauri 换了过来）

| 维度 | Tauri 2（上一版） | Electron（本版） |
| --- | --- | --- |
| 产物体积 | 约 8–12 MB | 约 90–150 MB（打包后） |
| 运行依赖 | 系统 WebView2 / WebKitGTK | 自带 Chromium，跨平台行为一致 |
| 构建依赖 | Rust 工具链 + Tauri CLI（首次编译 5–15 分钟） | `npm install` 一次，之后启动即改即看 |
| 本机可行性 | ❌ 这台机器没有 cargo/rustc，从未编译成功 | ✅ 装个 electron 就能跑 |
| 透明置顶窗口 | 需自己处理平台差异 | `transparent` + `setAlwaysOnTop` + `setIgnoreMouseEvents` 都是官方 API |
| 通知 | 插件能力有限，无内联图 | `Notification` + `desktopCapturer` 拿缩略图更直接 |

**结论**：功能契约一个字没改，换的是"谁托管这些页面"。代价是体积，收益是**终于能在这台机器上真正跑起来**。

### 1.2 前端为什么不重写

`src/` 下 18 个 ES 模块、4 个主题、9 种形状全部原样保留。
`preload.js` 实现了 `window.__TAURI__` **兼容层**（`core.invoke` / `core.convertFileSrc` / `event.listen`），
所以 `overlay.js`、`settings.js`、`banner.js` 一行都不用改——这也顺带证明了它们没有绑死在 Tauri 上。

---

## 2. Electron API 假设清单（运行时最可能踩的坑）

| # | 假设 | 依据 | 若假设不成立 | 回退方案 |
| --- | --- | --- | --- | --- |
| E1 | `BrowserWindow({ transparent:true, frame:false, hasShadow:false })` 在 Win/macOS/X11 上得到真正透明窗口 | 官方支持矩阵 | 出现黑底/白底 | Windows 上补 `backgroundColor:"#00000000"`；Linux 强制 X11 会话 |
| E2 | `win.setIgnoreMouseEvents(true, { forward:true })` 让全屏窗口鼠标穿透，切回 `false` 后可点击 | 2.x 起支持，含 forward | 点击穿不过去 / 关不掉 | 去掉 `forward` 参数；或整体改为"只在小窗口上放按钮" |
| E3 | `screen.getCursorScreenPoint()` 在每个 tick 都够快（40ms 一次） | 轻量系统调用 | 高 CPU | 改为 80ms；或只在 `mousemove` 事件里判断（需要窗口能收到事件，与穿透矛盾） |
| E4 | `win.setAlwaysOnTop(true, "screen-saver")` 层级高于普通置顶 | 官方 level 枚举 | 被某些全屏应用压住 | 降级为 `"floating"`；或提示用户退出独占全屏 |
| E5 | `showInactive()` 显示窗口不抢焦点 | 官方 API | 仍抢焦点 | 加 `focusable:false`（代价：中止按钮可能点不到，见 E6） |
| E6 | `focusable:true` 的遮罩能收到中止按钮的点击 | 常规窗口行为 | 按钮点不动 | 改为"托盘菜单 / 全局热键"作为中止主通道（本来就有，按钮只是便利） |
| E7 | `Tray` + `nativeImage.createFromBuffer(PNG)` 在 Win/macOS/Linux 都能显示 32px 图标 | 官方支持 | 图标空白 | 改用 `assets/icons/tray.png` 静态文件；macOS 需要 Template 图则改用单色图 |
| E8 | `globalShortcut.register("Control+Alt+Escape", …)` 接受 `Ctrl+Alt+Esc` 归一化后的写法 | 加速器语法 | 注册失败 | 已实现：失败会写日志 + 发通知；用户可在配置里换组合键 |
| E9 | `new Notification({...}).show()` 在本机弹系统通知 | 官方 API | 被系统拒绝 | `Notification.isSupported()` 已判；失败只写日志，其余反馈照常 |
| E10 | `desktopCapturer.getSources({types:["screen"]})` 能取到主屏缩略图 | 官方 API（macOS 需屏幕录制权限） | 返回空 / 权限拒绝 | 缩略图失败不影响通知本身（仅日志注明） |
| E11 | MCP stdio 模式下，`process.stdout` 只承载 JSON-RPC，Electron 自身日志走 stderr | Electron 惯例 | 宿主收到脏报文 | 改用 §8.0 的文件收件箱通道（bridge.mjs + `--adapter file`），那条路完全不碰 stdout |
| E12 | `contextIsolation:true` + preload 暴露 `__TAURI__` 兼容层，前端 `invoke` 全部可用 | Electron 安全模型 | 某个命令拿不到 | 报错会被 `invokeSafe` 吞掉并写 `frontend_log`，不会白屏 |

**验证方式**：`npm start -- --adapter mock` 是最快的自检——11 条样例事件会依次触发边框、横幅、通知、声音、托盘变色，
中止热键与托盘菜单也能立刻验证。

---

## 3. 坐标与 DPI（与上一版同一套约定）

- 事件里的 `bounds` / `viewport` 一律按**逻辑像素（DIP）**处理，Electron 的 `screen` API 也返回 DIP，两边天然对齐
- 前端 `report_abort_rect` 上报的矩形是**相对遮罩视口左上角**的 CSS px；主进程用 `win.getBounds()` 换算成屏幕坐标后与光标比较
- 多显示器：事件带 `scope.display_id` 时按区域中心点匹配显示器（`displayForRegion`），否则用主屏
- 高 DPI 下若发现命中区偏移，优先检查 `scaleFactor` 是否在遮罩窗口创建后被系统改变（罕见，重启即可）

---

## 4. 与 DeepSeek Harness / Kimi 的真实回调接口

**事实**：这两个产品都没有公开"AI 正在操作本机"的稳定回调/事件流。所以本项目**不假设**存在这样的接口，
而是提供四条主动上报通道（见 README §8）：

1. **MCP stdio**（本进程就是 MCP server）：宿主把 AI-Veil 当子进程拉起，模型调用 `veil_emit`
2. **文件收件箱**（`--adapter file`）：任何能写文件的宿主/插件都能接入；DSH 的 `bridge.mjs` 就走这条
3. **CLI 包装器**（`--adapter cli -- <cmd>`）：解析子进程输出，不改对方代码
4. **自己写适配器**：`lib/adapters/` 加一个文件 + 注册表加一行

**待验证点**：
- 各 MCP 客户端里 server 的配置键名（字段名各家不同，形状见 README §8.1）
- 模型是否稳定听话地按提示词调用 `veil_emit`（需要提示词约束 + 失败兜底）
- Kimi 侧是否允许模型自由构造工具参数（不允许就退到 CLI 包装器）

---

## 5. 遮罩窗口的"穿透 + 唯一可点按钮"

做法（与 Tauri 版一致，只是把 Rust 轮询换成主进程轮询）：

1. 窗口默认 `setIgnoreMouseEvents(true, { forward:true })` —— 全屏穿透，不挡用户操作
2. 前端布局完成后通过 `report_abort_rect` 上报中止按钮矩形
3. 主进程每 40ms 取 `screen.getCursorScreenPoint()`，命中矩形才 `setIgnoreMouseEvents(false)`
4. 会话结束 / 窗口隐藏 / `hidden=true` 时立即恢复穿透

**已知副作用**：指针进入按钮区域时，那一小块会"接住"鼠标；离开即恢复穿透。这是跨平台最可靠的方案。

---

## 6. 语义抉择（需求文档没写死，我做了决定）

| # | 抉择 | 理由 |
| --- | --- | --- |
| S1 | `min_takeover_ms` = **短会话不吵人**：开始通知/声音延后到阈值后再发，期间结束就取消；视觉立刻显示不延迟 | 既能"不吵"，又不牺牲"秒级出现"的体感 |
| S2 | `border.scope` 是**用户偏好**；事件自带的 `scope.bounds` 是**几何**，优先于偏好 | 否则"区域高亮"无处落脚 |
| S3 | `heartbeat` 只在 `ignore_events` 包含它时"仅续期"；否则按 running 刷新文案 | 两种需求都常见，交给配置决定 |
| S4 | `session.end` 的 state 会**清空 border/banner**（置 null），前端立刻移除 DOM 节点 | 满足"结束即消失"的硬要求 |
| S5 | 通知缩略图**落盘**（`logs/thumb-*.png`）而不是塞进通知正文 | Electron/Tauri 都无法跨平台内联大图，不编造 API |
| S6 | `privacy.upload_enabled` 强制 false | 数据不出本机是底线，不是可选项 |
| S7 | 配置类型不匹配时**宽容纠正**（"4"→4、"true"→true），而不是像 Rust 那样整份回退默认 | 手写 TOML 常见引号，纠正比丢弃友好；仍会写中文告警 |
| S8 | 数组字段整体替换默认值（`idle="blink"` 可被 `["blink","wag"]` 覆盖） | 深合并若把数组当对象会得到 `"blink, wag"` 这种废值 |
| S9 | 事件去重窗口固定 5s，key = `event|session|ts|target` | 覆盖"同一事件重发"，又不至于吞掉快速连续的真实动作 |
| S10 | 会话结束后到达的**更早 ts** 事件直接丢弃 | 防止迟到的旧事件把已经结束的会话"复活" |
| S11 | 无适配器时应用照常常驻（托盘 + 热键 + 设置面板可用） | 用户可以只把它当"手动提示器"用 |
| S12 | 配置损坏时**备份 + 回退默认**，而不是拒绝启动 | 宁可少一个自定义项，也不能因为一个逗号打不开 |

---

## 7. 前端实现假设

| # | 假设 | 说明 |
| --- | --- | --- |
| F1 | Chromium 的 CSS 动画足以表现 breathe/dash/scan/pulse | 全部纯 CSS，无 rAF；`animation:none` 时该形状不注册任何动画 |
| F2 | Web Audio 在用户手势后可自由播放 | 已加 `--autoplay-policy=no-user-gesture-required`；兜底是 `unlockAudio()` |
| F3 | 9 种形状的 `hitPath.contains()` 能代表真实几何 | 只有"形状外的点"返回 false，穿透才正确 |
| F4 | 字体统一走 `system-ui` / `Microsoft YaHei UI` 回退链 | 不内置字体文件，避免体积与许可问题 |
| F5 | 设置面板与遮罩都通过 `__TAURI__` 兼容层通信 | 这也让前端可以脱离 Electron 在浏览器里预览（降级模式） |
| F6 | 自定义 SVG 一定经过 `sanitize.js` + 后端白名单双重过滤 | 单层过滤不足以对抗恶意 SVG |

---

## 8. 数据与隐私

- 所有事件、截图、日志、配置只写 `~/.ai-veil/`，**不联网、不上传**（`upload_enabled` 强制 false，且没有任何网络代码）
- 素材只从 `assets.dirs` 白名单读取，`../` 越界与符号链接逃逸一律拒绝
- 截屏缩略图默认关闭（`notify.thumbnail=false`），开启后也只落盘不发送
- 事件文件 `~/.ai-veil/events.jsonl` 是纯文本，用户可随时删除；删除后适配器会自动重建

---

## 9. DeepSeek Harness 集成（已安装，部分待验证）

| 项 | 状态 |
| --- | --- |
| bundle 安装 | ✅ `@local/ai-veil-bridge` 已 `application: applied` |
| MCP server 注册 | ✅ `ai_veil`，工具 `mcp__ai_veil__veil_emit` / `veil_cancel` |
| 实调上报 | ✅ 调用返回 `ok: <event>`，`~/.ai-veil/events.jsonl` 立即多一行 |
| 中止留痕 | ✅ 生成 `~/.ai-veil/cancel/cancel-dsh-*.json` |
| 桌面端消费 | 🟡 Electron 版已可 `npm start -- --adapter file` 消费；真机透明置顶待本机 `npm install` 后确认 |
| 直连 MCP（不经过 bridge） | 🟡 配置里把 command 换成 electron + `--adapter mcp_stdio` 即可，未在真实客户端验证 |

---

## 10. 未做的部分（明确说明，不是遗漏）

0. **Electron 装不上时的兜底**：已提供 PowerShell 回退渲染器（`scripts/veil-lite.ps1`，见 README §3.6），
   它消费同一个 `events.jsonl`，保证"没有构建环境也能看到提醒"；代价是没有形状系统与主题。
1. **进程名白名单/黑名单**：字段保留并校验，但没有"枚举前台进程"的实现——那需要平台特定 API，且隐私敏感
2. **代码签名**：Windows/macOS 分发包未签名，会触发 SmartScreen / Gatekeeper
3. **Wayland 原生支持**：只保证 X11
4. **多显示器同时铺满**：当前一个遮罩窗口跟随目标显示器，不同时在所有屏上画边框
5. **通知正文内联截图**：平台不支持，已改为落盘 + 日志
6. **自动更新**：未接 `electron-updater`

---

## 11. 自测脚本（装好 electron 后 5 分钟跑完）

```bash
# 0) 纯 Node 自检（不需要 electron）：配置/事件总线/文件收件箱/托盘图标
node _veil_electron_test.mjs        # 本仓库不含该脚本时见 §11.1

# 1) 装依赖
npm install

# 2) 无 Agent 全流程（验收 1/2/3/6/9/11）
npm start -- --adapter mock
#    目视：橙色边框 + 猫咪横幅 + 提示音 + 通知；第 6 条事件变红脉冲；最后淡出

# 3) 中止通道（验收 7）
#    回放中按 Ctrl+Alt+Esc → 遮罩立即消失 + 通知 + ~/.ai-veil/cancel/ 出现记录

# 4) 只留通知与声音（验收 2）
#    编辑 ~/.ai-veil/config.toml：border.visible=false、banner.visible=false → 重启 → 看托盘变黄 + 收到一次说明通知

# 5) 事件优先级（验收 10）
#    设置面板 → 诊断 → 发送：
#    {"event":"need_human","session_id":"t1","visual":{"border":{"color":"#00FF00","animation":"pulse"}}}
#    目视：边框变绿（事件覆盖 > per_event 的红色）

# 6) 坏配置（验收 12）
#    把 config.toml 改成非法 TOML → 重启 → 应用仍能启动 + 生成 config.toml.broken-* + 中文告警
```

### 11.1 纯 Node 自检脚本说明

仓库外的 `_veil_electron_test.mjs`（本次交付附带）覆盖 55 项断言：TOML 往返、93 个配置叶子键、
深合并半表补齐、归一化钳制、事件总线去重/乱序/优先级/TTL/心跳续期/视觉全关底线、文件收件箱增量与半行、
五种托盘图标。**它不需要 Electron，也不需要显示器**，适合在 CI 里跑。
