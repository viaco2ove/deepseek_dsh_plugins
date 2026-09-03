# 01 · 插件基础

> 整理自 deepseek-harness 官方文档《第一个插件》与《Cordis 入门》。

## 插件是什么

在 Harness 中，插件是一个导出 `apply` 函数的 TypeScript（或 JavaScript）模块。框架在加载时调用 `apply`，传入一个 `ctx`（上下文对象），你通过 `ctx` 注册能力：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // Register capabilities here.
}
```

这就是完整配置——没有清单文件、没有注册中心，模块导出即是插件。

## 五个核心概念（Cordis）

- **插件是实现 Service 的对象。** 它可以是一个带有可选 `inject` 和 `apply(ctx)` 字段的函数，也可以是一个 `Service` 子类，其生命周期由 Cordis 挂载到当前上下文中。
- **上下文是服务的容器。** 一个服务占据一个稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`）；其他插件通过 key 查找服务，而非导入具体实现。
- **通过 `inject` 声明服务依赖。** 插件声明所需的服务后，会等待这些服务就绪才启动；加载顺序通过服务依赖表达，而非手动编排启动序列。
- **类型化事件用于通信。** 服务通过 TypeScript 声明合并注册事件名，然后以 `emit`、`waterfall`（瀑布式事件）、`parallel`、`serial` 或 `bail` 方式分发。
- **注册是可逆的副作用。** 提示词片段、工具 schema、适配器、提供方和监听器通过 `ctx.effect()` 或 `ctx.on()` 安装，reload 和 teardown 时会按预期撤销。

## 插件的三种形态

### 函数形式（最常用）

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'
export const inject = ['tools']  // optional

export function apply(ctx: Context) {
  // ...
}
```

### 对象形式

```ts
import type { Context } from '@deepseek-ai/cordis'

export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) {
    // ...
  },
}
```

### 类形式（提供服务时用）

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MyService extends Service {
  static inject = ['tools']

  constructor(ctx: Context) {
    super(ctx, 'myService')
    // Perform synchronous initialization in the constructor.
  }
}
```

大多数情况下，函数形式足够了。当插件需要向其他插件提供服务时，可使用类形式（见 [03-服务与依赖](./03-services.md)）。

## 声明依赖

如果你的插件需要使用其他服务（如 `tools`、`llm`），需要声明 `inject`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-tool-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  // ctx.tools is ready here.
  ctx.tools.register(/* ... */)
}
```

框架会确保依赖的服务就绪后才加载你的插件。

## 本地开发：用 `--patch` 加载

开发时不需要打包，直接用 overlay 加载本地插件源码。

创建 `scratch-plugin/cordis.yml`：

```yaml
- insert:
    - id: hello
      name: '/absolute/path/to/your-plugin/src/my-plugin.ts'
```

> 插件路径必须是**绝对路径**。patch 文件只贡献配置，不会改变 loader 解析模块路径时使用的 profile 目录。

启动 Web UI：

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

打开 `http://127.0.0.1:3080`。启动期间，终端会打印插件里的 console 输出。

## 自动清理

通过 `ctx` 注册的任何东西——事件监听、工具、定时器——在插件卸载时都会被自动清理。你不需要手动 removeListener 或 clearInterval。

如果你有需要手动清理的资源（比如一个网络连接），用 `ctx.effect()` 告诉框架怎么清理：

```ts
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log('heartbeat')
    }, 5000)

    // The returned function runs when the plugin unloads.
    return () => clearInterval(timer)
  })
}
```

## 实践规则

- 将行为封装为插件：工具流水线事件属于 `ctx.tools`，模型流式输出属于 `ctx.llm`，实时 agent（智能体）协调属于 `ctx.agents`。
- 拦截和策略优先使用事件；直接能力调用优先使用服务方法。
- 每个注册都应有对应的 disposer：要么从 `ctx.effect()` 返回一个，要么使用 Cordis 提供的辅助方法自动处理。

## 下一步

- [02-生命周期](./02-lifecycle.md) — 插件加载/卸载的完整状态机
- [05-插件配置](./05-config.md) — 让插件接受用户配置
- [06-工具开发](./06-tool-development.md) — 给模型添加可调用的工具