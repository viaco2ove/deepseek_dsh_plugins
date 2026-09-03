# 06 · 工具开发

> 整理自 deepseek-harness 官方文档《开发一个工具》《工具编写参考》与《实操手册：扩展插件形态》。

面向模型的工具是插件最常见形态。工具在 `ctx.tools` 上注册，schema 会自动流入系统提示词的组装过程。

## 最小形态

```ts
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',          // what the model sees
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },                     // optional by default
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // args is TYPED from the schema: { path: string; limit?: number }
      // exec carries immutable identity + token; signal is the operational field
      return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
    },
  }))
}
```

注册基于副作用：dispose 插件 fiber 即注销该工具。

`inject` 让 Cordis 等待工具注册表就绪。`defineTool` 根据 `parameters` 推导并校验 `args`；`execute` 返回 `output.schema` 声明的规范值，`output.render` 再将该值转换为面向模型的内容。

## execute() 约定的规则

1. **参数已为你校验。** `defineTool` 在 `execute` 运行前，会根据统一的 `ParameterSchemaSpec` 校验模型生成的 `arguments`（类型、必填键、字面量约束、恰好匹配一个分支的联合以及嵌套值），因此 `execute` 内的 args 会匹配 `InferArgs`。你仍需手动检查 schema DSL 无法表达的约束（非空字符串、正数、跨字段规则）。直接注册的原始 JSON Schema 工具自行负责输入校验。

2. **注册借用你的只读定义。** 类型化的同进程贡献不是序列化边界；注册后不要修改其 schema 或替换回调。如需热替换工具，请 dispose 其所属副作用并注册替代品。

3. **执行身份受保护。** 注册表将 `arguments` 物化为分离的无损 JSON 并冻结，分配不透明的 `exec.token`；`callId`、`name`、`arguments`、`agent`、`token`、必填的 `signal` 在整个分发过程中保持不可变。请将 `args` 视为只读输入。

4. **声明并返回一个规范 JSON 值。** `output.schema` 使用 `ValueSchemaSpec`，根可以是对象、数组、标量或 null。`execute` 只返回推导出的值。工具主体不要返回内容块，也不要迫使调用方从自然语言中解析 id 和字段。

5. **抛出异常或返回无效值意味着 `isError`。** 基础设施故障请抛异常；成功的领域结果即使表示不理想的状态，也应写入规范值（例如进程以非零状态退出）。

6. **遵守 `exec.signal`。** 信号触发时取消进行中的工作。

7. **使用 `presentationMeta` 投影持久化的卡片数据（可选）。** `output.presentationMeta(args, value)` 从同一个规范值派生可回放的 JSON。

8. **使用 `exec.agent` 发送异步通知。** `agent.inject({ content, source: { kind: 'plugin', plugin: '<name>' } })` 追加持久化上下文，下一次模型请求会看到它——这不是唤醒（空闲的 agent 保持空闲）。

## 本项目示例：read_local_file

`dsh-Identify-local-files` 的 `src/index.js` 展示了一个完整的生产级工具注册（JavaScript 版本，逻辑相同）：

```js
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-Identify-local-files'
export const inject = ['tools']

export const Config = z.object({
  maxFileBytes: z.number().default(20 * MEBIBYTE),
  maxTextBytes: z.number().default(2 * MEBIBYTE),
})

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'read_local_file',
    description: 'Read one local file by absolute or workspace-relative path. Images (PNG/JPEG/WebP/GIF) return a base64 data URL for vision; text files return their content inline (truncated to the byte budget); other binaries report their path and size.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'File path (absolute, or relative to the workspace root).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => {
        if (value.kind === 'image') {
          return [{ type: 'text', text: `[image ${value.path} ${value.bytes}B as data URL]` }]
        }
        if (value.kind === 'text' && value.text !== null) {
          return [{ type: 'text', text: value.text }]
        }
        return [{ type: 'text', text: `[binary ${value.path} (${value.bytes} bytes)]` }]
      },
    },
    async execute(args) {
      // ... size guard, image detection, text sniffing, truncation
    },
  }))
}
```

要点：
- schema 里无法表达的字节数上限这类自定义约束在 `execute` 内手动检查；
- 三分支领域结果（image / text / binary）作为规范值返回，`render` 负责面向模型的呈现；
- 超限用 `throw` 表达（基础设施级失败）。

## 长时间运行的工作（后台任务）

通过 producer 配置控制 `run_in_background`，然后使用 `ctx.jobs.start()` 注册任务：

```ts
ctx.jobs.start({
  kind: 'bash',
  label: 'long build',
  owner: exec.agent,
  run: async (task) => {
    // task provides id, session fencing, control tools, notifications.
  },
})
```

要点：

- 注册表会在进入 producer 主体前将已预先中止的调用判为失败。
- 成功的后台分支会返回类型化的规范句柄，如 `{ kind: 'background', jobId }`。
- producer 提供同步的 `cancel`、在资源清理后 settle 且不 reject 的 `done`，以及可选的消费式 `readOutput`。
- `ctx.jobs.start()` 发布 id 后，应使用任务自有的取消信号，而不是 `exec.signal`：之后取消外层调用只会停止等待本次调用，不会终止已经发布的工作；该生命周期归 `job_kill`、owner dispose 和服务 teardown 所有。前台工作仍与 `exec.signal` 耦合。

## 执行策略与观测（五个事件钩子）

尽量不要把部署策略内建到工具中。按需选择：

| 扩展点 | 用途 |
|---|---|
| `tools/pre-execute` | 可扩展的允许／拒绝／询问策略（waterfall，返回类型化 `PreToolDecision`） |
| `ctx.tools.guard()` | 最终的单调拒绝，后续监听器无法撤销 |
| `tools/execute` | 为分发添加截止时间、重试或指标收集（可替换 `exec.signal`） |
| `tools/post-execute` | 替换展示内容或返回值、阻止结果，或附加模型可见上下文 |
| `tools/result` | 观测不可变的归一化结果而不改变它 |

### 权限门禁示例

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

权限系统 / AskUserQuestion 的官方实现方式：从 `tools/pre-execute` 返回 `ask` 并通过 `ctx.approval` 应答。

## PTC mode 自动触达你的工具

在 PTC mode（代码式工具调用）中，每个可见的已注册工具都可通过 `await tools.<name>(args)` 调用，无需额外集成。生成的 `ToolArgsMap` 和 `ToolOutputMap` 会根据同一组 schema 分别派生精确的参数类型与规范返回类型。

因此请把 `output.schema` 设计为实用的程序化 API：

- 直接返回句柄与字段。
- 当标量、数组或 null 确实就是结果时，允许采用相应的根类型。
- 将面向人类的解释放入 `output.render`。

## UI 卡片（presentCall / presentResult）

工具的 `output.render` 返回**模型可见**内容；其 **UI 卡片**是另一项独立关注点，通过可选的 `presentCall`／`presentResult` 方法声明。没有 UI 展示方法的工具会回退到通用卡片。

`presentCall(args)` → PENDING 卡片：

- `{ card: 'generic', title, kind?, rawInput?, content?, locations? }` — 默认
- `{ card: 'terminal', title, description?, cwd? }` — 调用本身就是 shell 命令
- `{ card: 'diff', title, diffs, locations? }` — 调用创建或修改文件

`presentResult(args, { content, isError, meta? })` → 完成后的卡片（generic / terminal / diff / read / search / web）。

### 硬性规则

- **纯函数。** 这些方法在实时流式输出和会话日志回放时都会运行，因此必须是 `args`（加 result）的纯函数——不做 I/O、不读会话状态、不用时钟／随机数。
- **UI 格式不进入模型结果。** 围栏 ` ```console ` 块、diff、相对化路径均不应仅为服务 UI 而进入规范值或 Native 内容。
- **`defineTool` 对展示路径做软校验。** 展示绝不能导致回放崩溃。

## 工具渲染：规范值 vs 模型内容

一个工具的三层输出设计：

| 层 | 归属 | 用途 |
|---|---|---|
| `output.schema` + `execute` 返回值 | 规范值 | 程序化消费（PTC mode、测试、遥测） |
| `output.render` | 模型可见内容 | 下一次模型请求看到的内容 |
| `output.presentationMeta` + `presentCall`/`presentResult` | UI 卡片 | 各 UI 的回放展示 |

三层从同一个规范值派生，互不污染。

## 验证

从官方教程《开发一个工具》的验证流程：

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

打开 `http://127.0.0.1:3080`，输入：`Use the greet tool to greet Ada.` 观察模型调用工具并收到结果。

## 下一步

- [07-打包与安装](./07-packaging.md) — 把工具插件交付给用户
- [09-能力三角色](./09-capability-seams.md) — 工具作为能力的 Consumer 角色