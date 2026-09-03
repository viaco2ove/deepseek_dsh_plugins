# dsh-Identify-local-files

DeepSeek Harness 双面插件：在 Composer 中直接粘贴本地文件（图片、文本、代码、配置等），同时为 Agent 提供 `read_local_file` 工具以读取任意本地文件。

---

## 解决了什么问题

### 问题一：粘贴本地文件无处可用

在日常开发中，你经常需要将本地文件内容发给 AI 助手——比如一段报错日志、一份配置文件（`.env`、`.json`、`yaml`）、一段代码、或者一个 Markdown 笔记。

**现状**：DeepSeek Harness 的官方粘贴功能只支持图片，非图片文件会被拒绝或无法处理。你只能手动复制文件内容再粘贴，效率低下且容易出错。

### 问题二：Agent 无法读取工作区外的文件

当 Agent 需要分析你的项目结构、查看某个配置、理解一段代码时，如果文件不在 DSH 的 workspace 内，Agent 就"看不见"它。你需要手动把文件内容复制给 Agent。

---

## 如何解决

### 双面架构

插件分为**宿主半部分（Host Half）**和**客户端半部分（Client Half）**，各司其职：

```
┌─────────────────────────────────────────────────────────┐
│                    DeepSeek Harness                      │
├──────────────────────┬──────────────────────────────────┤
│  Host Half（宿主半）  │   Client Half（客户端半）          │
│  运行在 Node.js 进程  │   运行在浏览器中                  │
│                      │                                  │
│  ┌────────────────┐  │  ┌────────────────────────────┐  │
│  │ read_local_file│  │  │ paste 事件拦截器            │  │
│  │ 工具注册       │  │  │ 非图片文件 → 读取文本内容   │  │
│  └────────────────┘  │  │ 插入到 Composer 输入框       │  │
│                      │  └────────────────────────────┘  │
└──────────────────────┴──────────────────────────────────┘
```

#### 客户端半部分（粘贴即插入）

在浏览器中拦截 `paste` 事件：

1. 检测剪贴板中是否包含**非图片文件**
2. 如果是文本文件（代码、配置、日志等），直接读取文件内容
3. 自动插入到 Composer 输入框末尾，附带文件名标注
4. **图片文件不受影响**，继续走官方图片粘贴通道
5. 二进制文件提示用户保存到 workspace 后用 `read_local_file` 读取

支持的文本文件类型（按扩展名判断）：
`.txt` `.md` `.markdown` `.json` `.jsonc` `.json5` `.yaml` `.yml` `.toml` `.ini` `.cfg` `.conf` `.env` `.js` `.mjs` `.cjs` `.ts` `.tsx` `.jsx` `.py` `.rb` `.go` `.rs` `.java` `.kt` `.c` `.h` `.cpp` `.hpp` `.cs` `.php` `.sh` `.bash` `.zsh` `.ps1` `.bat` `.cmd` `.sql` `.html` `.htm` `.css` `.scss` `.less` `.svg` `.xml` `.csv` `.tsv` `.log` `.diff` `.patch` `.properties`

#### 宿主半部分（Agent 的文件读取能力）

Agent 调用 `read_local_file` 工具时，宿主半部分：

- **图片文件**（PNG/JPEG/WebP/GIF）：读取为 base64，以 Data URL 形式返回，Agent 可以直接"看到"图片（vision）
- **文本文件**：读取内容直接内联返回（受字节上限限制）
- **二进制文件**：返回文件路径和大小，Agent 可以据此指导用户操作
- 所有文件均受大小上限保护

---

## 如何使用

### 前提条件

- DeepSeek Harness 桌面版（`deepseek-harness-desktop`）
- 已安装 Node.js >= 22.6.0

### 安装插件

#### 方式一：通过命令行（推荐）

```bash
# 进入你的 desktop profile 目录
cd ~/.dsh/profiles/desktop

# 添加插件（使用 file: 协议链接到源码目录进行开发）
pnpm add dsh-Identify-local-files --file:D:/Users/viaco/PycharmProjects/deepseek_dsh_plugins/dsh-Identify-local-files

# 或者从 npm 安装发布版本
pnpm add dsh-Identify-local-files
```

#### 方式二：手动编辑 profile 配置

编辑 `~/.dsh/profiles/desktop/package.json`，在 `dependencies` 和 `dsh.profile.bundles` 中添加：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-Identify-local-files": "file:D:/path/to/dsh-Identify-local-files"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-Identify-local-files"
      ]
    }
  }
}
```

然后在 profile 目录运行：

```bash
pnpm install
```

### 重新启动应用

安装或更新插件后，**必须重启 DeepSeek Harness 桌面应用**，DSH 才会重新扫描并加载新插件。

---

## 功能详解

### 1. 粘贴文件到 Composer（Client Half）

从操作系统文件管理器或 IDE 中**复制一个或多个文件**，然后在 Composer 输入框中**按下 Ctrl+V / Cmd+V**：

```
[file: config.json]
{
  "database": {
    "host": "localhost",
    "port": 5432
  }
}
```

**行为规则**：

| 文件类型 | 处理方式 |
|---|---|
| 图片文件（PNG/JPG/WebP/GIF） | **不拦截**，继续走官方图片粘贴通道 |
| 文本文件（代码/配置/日志等） | 读取内容，插入到 Composer，光标定位在末尾 |
| 二进制文件 | 提示用户保存到 workspace，再用 `read_local_file` 读取 |

**文件过长时**：超过 8192 字符的文本文件只插入前 8192 字符，末尾附注截断提示和完整读取方法：

```
[file: large.log — first 8192 chars of 45678]
...（文件内容前 8192 字符）...
…[truncated — use read_local_file on the saved file for the rest]
```

### 2. Agent 读取本地文件（Host Half）

在对话中，**让 Agent 分析本地文件**：

> "帮我看看 `D:\Projects\myapp\src\index.ts` 的内容"

Agent 会调用 `read_local_file` 工具：

| 文件类型 | Agent 看到的效果 |
|---|---|
| 图片（PNG/JPG/WebP/GIF） | 图片以 Data URL 返回，Agent 可以进行视觉分析 |
| 文本文件 | 文件内容直接内联到回复中 |
| 二进制文件 | `binary /path/to/file.ext (12345 bytes)` |

**调用示例**：

```
Tool: read_local_file
Arguments: { "path": "/path/to/image.png" }
Result: {
  "kind": "image",
  "dataUrl": "data:image/png;base64,...",
  "bytes": 45678
}
```

---

## 配置参数

插件支持以下配置（在 profile 的 `cordis.patch.yml` 中设置）：

```yaml
- insert:
    - id: dsh-Identify-local-files
      name: 'dsh-Identify-local-files'
      config:
        maxFileBytes: 20971520      # 单次读取的最大文件大小（字节），默认 20 MiB
        maxTextBytes: 2097152       # 返回给模型的最大文本大小（字节），默认 2 MiB
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `maxFileBytes` | 20 MiB | 单次 `read_local_file` 调用允许读取的最大文件大小 |
| `maxTextBytes` | 2 MiB | 文本文件内容返回给 Agent 时的最大字节数 |

---

## 技术细节

### 架构

```
.dsh/profiles/desktop/
├── node_modules/
│   └── dsh-Identify-local-files/      # 插件安装位置
│       ├── lib/
│       │   ├── index.js               # Host Half（Node.js）
│       │   └── client.js              # Client Half（浏览器）
│       ├── cordis.patch.yml            # Cordis 插件注册声明
│       └── package.json
└── cordis.patch.yml                   # Profile 级配置
```

### Cordis 插件加载流程

1. DSH 启动时扫描 `node_modules` 中的包，找到声明了 `dsh.bundle.patch` 的包
2. 读取 `cordis.patch.yml`，通过 `name` 字段（npm 包名）加载插件模块
3. Host Half 的 `apply(ctx, config)` 函数被调用，注册工具
4. Client Half 的 bundle 通过 `/plugins/<id>/client.js` URL 被浏览器加载

### 为什么需要两个半部分？

| 能力 | 位置 | 原因 |
|---|---|---|
| 访问本地文件系统 | Host (Node.js) | 浏览器无法直接读写本地文件 |
| 拦截 paste 事件 | Client (Browser) | 只能在渲染进程捕获剪贴板事件 |
| 注册 Agent 工具 | Host (Node.js) | 工具执行在 Node.js 环境 |
| 操作 Composer UI | Client (Browser) | 只有浏览器能访问 DOM |

---

## 开发指南

### 源码结构

```
dsh-Identify-local-files/
├── src/
│   ├── index.js       # Host Half 源码（ESM）
│   └── client.js      # Client Half 源码（语法兼容 CJS，不能有 import/export）
├── lib/               # 构建输出目录
│   ├── index.js
│   └── client.js
├── cordis.patch.yml  # Cordis 插件注册
├── package.json
└── build.mjs         # 构建脚本
```

### 构建

```bash
node build.mjs
```

构建脚本会：
1. 将 `src/index.js` 复制到 `lib/index.js`
2. 用 `new Function()` 验证 `src/client.js` 语法正确性（确保是纯 CJS，无 ESM 语法）
3. 将 `src/client.js` 复制到 `lib/client.js`

### 发布到 npm（可选）

```bash
# 1. 确保 lib/ 是最新构建
node build.mjs

# 2. 在 package.json 设置正确的 version
# 3. 发布
npm publish --access public
```

---

## 常见问题

**Q: 重启后插件没有生效？**
A: 确保 desktop profile 的 `package.json` 中 `dsh.profile.bundles` 包含 `dsh-Identify-local-files`，然后在 profile 目录运行 `pnpm install`。

**Q: 粘贴图片不工作了？**
A: 正常。图片粘贴不受此插件影响，继续走官方通道。如果图片粘贴失败，请检查官方图片处理流程。

**Q: Agent 调用 `read_local_file` 报错 "file not found"？**
A: 文件路径需要使用绝对路径，或者相对于当前工作目录。Windows 路径需要使用反斜杠或正斜杠均可。

**Q: 可以读取 symbolic link（符号链接）吗？**
A: 可以。`read_local_file` 使用 Node.js 的 `fs.stat()` 和 `fs.readFile()`，会跟随符号链接。
