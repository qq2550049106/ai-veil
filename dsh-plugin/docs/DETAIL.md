# AI-Veil 插件详情

## 它解决什么问题

DeepSeek Harness 里，Agent 帮你点鼠标、敲键盘、截图、开应用的时候，**用户没有任何"我正在被操作"的信号**。
这个插件把 Agent 的动作翻译成 AI-Veil 的统一事件，桌面端就会弹出系统级横幅/边框、播提示音、发桌面通知，
并且给用户一条独立的中止通道。

## 装了什么

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 往 profile 里插一个 MCP server（包 `@deepseek-ai/dsh-mcp-client`），stdio 指向 `bridge.mjs` |
| `bridge.mjs` | 零依赖 MCP stdio 服务，提供 `veil_emit` / `veil_cancel`，事件追加到 `~/.ai-veil/events.jsonl` |
| `demo/emit-demo.mjs` | 一键演示脚本：不经过 MCP 也能灌一整段接管流程 |
| `locale/{zh,en}.json` | 插件面板里的标题与描述 |

## 两个工具

- `mcp__ai_veil__veil_emit` —— 上报事件。开始接管、每次动作前后、需要人工介入、出错、结束都该调用；
  长任务每 25 秒发一次 `heartbeat` 续期。
- `mcp__ai_veil__veil_cancel` —— 请求中止。会写 `~/.ai-veil/cancel/cancel-*.json`，并让桌面端立即收起遮罩。

## 桌面端怎么跑（Electron 版）

```bash
cd ai-veil
npm install
npm start -- --adapter file        # 消费 ~/.ai-veil/events.jsonl
```

首次启动会创建 `~/.ai-veil/`、写入 `config.toml`、播种内置素材，托盘出现灰色圆点。

## 演示（不需要接任何 Agent）

```bash
# 终端 A：桌面端
npm start -- --adapter file

# 终端 B：灌一段演示事件（约 10 秒）
node dsh-plugin/demo/emit-demo.mjs

# 想从头回放已经攒下的事件：
#   AI_VEIL_INBOX_FROM_START=1 npm start -- --adapter file
```

## 想直连 AI-Veil 自带的 MCP 服务

`bridge.mjs` 只是"不依赖桌面端可执行路径"的中间层。桌面端自己也能当 MCP server：

```yaml
command: 'npx'
args: ['electron', 'E:/ai-veil', '--adapter', 'mcp_stdio']
```

打包成 exe 后更简单：`command: '<...>/AI-Veil.exe'`, `args: ['--adapter', 'mcp_stdio']`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_VEIL_INBOX` | `~/.ai-veil/events.jsonl` | 事件落盘路径（桥与桌面端都要一致） |
| `AI_VEIL_AGENT` | `deepseek-harness` | 事件里 `agent.name` 的默认值 |
| `AI_VEIL_INBOX_FROM_START` | 空 | 桌面端侧：`1` 表示从文件头开始回放 |

## 边界与排错

- **单向**：桥能上报、能留中止记录，但真正"掐断 Agent 进程"要宿主自己配合。
- **桌面端没启动也不会错**：事件只是安静排队，DSH 侧不会报错、不会阻塞。
- **看不到任何东西**：先确认桌面端在跑（`npm start -- --adapter file`），再看 `~/.ai-veil/logs/ai-veil.log`
  有没有 `事件=session.start`；若 `border.visible` 与 `banner.visible` 都关了，托盘会变黄并弹一次说明通知。
- **端口/协议**：只用 stdio，不占端口。
