# 10 · 浏览器客户端插件（双面插件）

> 整理自 deepseek-harness 官方文档（Web Client 展示、Conversation 子系统）与本仓库 `dsh-Identify-local-files` 插件的实际实现。

双面插件同时拥有 **host 半侧**（Node 进程，注册工具、服务）和 **client 半侧**（浏览器，增强 Web UI）。`dsh-Identify-local-files` 是一个完整示例。

## 双面插件的结构

```
dsh-Identify-local-files/
├── package.json         # dsh.bundle + dsh.client 双声明
├── cordis.patch.yml     # 配置层（注册 host 半侧插件行）
├── build.mjs            # 构建：拷贝 host 半侧到 lib/，语法检查 client 半侧
├── src/
│   ├── index.js         # host 半侧：注册 read_local_file 工具
│   └── client.js        # client 半侧：粘贴增强（ModuleLoader 包装格式）
└── lib/                 # 构建产物（发布内容）
    ├── index.js
    └── client.js
```

## package.json 的 client 声明

```json
{
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-client-runtime"],
      "platform": "web"
    },
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

- `dsh.client` 声明这是一个双面插件的 client 面。
- `exports["./client"]` 暴露 client 模块入口。
- host 半侧仍通过 `dsh.bundle` + `cordis.patch.yml` 挂载。

## client 模块格式：ModuleLoader 包装

浏览器半侧不是普通 ES 模块，而是被 `window.__ModuleLoader__.load({...})` 包装的**脚本**（内部不能出现 import/export 语句）：

```js
window.__ModuleLoader__.load({ id: "dsh-Identify-local-files", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  // —— 脚本体，CommonJS 风格 ——

  function apply(ctx) {
    // ctx 是浏览器侧的 Cordis context
    const sessions = ctx.get('sessions')
    // ...
    document.addEventListener('paste', onPaste, { capture: true })
    ctx.effect(() => () => {
      document.removeEventListener('paste', onPaste, { capture: true })
    })
  }

  if (typeof module !== "undefined" && module !== null) {
    module.exports = {
      apply,
      inject: ["sessions"],
    };
  }
}})
```

要点：

- `id` 与插件名一致。
- 工厂体内是 CommonJS 风格（`module.exports`），通过 `require` 引入依赖。
- 导出与 host 半侧同构：`apply` / `inject`（可选用 `ctx.get()` 代替强制 `inject`）。
- `ctx.effect()` 在 client 侧同样生效：返回的清理函数会在插件卸载时移除事件监听。

本项目的 `build.mjs` 用 `new Function('window', 'require', clientSrc)` 做语法检查——因为 client 文件是脚本不是模块，普通 ESM 语法检查会误报。

## host 半侧与 client 半侧的分工

以 `dsh-Identify-local-files` 为例：

| 关注点 | 半侧 | 实现 |
|---|---|---|
| 模型可调用的工具（读本地文件、图片转 base64 data URL） | host | `ctx.tools.register(defineTool({...}))` |
| 文件字节上限等配置 | host | Schemastery `Config` |
| 浏览器粘贴拦截（非图片文件→文本入 composer） | client | `document.addEventListener('paste', ...)` |
| 插入草稿文本 | client | `actx.emit('slash/input-insert-text', {...})` |

**两半之间不直接通信**：client 通过用户交互改变输入，host 通过工具改变模型可见能力，会话事件流（`session/event`）是共同的事实来源。

## client 侧服务

client 侧可用的服务通过 `ctx.get()` 可选获取（JS 中没有声明合并）：

```js
function apply(ctx) {
  const sessions = ctx.get('sessions')       // 会话列表与作用域
  const conversation = actx.get('conversation') // 会话作用域上的对话状态
}
```

作用域模式：先取会话作用域 `actx = sessions.scope(sessionId)`，再在作用域上取服务。

## 向 composer 插入文本

官方 Web Client 的 composer 插入事件：

```js
function insertIntoComposer(actx, text) {
  const conversation = actx.get('conversation')
  if (conversation === undefined) return
  const input = conversation.input.for(actx)
  const state = input.state.getSnapshot()
  actx.emit('slash/input-insert-text', {
    text,
    span: { start: state.draft.length, end: state.draft.length, draftRev: state.draftRev },
  })
}
```

## 渲染会话事件流（UI 插件通用模式）

UI 插件从 `session/event` 事件流渲染，并通过 `agent.followup()` / `agent.steer()` 将输入驱动回去：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'my-ui'
export const inject = ['agents']

export function apply(ctx: Context) {
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      render(event.data.chunk.text)
    }
  })
  onUserInput(text => ctx.agents.get(brandString<SessionId>('client-session'))?.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })))
}
```

## Web Client Chat 业务节点

如果浏览器插件要向内建 Web Client 贡献业务行（而不是自绘整个 UI），则应：

- 注册 `ConversationNodeDefinition`
- 注册 keyed Chat renderer（`conversation.chat.node`）

## 工具结果的 Web 展示（重要边界）

内置 Web Client **不消费** host 工具的 `presentCall` 或 `presentResult`。Session `page` 与 `follow` 运输原始 `tool/call` 和 `tool/result` 事件，包括持久化的 `result.meta`。

Client 插件在 keyed slot `tool.call.toolview` 中注册自己的 wire 工具名称，并从 `ToolCallBlock` 的参数、内容、错误、metadata 派生组件 props。

规则：

- Host 工具用 `output.presentationMeta(args, value)` 提供有界结构化结果事实（如已应用的 diff hunk）。
- 不要在 metadata 中保存 React props 或预选卡片。
- 不要把 Host 工具实现导入浏览器 bundle。
- 不要建立另一套 Client presenter registry。
- 插件在本地校验 wire 值，格式错误或不受支持的输入回退到 generic 行。

## 构建

本项目的 `build.mjs` 是最简形态（纯 JS，无转译）：

```js
import { mkdirSync, copyFileSync, readFileSync } from 'node:fs'

mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(join(root, 'src', 'index.js'), join(root, 'lib', 'index.js'))

// Client 是脚本不是模块：用 Function 构造器做语法检查。
const clientSrc = readFileSync(join(root, 'src', 'client.js'), 'utf8')
new Function('window', 'require', clientSrc)  // throws on syntax error
copyFileSync(join(root, 'src', 'client.js'), join(root, 'lib', 'client.js'))
```

TypeScript 插件则应使用 tsdown 之类的构建工具（参考 [turtle-ui](https://github.com/deepseek-harness/turtle-ui) 的自包含 `prepare` 脚本）。git 分发时 `prepare` 脚本必须在 pnpm 安装后自动构建出 `lib/`，详见 [07-打包与安装](./07-packaging.md)。

## 下一步

- [07-打包与安装](./07-packaging.md) — bundle manifest 与分发
- [06-工具开发](./06-tool-development.md) — host 半侧的工具注册