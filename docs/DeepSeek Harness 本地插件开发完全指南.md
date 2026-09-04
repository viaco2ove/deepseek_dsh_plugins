# DeepSeek Harness 本地插件开发完全指南
## 教程（8月21号）
DeepSeek Harness 本地插件开发完全指南（8月21号）
从零开始，4 步创建并部署你的第一个 DSH 本地插件

前言
DeepSeek Harness (DSH) 提供了强大的工具系统，但有时候我们需要集成特定的第三方 API 或实现自定义功能。DSH 的插件系统允许我们创建本地插件，无需发布到 npm，直接在本地使用。

本文将分享 DSH 本地插件开发的完整方法论，包括：

插件命名规范
工具定义方法
API 集成技巧
部署和调试流程
示例项目: dsh-plugins-examples

什么是 DSH 本地插件？
DSH 插件是一种扩展机制，允许你向 DSH 注册自定义的功能模块。本地插件的特点是：

✅ 无需发布 - 直接放在本地 ~/.dsh/profiles/node_modules/ 目录
✅ 即时生效 - 重启 DSH 后即可使用
✅ 完全可控 - 代码完全由你控制
✅ 易于分享 - 可以打包分享给团队
插件开发环境准备
1. 确认 DSH 安装路径
# Windows 默认路径
C:\Users\用户名\.dsh\profiles\node_modules\@deepseek-ai\
2. 准备开发目录
# 创建开发目录
mkdir D:\dspace
cd D:\dspace
第一步：创建插件骨架
我写了一个自动化脚本，可以快速创建插件骨架：

# 创建插件
.\scripts\create-local-plugin.ps1 -pluginName "my-tool" -seam "tools"
这会生成以下结构：

dsh-my-tool/
├── package.json
├── lib/
│   └── index.js
└── cordis.patch.yml
核心文件说明
package.json - 插件元数据：

{
  "name": "@deepseek-ai/dsh-my-tool",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./lib/index.js"
  }
}
lib/index.js - 插件主代码（模板）：

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "my-tool";
export const inject = ["tools"];
export const Config = z.object({});

export function apply(ctx, config = {}) {
    console.log('[my-tool] Loaded successfully');
}
第二步：实现工具逻辑
定义工具
使用 defineTool API 定义工具：

const myTool = defineTool({
    name: "my_tool",
    description: "我的自定义工具",
    parameters: {
        input: {
            type: "string",
            required: true,
            description: "输入参数"
        }
    },
    output: {
        schema: { type: "json" }
    },
    async execute(args) {
        const { input } = args;
        return { result: `处理：${input}` };
    }
});
注册工具
在 apply 函数中注册：

export function apply(ctx, config = {}) {
    ctx.tools.register(myTool);
    console.log('[my-tool] Tool registered successfully');
}
完整示例：GitHub 搜索工具
const searchRepositoriesTool = defineTool({
    name: "github_search_repositories",
    description: "搜索 GitHub 仓库",
    parameters: {
        query: {
            type: "string",
            required: true,
            description: "搜索查询"
        },
        page: {
            type: "integer",
            description: "页码",
            default: 1
        }
    },
    output: { schema: { type: "json" } },
    async execute(args) {
        const { query, page = 1 } = args;
        const token = process.env.GITHUB_TOKEN;
        
        const response = await fetch(
            `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=10&page=${page}`,
            {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        );
        
        return await response.json();
    }
});
第三步：部署插件
方法 1：使用部署脚本
.\scripts\deploy-local-plugin.ps1 -sourcePath "D:\dspace\dsh-my-tool" -pluginName "my-tool"
方法 2：手动复制
Copy-Item -Path "D:\dspace\dsh-my-tool\*" -Destination "C:\Users\用户名\.dsh\profiles\node_modules\@deepseek-ai\dsh-my-tool\" -Recurse -Force
方法 3：注册到 cordis.patch.yml
编辑 C:\Users\用户名\.dsh\profiles\web\cordis.patch.yml：

# Register my tool plugin
- insert:
    - id: my-tool
      name: '@deepseek-ai/dsh-my-tool'
第四步：重启 DSH
dsh web
查看日志确认加载成功：

[my-tool] Tool registered successfully
刷新浏览器（http://127.0.0.1:3080），在工具列表中查看新添加的工具。

关键注意事项
⚠️ 参数 Schema 规则
这是最容易出错的地方！

// ✅ 正确 - 可选参数不要写 required: false
parameters: {
    requiredField: {
        type: "string",
        required: true,
        description: "必填字段"
    },
    optionalField: {
        type: "string",
        description: "可选字段",
        default: "默认值"
    }
}

// ❌ 错误 - required 不能为 false
parameters: {
    optionalField: {
        type: "string",
        required: false,  // 会报错!
        default: "默认值"
    }
}
错误信息：unsupported JSON schema: parameters.x.required must be true when present

⚠️ 输出 Schema
必须包含 output 字段：

output: {
    schema: { type: "json" }
}
错误信息：Cannot read properties of undefined (reading 'render')

⚠️ Config Schema
使用 z.string() 等构造器，不是普通对象：

// ✅ 正确
export const Config = z.object({
    apiKey: z.string().default("default_key")
});

// ❌ 错误
export const Config = z.object({
    apiKey: {
        type: "string",
        default: "default_key"
    }
});
⚠️ 热重载
tools seam 不支持热重载，每次修改后必须重启 DSH：

dsh web
实战案例：博客园插件
我创建了一个博客园 API 插件，包含 9 个工具：

// 发布文章工具
const newPostTool = defineTool({
    name: "cnblogs_new_post",
    description: "发布新文章",
    parameters: {
        title: {
            type: "string",
            required: true,
            description: "文章标题"
        },
        content: {
            type: "string",
            required: true,
            description: "文章内容（HTML 格式）"
        },
        tags: {
            type: "array",
            description: "标签列表",
            default: []
        }
    },
    output: { schema: { type: "json" } },
    async execute(args) {
        const { title, content, tags = [] } = args;
        const token = process.env.CNBLOGS_META_TOKEN;
        
        const response = await fetch('https://api.cnblogs.com/posts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title, content, tags })
        });
        
        return await response.json();
    }
});
使用示例：

cnblogs_new_post(
    title="我的第一篇文章",
    content="<p>这是正文内容</p>",
    tags=["技术", "分享"]
)
常见问题
Q: 插件不显示在工具列表中？
A: 检查以下几点：

cordis.patch.yml 是否有注册条目
是否重启了 DSH
是否有 schema 错误（查看日志）
Q: 如何调试插件？
A: 使用 console.log 输出日志，重启 DSH 后查看控制台输出。

Q: 插件可以共享吗？
A: 可以！将整个插件目录打包分享给他人，他们只需复制到自己的 ~/.dsh/profiles/node_modules/ 目录即可。

总结
通过这篇文章，你学会了：

✅ 创建 DSH 本地插件的完整流程
✅ 定义和注册自定义工具
✅ 避免常见的 schema 错误
✅ 部署和调试插件
以上示例插件都遵循相同的模式。你可以基于这些示例，快速创建自己的自定义工具。

### 示例代码:
dsh-plugins-examples：[DeepSeek Harness 本地插件开发完全指南](https://github.com/tanzhangjia/dsh-plugins-examples)
https://deepseekharness.io/zh/plugin-development/

## dsh-market 插件例子（依然维护中的，比上面的可以过时的教程更有说服力）
https://github.com/dsh-market/dsh-market

## dsh-file-upload
https://github.com/GLFzr/dsh-file-upload
先给 http://127.0.0.1:3081 web 环境 安装 D:\Users\viaco\PycharmProjects\deepseek_dsh_plugins\.cache\dsh-file-upload
看看效果

## 其他插件
https://github.com/lhh010/dsh-paste-input.git
https://github.com/Mooling0602/dsh-web-file-uploader.git
dsh plugin --profile web add github:lywusichen/dsh-sidebar-buttons
## 插件市场（多！所以乱，插件也是如此多而乱）
https://dsh.directory/
https://dshmarket.com/zh/
https://dsh.market/
https://www.dsh-plugin.shop/

