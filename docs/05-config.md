# 05 · 插件配置

> 整理自 deepseek-harness 官方文档《插件配置》。

让你的插件接受用户在 `cordis.yml` 中传入的配置。

## 定义 Config 类型

在插件中导出一个 `Config` 类型和同名的 Schemastery schema；默认值直接写在 schema 中：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)  // User value or schema default.
}
```

在 `cordis.yml` 的插件行中添加配置：

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
      config:
        greeting: 'Hi there'
        maxRetries: 5
```

插件加载时，Cordis 会通过导出的 schema 校验配置，并填充未提供字段的默认值。

> **不要导出普通对象作为 `Config`**，因为它不满足 Cordis 要求的 Standard Schema 接口。

## Schema 校验

对于需要严格校验的场景：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'validated-plugin'

export interface Config {
  apiKey: string
  timeout: number
  mode: 'fast' | 'accurate'
}

export const Config = Schema.object({
  apiKey: Schema.string().required(),
  timeout: Schema.number().default(30000),
  mode: Schema.union(['fast', 'accurate']).default('fast'),
})

export function apply(ctx: Context, config: Config) {
  // config is validated and type-safe.
}
```

Schema 在插件加载时执行校验。如果配置不合法，插件会加载失败并给出明确错误信息。

## 本项目示例

`dsh-Identify-local-files` 的 `src/index.js`（JavaScript，同样适用）：

```js
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** Byte cap for one file read. */
  maxFileBytes: z.number().default(20 * 1024 * 1024),
  /** Byte cap for inline text returned to the model. */
  maxTextBytes: z.number().default(2 * 1024 * 1024),
})
```

并在 `cordis.patch.yml` 中传入具体值：

```yaml
- insert:
    - id: dsh-Identify-local-files
      name: 'dsh-Identify-local-files'
      config:
        maxFileBytes: 20971520
        maxTextBytes: 2097152
```

## 密钥与机密

密钥采用 Cordis 原生方式管理：schemastery Config 带环境变量回退，通过 cordis.yml 的 `!!js` 注入：

```yaml
- id: my-llm
  name: './src/my-llm-adapter.ts'
  config:
    apiKey: !!js process.env.MY_API_KEY
```

**切勿在代码中读取自行约定的密钥文件，切勿提交真实凭证。**

## `!!js` 表达式节点

`@deepseek-ai/cordis-plugin-include` 将 `!!js` 解析为表达式节点。Loader 在声明的注入激活后，基于该插件上下文（`ctx.serviceName`）插值条目的 `config`，并在每次挂载决策时基于 loader 上下文插值其 `disabled` 字段。由环境选择插件时，请使用 overlay。

带服务回退的例子（来自官方 bundle 教程）：

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

## 设计原则

### 无硬编码可调参数

Harness 的约定：**凡是不同部署可能需要采用不同值的参数，都必须定义为配置字段**。

```ts
// Wrong: hardcoded timeout.
const TIMEOUT = 30000

// Correct: configurable.
export interface Config {
  timeoutMs: number  // Defaults to 30000.
}
```

检验标准：能否在 `cordis.yml` 中改变这个值，而不需要修改代码？

### 配置错误要响亮

在 schema 中表达自身完备的约束，使无效配置在插件加载时失败。对服务或已注册资源的引用需要依赖注入（见 [03-服务与依赖](./03-services.md)）。

### 后层覆盖前层

后应用的 patch 层按行胜出，且 patch 会替换目标行的**整个 `config` 值**，而不是深度合并各键。所以：

- 你的 patch 可以按 `id` 覆盖前面各层的行，但必须重述该行需要的每一个键，而不是只写改动的那个。
- 用户可以在自己 profile 的 `cordis.patch.yml` 中覆盖你的行，无需改动你的包。优先给出用户大概率会保留的默认值，其余交给 schema 承担。

## 配合 HMR

配置变更会触发插件热替换：修改 `cordis.yml` 中某个插件的 `config` 后，框架会卸载旧实例并加载新实例。由于注册都属于 effect 并会自动清理，替换后不会保留旧实例的注册。

## 下一步

- [07-打包与安装](./07-packaging.md) — 把插件以可安装包的形式交付
- [08-LLM 适配器](./08-llm-adapter.md) — Config 在适配器中的实际用法