# Codex Model Gateway

[English](docs/README.en.md) · [安装与恢复](docs/INSTALL.md) · [Chrome 接入](docs/CHROME.md) · [Gemini 可选组件](docs/GEMINI.md)

一个运行在 Windows 本机的 Codex 模型网关。在保留原有 ChatGPT 登录与 GPT 模型的同时，将 DeepSeek 和其他 OpenAI 兼容 API 加入同一个模型选择器。

面向个人电脑使用。当前支持 Windows 10/11、Windows PowerShell 5.1 和 Node.js 24 及以上；管理界面为中文。它不是云端共享代理，也不是 OpenAI、DeepSeek 或 Google 的官方产品。

## 功能

- GPT 使用 Codex 原有 ChatGPT 登录；各服务商只收到自己的 API 密钥。
- 同时添加多个兼容 Responses / Chat Completions 的服务商，编辑或移除单个模型。
- 支持流式输出、HTTP/WebSocket、工具调用转换、长上下文摘要及进程内的跨模型续聊。
- 管理页可配置密钥、诊断连接、试用模型、刷新目录、重启与恢复 GPT 直连。
- GPT / DeepSeek 每 30 分钟检查目录；失败时保留已知列表。模型是否可用取决于账号、客户端版本和上游兼容性。
- 当前用户的 Windows 计划任务负责后台运行，不依赖 Codex 进程存活；无需管理员权限或 Windows 密码。
- 可选 Gemini 第三方订阅适配及工具兼容性验证后的自动发现，默认不安装。
- 可选微软官方 Playwright MCP Chrome 接入：纯文本模型通过页面元素操作，视觉模型可单独启用截图；使用独立 Chrome 状态，保留原浏览器插件和登录。

## 快速开始

1. 安装 [Node.js 24 LTS 或更高版本](https://nodejs.org/)，安装并登录 Codex；先确认原有 GPT 能正常使用。
2. 下载此仓库 ZIP 并解压，或克隆仓库。在项目目录打开 PowerShell：

```powershell
npm ci --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

3. 安装成功后重启 Codex。打开桌面 `Codex model gateway` 文件夹中的“模型网关管理”，填写自己的 API 密钥并添加模型。

安装器先验证独立服务健康，再修改 Codex 连接；已有安装再次运行会进入保留密钥和模型设置的升级流程。首次安装发现其他自定义连接时会停止，避免覆盖其他网关。可使用 `-WhatIf` 预览，或通过 `-InstallDirectory`、`-ConfigPath`、`-Port` 指定位置与端口。

默认安装到 Windows“文档”文件夹的 `CodexModelGateway`。运行环境会复制到安装目录；安装后移动源码不会影响后台服务。源码中的模型目录为空，新用户从自己账号的本机缓存和上游接口获得实际列表，不附带任何人的登录信息或固定 GPT 清单。

## 添加 API

基础地址填写 `https://供应商地址/v1`，不追加 `/responses` 或 `/chat/completions`。选择对应协议，填写模型的准确 ID、上下文/输出上限及能力。保存前会验证 `GET /models` 权限，不产生模型生成费用；页面的简短试用会调用模型并可能计费。

远程地址要求 HTTPS，本机接口允许 `http://127.0.0.1:端口`。没有模型列表接口的服务商暂不支持直接保存。具体供应商的工具和推理能力需要实际验证；协议兼容不代表所有模型都能执行编程任务。

Gemini 付费 API 可按上述方式添加兼容接口。**Gemini 订阅登录不是公开付费 API**，第三方复用登录凭据受到 Google 条款限制，可能导致访问被停用；可选订阅组件的限制、独立安装与关闭方法见 [Gemini 说明](docs/GEMINI.md)。

## 恢复原连接

打开桌面“恢复 GPT 直连”，完成后重启 Codex。管理页打不开时也可运行安装目录中的 `restore.ps1`；PowerShell/VBS 不可用时使用同目录的 `Emergency-restore-GPT.cmd`。恢复会保留聊天、加密密钥及无关设置。

恢复后可以再使用“重新启用模型网关”。完整升级、排错和卸载步骤见 [安装文档](docs/INSTALL.md)。

## 数据与限制

API 密钥用 Windows 当前用户 DPAPI 加密保存在安装目录 `private`。该目录限制为当前用户访问；管理地址含有本机管理令牌，也应视为凭据。不要共享安装目录、配置备份或完整日志。日志不记录密钥、请求头或对话正文。

跨模型历史仅在进程内存保留，默认最多 30 分钟、128 条和 32 MB。网关重启或历史过期后，仅引用旧回复 ID 的请求可能需要在带摘要的新聊天中重试。OpenAI 的私有加密上下文无法由其他服务商解密。模型开始生成后不会自动重放失败请求，以免重复执行工具。

此工具依赖 Codex 当前的连接配置与模型协议；客户端或服务商的协议变更可能需要代码更新。支持范围为个人 Windows 安装；不承诺所有 Codex 分发版本均兼容。

## 开发与验证

```powershell
npm ci --ignore-scripts
npm test
npm run check:release
npm run test:lifecycle
```

Node 测试使用模拟账号、密钥和本机服务器，不调用付费模型。计划任务及首次安装测试在独立临时目录和端口中运行，不操作实际安装。GitHub Actions 在 Windows 上执行同一套检查。详细结构见 [开发说明](docs/DEVELOPMENT.md)。

MIT 许可证。第三方依赖的许可证和来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
