# 09 · 能力的三角色设计（Capability Seams）

> 整理自 deepseek-harness 官方文档《能力的三种角色设计》与《架构文档》。

当一项能力足够通用，需要支持可替换的提供方时（例如 Bash 执行），harness 区分三种角色：**Service Definition**、**Service Provider** 和 **Consumer**。角色需要独立演进或替换时，将它们放入不同包；否则一个包可以承担多个角色。**完整能力构成其 seam。任何单一角色都不是 seam。**

## 以 Bash 为例

- **Service Definition** (`dsh-shell`)：定义 Cordis 服务以及 Bash 请求和结果类型
- **Service Provider** (`dsh-bash-local`)：在本地计算机上执行命令
- **Consumer** (`dsh-tool-bash`)：将该能力公开为模型可调用的工具

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  dsh-shell   │────▶│  dsh-bash-local  │     │ dsh-tool-bash│
│(definition) │     │    (provider)     │     │(consumer/tool)│
└─────────────┘     └──────────────────┘     └──────────────┘
       ▲                                            │
       └────────────────────────────────────────────┘
                    inject: ['shell']
```

## 拆分的好处

### 提供方可替换

同一个 Service Definition 可以有多个提供方，可通过 `cordis.yml` 选择：

```yaml
# Local execution
- name: '@deepseek-ai/dsh-bash-local'

# Replace this row with another package that provides the same service.
```

更换提供方时，Service Definition 和工具均保持不变。

**seam 正是替换一个提供方就能改变整个产品的原因。** 文件系统与进程提供方共享同一个执行世界，因此把它们指向远程沙箱，也就把 Bash、PTY 和 LSP 一并搬了过去，无需提供方专用 fork。subagent 提供方在同一个接口之后同样千差万别，从新建一个子 agent，到把一个轮次委派给另一个产品。

### 独立演进

- 调用方开始依赖 Service Definition 的约定后，Service Definition 很少改动。
- Service Provider 可以独立优化性能和安全性。
- Consumer 可以调整能力向模型呈现的方式。

### 依赖解耦

- Service Provider 依赖 Service Definition。
- Consumer 依赖 Service Definition。
- Service Provider 和 Consumer **互不依赖**。
- **扩展插件依赖 Service Definition，绝不依赖具体提供方。**

## 教程：开发三种角色的能力

### 第一步：编写 Service Definition

```ts
// packages/my-cap/my-cap/src/index.ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    myCap: MyCapService
  }
}

export abstract class MyCapService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myCap')
  }

  /** Execute the capability. */
  abstract execute(request: MyCapRequest): Promise<MyCapResult>
}

export interface MyCapRequest {
  input: string
}

export interface MyCapResult {
  output: string
}
```

### 第二步：编写 Service Provider

```ts
// packages/my-cap/my-cap-local/src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { MyCapService, type MyCapRequest, type MyCapResult } from '@deepseek-ai/dsh-my-cap'

class MyCapLocal extends MyCapService {
  async execute(request: MyCapRequest): Promise<MyCapResult> {
    // Local provider behavior.
    return { output: request.input.toUpperCase() }
  }
}

export const name = 'my-cap-local'

export function apply(ctx: Context) {
  ctx.plugin(MyCapLocal)
}
```

### 第三步：编写消费方

```ts
// packages/my-cap/tool-my-cap/src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-my-cap'
export const inject = ['tools', 'myCap']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'my_cap',
    description: 'Execute my capability.',
    parameters: {
      input: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const result = await ctx.myCap.execute({ input: args.input })
      return result.output
    },
  }))
}
```

### 在 cordis.yml 中组合

```yaml
- name: '@deepseek-ai/dsh-my-cap-local'
- name: '@deepseek-ai/dsh-tool-my-cap'
```

## 设计要点

- **不要预防性拆分**：只有角色需要独立演进时，才使用不同包。简单的工具插件无需拆分。
- **Service Definition 拥有 Request/Result 类型**：Service Provider 和 Consumer 只依赖 Service Definition 包。
- **显式优于隐式**：实现应通过显式的 `resolve(request): Spec` 步骤处理默认值，而不是在 `run()` 中隐藏 `?? default`。

## 命名约定

接口包使用能力名称。实现包加上能够区分实现的机制、协议、环境或厂商限定词。只有同主机执行属于约定时，才使用 `local`。

一个 engine、runtime、policy、controller、resolver、store 或当前配置使用单数 `ctx` key；registry 或拥有多个具名成员的服务使用复数 key。类的角色与 key 的单复数必须一致。

不得让不兼容的 host 与 client 声明复用同一个 Cordis `Context` key——即使二者使用独立的运行时 context，TypeScript 声明合并仍会同时看到两种类型。如果自然复数已经属于另一个端面，就增加职责后缀。

## 官方能力 seam 一览（部分）

| 能力 | Service Definition | 内置 Provider 示例 | Consumer 示例 |
|---|---|---|---|
| Bash 执行 | `dsh-shell` | `dsh-bash-local` | `dsh-tool-bash` |
| 文件系统 | `dsh-fs` | 本地实现 | `dsh-tool-fs`、`dsh-tool-fs-search` |
| LSP | `dsh-lsp` | 通用 stdio 提供方 | `lsp` 工具 |
| 沙箱 | `dsh-sandbox` | bwrap/Landlock/Seatbelt | `dsh-bash-sandbox` |
| Subagent | `dsh-subagent` | spawn-in-process/fork/acp/codex/claude-code/sdk | `dsh-tool-subagent` |
| 代码执行 | `dsh-code-runtime` | worker 线程提供方 | PTC mode |
| 压缩 | `dsh-compaction` | `dsh-compaction-basic` | 命令 Consumer |
| Web | `dsh-web` | 搜索/获取提供方 | `dsh-tool-web` |
| 持久化 | `dsh-session-persistence` | 各后端 | 会话服务 |

## 新行为的归属位置（官方映射节选）

| 目标 | 机制 |
|---|---|
| 添加 shell 执行 | 注册 `ctx.shell` 后端；本地后端通过 `ctx.subprocess` spawn 进程 |
| 添加持久化终端执行 | 注册 `ctx.terminals` 后端和 `dsh-tool-terminal` |
| 添加文件系统访问或策略 | 注册 `ctx.fs` 提供方，或监听 `fs/*` 事件 |
| 限制所启动的进程 | 使用 `ctx.sandbox` 后端；消费方在启动进程前包装 argv |
| 添加持久化后端 | 挂载 `ctx.sessionPersistence` 后端 |

## 下一步

- [06-工具开发](./06-tool-development.md) — Consumer 角色的完整工具开发
- [03-服务与依赖](./03-services.md) — Service 基类与声明合并