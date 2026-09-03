# 07 · 打包与安装插件

> 整理自 deepseek-harness 官方文档《打包与安装插件》。

前几篇文档通过 `--patch` overlay 加载本地插件。本文讲如何把它打包成可安装的**组合包**（bundle），用 `dsh plugin add` 安装进一个 **profile**。

## 两个概念，两种 manifest

安装机制建立在两个概念之上。二者都由一份 `package.json` 描述，但它们在 `dsh` 键下携带的 manifest（元数据清单）种类不同：

- **组合包**是附带一个配置层的 npm 包。它的 manifest 声明 `dsh.bundle`，回答的是"这个包贡献什么？"：一个插入或覆盖插件行的 patch 文件。
- **profile** 是位于 `$DSH_HOME/profiles/<name>` 下、描述一份可启动组合的目录。它的 manifest 声明 `dsh.profile`，回答的是"这套配置由哪些组合包按什么顺序组成？"。

组合包是你编写并分发的东西；profile 是用户用 `dsh --profile <name>` 启动的东西。没有东西同时是两者。

## 组合包的目录结构

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

### package.json

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

### cordis.patch.yml

与 `--patch` overlay 一样是 patch 条目的 YAML 数组；区别是插件行按**包名**而不是相对源码路径引用这个包，这样 Node 的模块解析才能找到已安装的代码：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

> `id` 是内部 Cordis 条目键（任意唯一值即可）；`name` 是 npm 包名（用于 import 插件模块）。
>
> 没有 `dsh.bundle` 声明的包仍然可以安装，但只作为普通依赖：`dsh plugin` 会打印警告，且不激活任何层。如果一个库供插件包 import，而不是供用户启用，就使用这种包格式。

## 本项目示例：dsh-Identify-local-files 的 manifest

```json
{
  "name": "dsh-Identify-local-files",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-client-runtime"],
      "platform": "web"
    },
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.6",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "scripts": { "build": "node build.mjs" }
}
```

要点：
- `dsh.bundle.patch` 指向配置层文件——这是让它成为组合包的声明。
- `dsh.client` 额外声明了浏览器 client 面（见 [10-浏览器客户端插件](./10-client-plugin.md)）。
- `peerDependencies` 声明运行时对等依赖（由宿主 dsh 提供，不重复打包）。
- `files` 只包含发布所需文件：`lib`（构建产物）、patch 文件、README。

## 安装进 profile

`dsh plugin --profile <name> <args...>` 在 profile 目录内转发给 pnpm，因此所有 pnpm 子命令都可用：

```sh
dsh plugin --profile demo add ./hello-plugin
```

首次使用会初始化 profile（`@deepseek-ai/dsh-base` 作为它的第一个组合包），pnpm 链接该 checkout，而 `dsh` 因为这个包声明了 `dsh.bundle`，把它追加进 `dsh.profile.bundles`：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": {
    "dsh-hello-plugin": "link:/path/to/hello-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-hello-plugin"
      ]
    }
  }
}
```

先验证该层再启动：

```sh
dsh --profile demo --dump-config   # shows a "# == dsh-hello-plugin" layer
dsh --profile demo
```

`dsh plugin --profile demo remove dsh-hello-plugin` 会同时移除依赖和对应的层。

## 加载顺序（层的组合）

生效配置在空根之上按以下顺序逐层组合：

1. profile 的 `dsh.profile.bundles` 列表所列的各个组合包 patch，按列表顺序——先是 `@deepseek-ai/dsh-base`，然后是每个已安装组合包，按其加入顺序。
2. profile 自己的 `cordis.patch.yml`。
3. home 级的 `$DSH_HOME/cordis.patch.yml`——各 profile 共享的机器本地偏好。
4. 每个 `--patch <path>` overlay，按 argv 顺序。

后应用的层按行胜出，且 patch 会替换目标行的**整个 `config` 值**，而不是深度合并各键。

内置组合包名称始终从 dsh 安装目录本身解析；pnpm 只管理树外的包，所以你的组合包可以放心依赖 `@deepseek-ai/dsh-base` 存在且与安装保持一致。

## 从 GitHub 安装：构建脚本这道坎

发布到注册表不是必须的——用户可以直接从 git 托管安装：

```sh
dsh plugin --profile demo add github:you/hello-plugin
```

但 git 安装拉取的是**源码，不是构建产物**：没有任何环节运行你的 `build` 脚本，因此 TypeScript 包到手时没有 `lib/` 输出，加载会失败。必须两边各做一件事：

- **作者**提供一个 `prepare` 脚本——pnpm 在 git 安装后运行它——从源码构建出发布入口，且必须自包含：不能假设仅开发环境才有的上下文，例如旁边有一份 monorepo checkout。参考 [turtle-ui](https://github.com/deepseek-harness/turtle-ui)：它的 `prepare` 运行一份专用的 tsdown 配置，直接转译 `src/`，不用项目引用，也不做类型检查。

- **用户**为构建授权。pnpm ≥10 在得到显式允许之前拒绝运行 git 依赖的 `prepare` 脚本，所以第一次 `add` 会失败；把 pnpm 打印的确切包键复制进该 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  allowBuilds:
    dsh-hello-plugin: true
  ```

  然后重新执行 `add`。

> 请把这项授权视为**允许该包的代码在安装时于你的机器上执行**，且不在 agent 运行的任何沙箱之内。只对源码可信的包授权，并锁定 commit（`github:you/hello-plugin#<sha>`）。

如果不想让用户做这项授权，就改为分发构建产物——以下两种形式都不需要任何构建权限：

- **发布到 npm**，在 `pnpm publish` 时构建好 `lib/`；`dsh plugin add your-package` 安装的就是预构建代码。
- **交付 tarball**：用 `pnpm pack` 打包；用户执行 `dsh plugin add ./hello-plugin-0.1.0.tgz`。

## 让表层组合包持有自己的命令行

定义了可运行应用的组合包挂载一个普通提供方插件：

```yaml
- id: hello-startup
  name: 'dsh-hello-plugin/startup'
```

该插件导出 `inject = ['cmdlineArgs']`，使用自己的 commander program 调用 `@deepseek-ai/dsh-cmdline` 中的 `parseCmdline`，再在 program 自己的 action 中把应用自有服务提供出去。启动器把自身 flag 之后的同一份不可变参数交给每个插件，因此添加应用专属 flag 无需修改启动器。

## 推荐发布清单

发布一个插件组合包前自查：

- [ ] `package.json` 声明 `dsh.bundle.patch`
- [ ] `cordis.patch.yml` 的行 `name` 用包名（或 `pkg/subpath`），不是相对路径
- [ ] `files` 只含发布产物（`lib/`、patch、README），不含 `src/`
- [ ] `peerDependencies` 列出运行时依赖（cordis、dsh-tools、schemastery）
- [ ] 构建产物已在 `lib/`（npm 发布走 `prepublish`/CI 构建；git 分发走 `prepare`）
- [ ] `--dump-config` 能看到你的层；profile 启动后插件日志出现
- [ ] 给仓库加 `dsh-plugin` GitHub topic，便于被发现