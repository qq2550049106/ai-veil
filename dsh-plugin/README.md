# AI-Veil 提示器：DSH 插件包

这是 [AI-Veil](../README.md) 的 **DeepSeek Harness 侧适配层**。它本身不画任何东西，只做一件事：
把 Agent 的接管动作翻译成 AI-Veil 的统一事件，让桌面端弹出系统级横幅/边框、播放提示音、发桌面通知。

## 包里有什么

| 文件 | 作用 |
| --- | --- |
| `package.json` | DSH bundle 清单（`dsh.bundle.patch` 指向 patch 文件） |
| `cordis.patch.yml` | 注入一个 MCP server（`@deepseek-ai/dsh-mcp-client`），指向 `bridge.mjs` |
| `bridge.mjs` | 零依赖 MCP stdio 服务：提供 `veil_emit` / `veil_cancel`，把事件追加到 `~/.ai-veil/events.jsonl` |
| `locale/{zh,en}.json` | 插件在 DSH 里的标题与描述 |
| `docs/DETAIL.md` | 安装细节、换用原生 MCP 通道、排错 |

## 安装（二选一）

**A. 目录方式**（推荐，本机已这样装好）

```powershell
# 在 DSH 里执行 plugin_manager install_bundle，target 传这个目录的绝对路径
E:\ai-veil\dsh-plugin
```

**B. 解压 zip 后安装**

把 `ai-veil-dsh-plugin-1.0.0.zip` 解压到任意目录，用 `plugin_manager install_bundle` 指向解压目录。

装好后 DSH 会话里会多出两个工具：

- `mcp__ai_veil__veil_emit` —— 上报事件（开始接管、动作前后、需要人工、出错、结束、心跳续期）
- `mcp__ai_veil__veil_cancel` —— 请求中止

## 让桌面端跑起来

```bash
cd ..                 # 回到 ai-veil 根目录
npm install           # 只装 electron（devDependencies）
npm start -- --adapter file
```

`--adapter file` 会 tail `~/.ai-veil/events.jsonl`，也就是 `bridge.mjs` 正在写的那个文件。

## 立刻看效果（不用接任何 Agent）

```bash
# 终端 A
npm start -- --adapter file
# 终端 B
node dsh-plugin/demo/emit-demo.mjs        # 约 10 秒走完"接管 → 动作 → 要确认 → 结束"
```

## 想直连 AI-Veil 自带 MCP 服务

`bridge.mjs` 只是为了"不依赖桌面端路径"而存在的中间层。桌面端自己也能当 MCP server：

```yaml
command: 'npx'
args: ['electron', 'E:/ai-veil', '--adapter', 'mcp_stdio']
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_VEIL_INBOX` | `~/.ai-veil/events.jsonl` | 事件落盘路径 |
| `AI_VEIL_AGENT` | `deepseek-harness` | 事件里 `agent.name` 的默认值 |

## 边界

- 这个桥**单向**：能上报、能留中止记录；真正"掐断 Agent 进程"要宿主自己配合。
- 桌面端没启动时，事件只是安静地堆在 jsonl 里，不会报错、不会阻塞 DSH。
- 桌面端启动时默认**从文件末尾**开始读，历史事件不会重放；演示时用 `AI_VEIL_INBOX_FROM_START=1`。
