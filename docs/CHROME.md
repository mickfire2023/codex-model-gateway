# 可选 Chrome 接入

此组件通过微软官方 Playwright MCP，让已接入 Codex 的模型操作独立的 Google Chrome。它保留原来的 Codex 浏览器插件，也不修改模型、账号登录或其他插件配置。两条浏览器路径可以同时保留；需要使用本组件时，在请求中指定 `chrome_text` 或 `chrome_vision`。

## 安装

需要 Windows、已安装的 Google Chrome、Node.js 24 及以上和现有 npm。从本项目根目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-chrome.ps1
```

默认只添加文本浏览工具 `chrome_text`。如果还需要让支持图片的模型读取截图，明确启用第二个服务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-chrome.ps1 -EnableVision
```

安装完成后重启 Codex，使新的 MCP 工具被加载。安装器本身只准备依赖并运行版本/帮助检查，不启动 Chrome，也不调用模型。首次使用浏览工具时才会打开独立 Chrome。

若现有 npm 不在常见安装位置，可指定已安装的 Node 和 npm CLI：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-chrome.ps1 -NodePath 'C:\Tools\node\node.exe' -NpmCliPath 'C:\Tools\node\node_modules\npm\bin\npm-cli.js' -EnableVision
```

也可使用 `-ChromePath` 指定 Chrome，或用 `-InstallDirectory`、`-ConfigPath` 指定独立安装目录和已有 Codex 配置文件。`-WhatIf` 只预览；不会访问 npm、安装依赖、写配置或启动浏览器。

默认安装目录为 Windows“文档”中的 `CodexChromeBridge`。安装器核验官方 npm 元数据的仓库、固定版本 `@playwright/mcp 0.0.83`、下载地址和 SHA-512 完整性，再安装到独立的版本目录 `runtimes/playwright-mcp-0.0.83`。npm 安装脚本和浏览器下载均关闭；不修改本项目根目录的依赖。

## 选择模式

| 模式 | 用法 | 适合的模型 |
| --- | --- | --- |
| `chrome_text` | 读取网页文字和可访问性结构，按页面元素点击、输入、选择和切换标签；截图可保存，但不把图片回传给模型 | 支持工具调用的文本或多模态模型 |
| `chrome_vision` | 包含相同页面操作工具，并将截图图片回传给模型理解 | 已验证支持工具图片输入的多模态模型 |

例如：

> 使用 chrome_text 打开这个网址，读取页面标题，点击“查询”并告诉我结果。

> 使用 chrome_vision 打开这个测试页面，截取当前页面，根据截图识别提示码，再继续操作。

两个服务分别使用独立的临时 Chrome 会话，不共享标签页或登录状态。在同一任务中持续使用同一个模式，避免切换到另一实例后找不到刚才的页面。`-EnableVision` 额外添加视觉实例，默认文本实例仍然可用；后续不带此开关重跑安装器也不会移除已经启用的视觉实例。

本次真实 Codex 客户端验证覆盖 14 个可选择型号：7 个 GPT、DeepSeek Flash、DeepSeek V4 Pro 和 5 个 Gemini。支持视觉的 13 个型号完成了页面元素操作和截图随机码识别；当前配置为纯文本的 DeepSeek V4 Pro 完成了页面元素操作和截图保存。该结果针对本次测试时的客户端、型号和上游接口，不能替代未来新增型号的验证。测试方式和结果见 [验证记录](VALIDATION.md)。

## 配置与恢复

连接使用 stdio、`--browser chrome --isolated`。它不复制用户 Chrome 的 profile、cookie 或密码，不开启 Chrome 远程调试端口，也不需要关闭原有 Chrome。临时会话关闭后不会保留登录状态；需要登录时由用户在该独立窗口完成。

仅允许下列 14 个浏览工具：`browser_navigate`、`browser_navigate_back`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_fill_form`、`browser_select_option`、`browser_press_key`、`browser_hover`、`browser_tabs`、`browser_resize`、`browser_take_screenshot`、`browser_wait_for`、`browser_close`。名称已对照固定 0.0.83 的实际工具定义核验。JavaScript 求值、任意代码、shell、存储读写、文件上传和网络检查工具不在白名单中。

安装器不写全局自动审批或工具审批覆盖，继续使用 Codex 原来的权限设置。工具白名单本身不是浏览器或系统安全沙箱；网页导航、点击和输入仍可能改变网站状态，操作应遵循用户授权和 Codex 的确认规则。

配置修改前，原文件备份到安装目录受当前用户权限保护的 `private` 文件夹。新增时仅追加 `mcp_servers.chrome_text`，以及显式启用的 `mcp_servers.chrome_vision`。升级时仅更新与本安装标记完全匹配的生成块；同名其他配置或被手动修改的块会保留并停止。复杂的内联/父级 MCP 表也会安全拒绝，不猜测其含义。

运行时先在独立预备目录安装并验证，成功后才连接 Codex；准备失败时，原运行时、安装标记和配置保持。写入前再次检查是否存在并发编辑，避免覆盖用户刚保存的设置。安装器不编辑 `auth.json`、模型列表或默认模型。

移除本组件时，只移除生成的 `mcp_servers.chrome_text` 和（如有）`mcp_servers.chrome_vision` 块，然后重启 Codex。保留其他配置；使用整份备份恢复前，应先确认后续改动是否需要保留。本组件没有计划任务或开机服务。`private` 中的备份可能含原配置内的凭据，请勿上传安装目录。

## 能力边界

- 纯文本模型可操作有页面文字、可访问性信息的网页，但不能因接入 Chrome 就获得看图能力。DeepSeek V4 Pro 当前应使用 `chrome_text`；图表、canvas 或只靠截图才能识别的内容，需要已验证的视觉型号。
- 页面元素操作成功，不代表每个网站、验证码、登录流程或所有模型版本均兼容。截图链路还取决于上游是否接受工具返回的图片。
- 模型目录自动发现不等于浏览器能力自动验证；新增型号需要重新测试。上游额度、冷却和接口变化仍会影响执行。
- 安装/配置夹具测试不访问模型或 Chrome。真实客户端验证另外执行，不能将单元测试通过视为完整浏览器兼容证明。

官方来源：[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[参数说明](https://github.com/microsoft/playwright-mcp#configuration)、[Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)。接入已有登录 Chrome 的官方扩展是另一种方案，需另外安装与授权，见 [Playwright 扩展文档](https://github.com/microsoft/playwright/tree/main/packages/extension#readme)；本组件默认使用独立 Chrome。
