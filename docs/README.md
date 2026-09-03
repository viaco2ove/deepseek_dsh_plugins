# dsh 插件开发知识库

本目录整理自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 官方文档，面向本项目（DeepSeek Harness / `dsh` 插件集合）的插件开发。

> 权威来源：https://deepseek-harness.github.io/deepseek-harness/
> 本仓库中已有示例插件：`dsh-Identify-local-files`（双面插件：host 工具 + 浏览器 client 粘贴增强）

## 阅读路径

### 入门（按顺序读）

| 文档 | 内容 | 适用场景 |
|---|---|---|
| [01-插件基础](./01-plugin-basics.md) | 插件是什么、最小形态、三种形态、`--patch` 加载 | 第一次写插件 |
| [02-生命周期](./02-lifecycle.md) | Fiber 状态机、自动清理、`ctx.effect`、HMR | 理解插件的加载/卸载 |
| [03-服务与依赖](./03-services.md) | `inject`、Service 基类、服务隔离 | 插件之间互相协作 |
| [04-事件系统](./04-events.md) | emit/bail/serial/waterfall/parallel、类型化事件 | 拦截和观察行为 |
| [05-插件配置](./05-config.md) | Schemastery `Config`、校验、默认值 | 让插件可配置 |

### 实战

| 文档 | 内容 | 适用场景 |
|---|---|---|
| [06-工具开发](./06-tool-development.md) | `defineTool` DSL、execute 约定、后台任务、策略钩子、UI 卡片 | 给模型添加能力 |
| [07-打包与安装](./07-packaging.md) | 组合包 bundle、profile、`dsh plugin add`、层顺序 | 分发插件 |
| [08-LLM 适配器](./08-llm-adapter.md) | `LlmAdapter`、StreamChunk 协议、错误处理 | 接入新的模型提供方 |
| [09-能力三角色](./09-capability-seams.md) | Service Definition / Provider / Consumer | 设计可替换能力 |
| [10-浏览器客户端插件](./10-client-plugin.md) | 双面插件、client 模块格式、composer 集成 | 扩展 Web UI |

## 核心心智模型（30 秒版）

1. **一切皆插件**：模型适配器、工具、会话日志、agent loop 本身都是插件，都可以被替换。
2. **插件 = 导出 `apply(ctx)` 的模块**：框架加载时调用 `apply`，你通过 `ctx` 注册能力。
3. **注册是可逆副作用**：`ctx.on()` / `ctx.tools.register()` / `ctx.effect()` 注册的一切，在插件卸载时自动撤销。
4. **依赖用 `inject` 声明**：声明所需服务（如 `['tools']`），框架保证依赖就绪后才执行 `apply`。
5. **通信走类型化事件**：`emit`（广播）、`waterfall`（流水线）、`bail`（短路）、`serial`（顺序）、`parallel`（并行）。

## 扩展点速查表

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 上注册适配器 |
| 添加面向模型的能力 | 在 `ctx.tools` 上注册 |
| 添加 shell 执行 | 注册 `ctx.shell` 后端 |
| 添加持久化终端执行 | 注册 `ctx.terminals` 后端 |
| 添加用户命令 | 在 `ctx.commands` 上注册 |
| 添加后台工作 | 在 `ctx.jobs` 上注册 |
| 限制进程启动 | 使用 `ctx.sandbox` 后端 |
| 拦截请求/工具/轮次 | 使用 `agent/*` 或 `tools/*` 事件 |
| 添加模型可见上下文 | 调用 `agent.inject()` |
| 添加 UI 集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加持久会话状态 | 扩展 `SessionEventMap` |
| 将注册项限定到单个 agent | 使用该 agent 的 `agent.ctx` |

## 本项目插件约定

- 每个插件一个独立目录：`src/`（源码）、`lib/`（构建产物）、`cordis.patch.yml`（bundle 层）、`package.json`（声明 `dsh.bundle`）。
- `package.json` 的 `dsh` 字段声明 manifest；`peerDependencies` 列出运行时对等依赖。
- 双面插件（host + client）通过 `dsh.client` 声明 client 面，client 代码以 `window.__ModuleLoader__.load({...})` 包装。
- 详见 [07-打包与安装](./07-packaging.md) 与 [10-浏览器客户端插件](./10-client-plugin.md)。
