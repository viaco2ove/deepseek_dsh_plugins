# 03 · 服务与依赖

> 整理自 deepseek-harness 官方文档《服务与依赖》。

## 什么是服务

在 Harness 中，`tools`、`llm`、`agents` 都是服务。服务是挂载在 `ctx` 上的命名能力：

```ts
ctx.tools    // ToolRuntime service
ctx.llm      // LLM service
ctx.agents   // Agent service
```

任何插件都可以提供服务，供其他插件使用。

## 使用服务

声明 `inject` 来使用已有服务：

```ts
export const inject = ['tools']

export function apply(ctx: Context) {
  // ctx.tools exists and is ready here.
  ctx.tools.register(/* ... */)
}
```

框架保证：在 `apply` 执行时，`inject` 声明的服务已经全部就绪。如果服务还没准备好，你的插件会等着，不会执行。

## 提供服务

### 使用 Service 基类

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MetricsService extends Service {
  static inject = ['llm']  // A service may depend on other services.

  constructor(ctx: Context) {
    super(ctx, 'metrics')  // 'metrics' is the service name.
  }

  // Public service method.
  record(event: string, value: number) {
    // ...
  }
}
```

加载这个插件后，消费方就可以通过 `ctx.metrics` 访问它：

```ts
export const inject = ['metrics']

export function apply(ctx: Context) {
  ctx.metrics.record('tool_call', 1)
}
```

### 类型声明

使用 TypeScript 声明合并让 `ctx.metrics` 有正确类型：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
}

export default class MetricsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'metrics')
  }

  record(event: string, value: number) { /* ... */ }
}
```

JavaScript 插件（如本项目的 `dsh-Identify-local-files`）没有声明合并，但可以通过 `ctx.get('serviceName')` 在使用点可选地获取服务（见 [10-浏览器客户端插件](./10-client-plugin.md)）。

## 依赖的行为

### 必需依赖与可选依赖

```ts
// Required: the plugin does not load while the service is absent.
export const inject = ['tools']

// Optional: omit inject and query with ctx.get() at the use site.
export function apply(ctx: Context) {
  const metrics = ctx.get('metrics')
  metrics?.record('plugin_loaded', 1)
}
```

### 服务消失时的行为

如果应用运行期间某项必需服务消失（例如其提供方卸载）：

1. 依赖它的插件会自动 dispose（资源释放）
2. 当服务重新出现时，插件自动重新加载

这可以防止插件调用已不存在的服务。

## 服务隔离

`cordis.yml` 支持服务隔离——同一个服务可以有多个实例，不同插件组看到不同实例：

```yaml
- id: group-a
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config:
        timeoutMs: 5000
    - name: './src/plugin-a.ts'

- id: group-b
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config:
        timeoutMs: 60000
    - name: './src/plugin-b.ts'
```

`plugin-a` 和 `plugin-b` 各自看到自己组内的 Bash 实例，互不影响。

## 命名约定（来自官方"添加 workspace 包"清单）

- 一个 engine、runtime、policy、controller、resolver、store 或当前配置使用**单数** `ctx` key；registry 或拥有多个具名成员的服务使用**复数** key。类的角色与 key 的单复数必须一致。
- 不得让不兼容的 host 与 client 声明复用同一个 Cordis `Context` key。即使二者使用独立的运行时 context，TypeScript 声明合并仍会同时看到两种类型。

常用角色词与适用条件：

| 词 | 适用条件 |
|---|---|
| `Registry` | 拥有一组动态具名注册，以及查询、重复项或优先级规则、生命周期和释放 |
| `Runtime` | 运行实时工作，并跨调用拥有分派、取消、provider 协调或操作生命周期 |
| `Provider` | 提供一项能力定义的一个实现。存在多个实现时，加上机制或厂商限定词 |
| `Store` | 拥有一组数据，主要提供该数据的 CRUD、snapshot 或 subscription 操作 |
| `Engine` | 实现领域算法或有状态执行模型 |
| `Gateway` | 适配进程、网络、RPC 或 API 边界 |
| `Handle` | 引用一个实时资源，并控制或观察该资源 |

## Harness 内置服务

服务名、公开方法和源码位置由仓库自动生成到各服务的子系统页面（`docs/subsystems/`）。开发插件时应以这些生成区块和服务的 TypeScript 接口为准，不要维护另一份静态清单。

## 下一步

- [04-事件系统](./04-events.md) — 插件间松耦合通信
- [09-能力三角色](./09-capability-seams.md) — 将服务用作可替换的能力接口