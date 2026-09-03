# 08 · LLM 适配器

> 整理自 deepseek-harness 官方文档《LLM 适配器》《实操手册：添加 LLM 适配器》。

LLM 适配器是一个继承 `LlmAdapter` 并实现 `stream()` 方法的类，它会将 Harness 的提供方无关请求转换为具体提供方的 API 调用，并将响应转换回 Harness 分片。

## 概述

- 参考实现：`packages/llm/llm-deepseek`（直接 HTTP，SSE 由 `eventsource-parser` 分帧）与 `packages/llm/llm-pi-ai`（封装 LLM 库）。
- 请先阅读 `packages/llm/llm/src/types.ts` 中的 `StreamChunk` 文档——它记录了两个适配器都经过验证的协议约定。

## 最小实现

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class MyAdapter extends LlmAdapter {
  private apiKey: string

  constructor(apiKey: string) {
    super()
    this.apiKey = apiKey
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 1. Convert options.messages to the provider format.
    // 2. Call the streaming API.
    // 3. Convert the response into StreamChunk values.
  }
}

export interface Config {
  apiKey: string
  providers: string[]
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().required(),
  providers: Schema.array(Schema.string()).required(),
})

export const name = 'my-llm-adapter'
export const inject = ['llm']

export function apply(ctx: Context, config: Config) {
  const adapter = new MyAdapter(config.apiKey)
  ctx.llm.registerAdapter(config.providers, adapter)
}
```

注册基于副作用，可安全支持 HMR；每个提供方路由仅对应一个适配器，重复注册会抛出异常，多路由注册要么全部成功，要么全部失败。

## StreamChunk 协议

`stream()` 必须按以下协议生成分片：

```ts
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'

async function* exampleChunks(): AsyncIterable<StreamChunk> {
  // 1. Start each content block with block-start.
  yield { type: 'block-start', index: 0, blockType: 'text' }

  // 2. Stream text through text-delta.
  yield { type: 'text-delta', index: 0, text: 'Hello' }
  yield { type: 'text-delta', index: 0, text: ' world' }

  // 3. End each content block with block-end and the complete block.
  yield {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'Hello world' },
  }

  // 4. Tool-call block.
  yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  yield {
    type: 'tool-call-delta',
    index: 1,
    id: brandString<ToolCallId>('call-123'),
    name: 'bash',
    argumentsDelta: '{"command":"ls"}',
  }
  yield {
    type: 'block-end',
    index: 1,
    block: {
      type: 'tool-call',
      id: brandString<ToolCallId>('call-123'),
      name: 'bash',
      arguments: '{"command":"ls"}',
    },
  }

  // 5. Token usage.
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }

  // 6. Finish reason.
  yield { type: 'finish', reason: { kind: 'stop' } }
  // Alternatively, { kind: 'tool-calls' } requests tool execution.
}
```

### 协议义务（关键规则）

- 在 `finish` **之前**发出 `usage`；`finish` 之后**不再发出任何内容**。稳健做法：缓冲 finish/usage 直到提供方的流结束标记，再统一 flush。
- 每个 `block-start` 都必须有与之对应的 `block-end`。
- `index` 从 0 开始递增，按首次出现的流顺序分配；同一个块的每次 delta 复用该 index。
- 工具调用的 `arguments` 全程为**原始 JSON 字符串**；流式片段以 `argumentsDelta` 发送。如果你的提供方返回已解析的对象，请在 `block-end` 时重新 stringify。
- `finish` 必须是最后一个分片。
- 错误有且仅有两条合法路径：
  - 从 `stream()` **抛出**（传输与协议故障——使用带稳定 code 的 `LlmError`）
  - 以 `finish {kind: 'error' | 'aborted'}` 结束流（提供方带内故障）
- 遵守 `options.signal`（将其传递给 fetch 或你的 SDK）。
- 如果 `GenerateOptions` 中某个字段你的提供方无法支持（例如提供方不支持 stop sequences 时收到 `stop` 列表）：抛出 `LlmError(..., 'UNSUPPORTED_OPTION')`，而非静默丢弃。

## GenerateOptions

`stream()` 接收仓库导出的 `GenerateOptions`。它包含模型、适配器拥有的推理强度 ID、对话历史、系统提示词、工具 schema、生成参数、停止序列和中止信号；完整字段以 `@deepseek-ai/dsh-llm` 导出的 TypeScript 类型为准。

请覆写 `resolveModel(provider, model, signal?)`，在一次查询中返回确切的提供方／模型身份以及可选的 `context` 和 `reasoning` 元数据：

- 推理元数据包含有序的不透明 ID、展示名称，以及可选的配置默认值。
- 保留适配器给出的权威可选列表（包括 `off`），不要将这些值提升为核心枚举。
- 异步查询必须响应该可选信号。
- 省略 `reasoning` 表示该模型没有可选的推理强度能力。

## 回放状态

如果提供方在后续调用中需要响应 ID、签名或其他原生元数据，请将其最小无损 JSON 投影作为 `finish.replayState` 发出。重建历史时验证该状态。只有历史提供方路由和目标提供方路由当前由完全相同的适配器实例拥有时，`LlmRuntime` 才会传递该状态；由适配器决定同模型、跨模型或跨提供方恢复是否合法。

## 注册适配器

```ts
ctx.llm.registerAdapter(['my-provider'], adapter)
```

- 第一个参数是该适配器处理的提供方路由列表。
- `GenerateOptions.provider` 选择已注册的适配器，`GenerateOptions.model` 是提供方模型 ID，因此动态模型目录适配器无需重新配置生命周期即可提供新模型。
- 适配器能够向选择器公布模型选项时，请覆写 `listModels()`。

## 在 cordis.yml 中使用

```yaml
- id: my-llm
  name: './src/my-llm-adapter.ts'
  config:
    apiKey: !!js process.env.MY_API_KEY
    providers:
      - my-provider

- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents:
      - id: main
        provider: my-provider
        model: my-model-v1
```

## 错误处理

适配器应通过带稳定 code 的 `LlmError` 抛出传输和协议故障；agent loop（智能体循环）会保留该错误及其 code，用于诊断和策略处理。不要依赖普通 `Error` 被自动转换。每个提供方 HTTP 请求还必须合并 `attributionHeaders()`，并传递 `options.signal`。

```ts
import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

class HttpAdapter extends LlmAdapter {
  constructor(private readonly endpoint: string) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: JSON.stringify({ model: options.model, messages: options.messages }),
      ...options.signal ? { signal: options.signal } : {},
    })
    if (!response.ok) {
      throw new LlmError(`Provider API error: ${response.status}`, 'PROVIDER_HTTP_ERROR')
    }
    // A real adapter parses the response and emits the complete chunk sequence.
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
```

## 密钥管理

密钥采用 Cordis 原生方式管理：schemastery Config 带环境变量回退，通过 cordis.yml 的 `!!js process.env.MY_KEY` 注入。**切勿在代码中读取自行约定的密钥文件。**

## 实现结构

让协议格式（wire format）类型、请求序列化、传输解析、分片转换和适配器类分别承担独立职责；`llm-deepseek` 是参考布局。

## 实战参考

仓库中包含以下两个完整实现：

- `packages/llm/llm-deepseek/` — DeepSeek API 适配器（OpenAI 兼容格式）
- `packages/llm/llm-pi-ai/` — Pi AI 适配器（不同的 API 格式）

对比这两个已交付的适配器，可以看到同一套 harness 契约如何在不同提供方 SDK 之上实现。