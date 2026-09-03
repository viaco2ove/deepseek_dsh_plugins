# 04 · 事件系统

> 整理自 deepseek-harness 官方文档《事件系统》与《Cordis 入门》。

事件是 Cordis 插件间通信的核心机制。Harness 大量使用事件来实现松耦合的扩展点。

## 基本用法

### 监听事件

```ts
ctx.on('event-name', (payload) => {
  // Handle the event.
})
```

### 触发事件

```ts
ctx.emit('event-name', payload)
```

## 五种事件模式

每个事件具有以下分发模式之一，且只能通过对应方法分发。**分发模式是事件公开约定的一部分。**

| 模式 | 是否 await？ | 分发顺序 | 是否有返回值？ |
|---|---|---|---|
| `emit` | 否 | 监听器按注册顺序观察 | 否 |
| `waterfall` | 否 | 监听器按注册顺序观察 | 是 |
| `parallel` | 是 | 所有监听器并行观察事件 | 否 |
| `serial` | 是 | 监听器按注册顺序观察 | 是 |
| `bail` | 否 | 监听器按注册顺序观察，直到某个监听器返回 bail 值 | 是 |

### emit — 广播

所有监听器同步执行，返回值会被忽略：

```ts
// Emit
ctx.emit('my-plugin/ready', { id: 'worker-1' })

// Listen
ctx.on('my-plugin/ready', ({ id }) => {
  console.log(`${id} is ready`)
})
```

### bail — 短路

监听器按顺序运行，第一个不是 `null`、`false` 或 `undefined` 的返回值会成为最终结果：

```ts
// Dispatch
const result = ctx.bail('some-check', input)

// Listen: a returned value stops later listeners.
ctx.on('some-check', (input) => {
  if (shouldBlock(input)) return 'blocked'
  // Return null, false, or undefined to continue to the next listener.
})
```

### serial — 顺序执行

监听器按注册顺序依次执行，并等待异步结果；第一个不是 `null`、`false` 或 `undefined` 的返回值会终止后续执行：

```ts
await ctx.serial('setup-phase', context)
```

### parallel — 并行扇出

```ts
await ctx.parallel('notify-all', payload)
```

### waterfall（瀑布式事件）— 流水线

每个监听器可以包装下游返回值，形成处理链。**必须调用 `next()` 传递给下游**，不调用即会短路流水线：

```ts
// Dispatch
const output = await ctx.waterfall('my-plugin/transform', input, async () => input)

// Listen: next() is mandatory.
ctx.on('my-plugin/transform', async (_input, next) => {
  const downstream = await next()
  return downstream.trim()
})
```

::: warning
waterfall 监听器**必须调用 `next()`**。不调用 `next` 会短路整个流水线，这是故意为之的设计——用于实现拦截/网关逻辑。
:::

#### waterfall 语义详解

`ctx.waterfall` 是环绕中间件。监听器接收 `(...args, next)`：

- 调用 `next()` 会执行下游监听器；下游返回值通过 `next()` 返回当前包装层，可由该层包装后继续向外返回。
- 不调用 `next()` 直接返回则短路。
- 协作式监听器通常修改一个共享的请求或决策对象，然后委托。监听器也可以选择完全替换结果，下游监听器将只看到替换后的结果。
- 仅当监听器必须在普通注册之前运行时才使用 `prepend: true`。
- 对于单决策事件，短路是设计意图。策略监听器在拥有决策权时可以不调用 `next()` 直接返回，而仅做标注或观察的监听器则必须委托。

## 类型安全的事件

Harness 使用 TypeScript 声明合并来为事件提供类型安全：

```ts
import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/check': (input: string) => boolean | undefined
    'my-plugin/transform': (input: string, next: () => Promise<string>) => Promise<string>
  }
}

// ctx.on('my-plugin/ready', ...) and ctx.emit('my-plugin/ready', ...)
// are now inferred correctly.
```

## Cordis 事件 vs 会话记录事件（重要区别）

Harness 的 Cordis 事件遵循 `namespace/action` 命名，例如 `agent/pre-step`、`agent/request`、`agent/request-error`、`tools/result` 和 `session/event`。

**`turn/*`、`step/*`、`tool/call`、`tool/result` 和 `compaction/*` 是持久化的会话事件类型，不是同名 Cordis 事件。** 需要观察它们时，监听 `session/event` 并检查 `event.type`：

```ts
ctx.on('session/event', (_session, event) => {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
    render(event.data.chunk.text)
  }
})
```

## 事件监听器也是效果

通过 `ctx.on()` 注册的监听器会在插件卸载时自动移除：

```ts
export function apply(ctx: Context) {
  // This listener is removed when the plugin disposes.
  ctx.on('tools/result', handler)
}
```

## 常用扩展点事件

### `agent/*` — 实时 agent 协调

携带活跃 `Agent`：inbox、步骤、状态、请求、验证、续跑。用于观察或拦截进行中的工作。

- `agent/pre-step` — 决定模型看到什么；可改写已领取的消息或直接拒绝（waterfall）
- `agent/request` — 拦截模型请求（waterfall）
- `agent/turn-stopping` — 停止轮次（serial，无 `next()`）

### `tools/*` — 工具流水线

- `tools/pre-execute` — 允许/拒绝/询问策略（waterfall）
- `tools/execute` — 包裹分发生命周期：超时/重试/指标（waterfall）
- `tools/post-execute` — 显式结果变换（waterfall）
- `tools/result` — 观察不可变最终结果（emit）

### `session/event` — 持久会话事实

所有追加到会话日志的事件都会通过它广播。UI 渲染、遥测、回放都从这里读取。

## 示例：日志插件

这个插件记录工具调用和工具结果：

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-tools'

export const name = 'tool-logger'

export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    console.log(`[tool] ${exec.name}(${JSON.stringify(exec.arguments)})`)
    const text = result.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    console.log(`[tool result] ${text.slice(0, 100)}`)
  })
}
```

## 示例：权限门禁（钩子插件）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

declare function isAllowed(exec: ToolExecution): Promise<boolean>

export const name = 'permission-gate'

export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!(await isAllowed(exec))) {
      return { kind: 'deny', reason: 'Denied by policy.' }
    }
    return next()
  })
}
```

`tools/pre-execute` 是可重排的策略层，waterfall 返回类型化决策。沙箱、权限和 plan-mode 插件都可以使用该扩展点。

## 下一步

- [06-工具开发](./06-tool-development.md) — `tools/*` 事件的完整使用
- [09-能力三角色](./09-capability-seams.md) — 能力接口中的事件