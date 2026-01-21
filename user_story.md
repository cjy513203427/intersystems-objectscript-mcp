第一步：项目初始化与依赖安装 (Setup & Dependencies)
让 Cursor 帮你搭建基于 TypeScript 的 Node.js 环境，并安装必要的 MCP 核心库。

Prompt 1: 我要用 Node.js (TypeScript) 开发一个 InterSystems IRIS 的 MCP Server。

项目基础要求：

核心库： 使用 @modelcontextprotocol/sdk 作为 MCP 协议库。

校验库： 使用 zod 定义工具的输入 Schema。

HTTP库： 使用 axios 处理与 IRIS 的 REST API 通信。

配置： 使用 dotenv 读取 .env 文件。

请执行以下操作：

生成 package.json 内容，包含上述依赖以及 tsx (用于直接运行 TS 文件) 和 @types/node。

PS C:\Projekte\Personal\intersystems-objectscript-mcp> nvm ls

    24.7.0
使用这个node版本

创建项目目录结构，入口文件设为 src/index.ts。

创建一个 .env 模板，包含 IRIS_URL (如 http://localhost:52773), IRIS_NAMESPACE (默认为 USER), IRIS_USERNAME, IRIS_PASSWORD。

此时不要写业务代码，先帮我把环境和配置文件搞定。

第二步：Server 骨架与连接测试 (Server Skeleton)
这一步建立 MCP 服务器实例，并打通与 IRIS 的第一条 HTTP 链路。

Prompt 2: 环境已准备好。现在开始编写 src/index.ts。

任务：

引入 McpServer 和 StdioServerTransport。

创建一个 Axios 实例，配置 Base URL (读取环境变量) 和 Basic Auth 认证头。确保设置 Content-Type: application/json。

编写一个辅助函数 verifyConnection()，调用 IRIS 的 /api/atelier/ 接口。

如果成功，在控制台打印版本信息。

如果失败，打印错误并退出进程。

初始化 MCP Server 实例，并设置 transport 启动服务器。

代码必须包含完善的错误捕获 (try-catch)。

第三步：核心工具 - 智能获取 .int 代码 (The .int Fetcher)
这是最核心的逻辑。在 Node.js 中，我们可以利用 Zod 来清晰地定义参数。

Prompt 3: 连接测试通过。现在我们要实现核心工具：获取 Routine (.int) 代码，以便 AI 理解宏展开后的逻辑。

请注册一个名为 get_iris_routine 的工具：

Schema 定义 (Zod)：

name: string (类名或 Routine 名，如 "User.Test.cls" 或 "User.Test.1.int")。

namespace: string (可选，如果不填则使用环境变量中的默认值)。

逻辑处理：

判断 name 后缀。如果是 .cls，自动替换为 .1.int (例如 Package.Class.cls -> Package.Class.1.int)。

使用 Axios 调用：GET /api/atelier/v1/{namespace}/routines/{routineName}。

返回结果：

Atelier API 通常返回 JSON { content: [...] }。请将数组 join 起来返回纯文本。

如果返回 404，返回友好的提示“未找到编译后的代码，请先检查类是否已编译”。

第三步补丁：获取原始代码 (Original Source)
有时你也需要看原始代码。

Prompt 4: 顺便再增加一个工具 get_class_source 用于获取原始类定义 (.cls)。

逻辑：

使用 GET /api/atelier/v1/{namespace}/doc/{className}。

同样使用 Zod 定义参数 (className, namespace)。

注意：Atelier 获取 Doc 的接口返回结构可能包含 content 数组，处理方式与 Routine 类似。

请确保将此工具注册到同一个 Server 实例中。

第四步：环境感知与 SQL 执行 (Namespace & SQL)
让 AI 知道自己在哪里，并能查询数据。

Prompt 5: 最后，添加两个辅助工具来增强 AI 的环境感知能力：

list_namespaces 工具：

由于 Atelier API 没有直接列出 Namespace 的简单端点，请通过执行 SQL 来获取：SELECT Name FROM %SYS.Namespace。

你需要封装一个通用的 executeSQL 内部函数。

execute_iris_sql 工具：

对外暴露 SQL 执行能力。

参数：query (SQL 语句), namespace (可选)。

调用端点：POST /api/atelier/v1/{namespace}/query。

关键点： IRIS 返回的 JSON 格式是 { result: { content: [...] } }。请将结果格式化为 Markdown 表格字符串，以便 AI 阅读。

第五步：运行配置 (Run Configuration)
最后，让 Cursor 告诉你如何在它自己的配置里填入这段代码。

Prompt 6: 开发完成。请告诉我：

如何在本地终端使用 npx tsx 运行并测试它 (Inspector 模式)。

如何在 Claude Desktop 或 Cursor 的配置文件中配置这个 MCP Server。请给出具体的 JSON 配置段落。

注意：Command 应该是 node 或 npx，Args 需要包含完整的路径。