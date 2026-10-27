# 可选 Antigravity 组件（Gemini 与 Claude）

2.6.0 将账号目录中的 Claude 文本模型加入同一订阅适配，并根据上游模型定义提供 Gemini 思考深度选项。目录中出现型号后，仍需通过实际两轮工具兼容性验证，才会加入 Codex。是否可用取决于账号权限、套餐和上游状态；本项目不附带模型访问权。旧的 `gemini-subscription` 服务商标识、安装目录和脚本名保留兼容。

已有安装按下文同时更新组件和主网关；Claude 需要本项目 `8.0.43-gateway.1` 兼容构建。修复保留原账号授权和服务商配置，不需要重新 OAuth 或初始化。升级后重新启动 Codex 或新建聊天以刷新模型配置，缓存的旧 Gemini 指令也有精确兼容处理。上游返回 429 时仍需等待额度/冷却恢复，或选择其他可用型号；网关不通过额外生成重试或付费兜底绕过限制。

## 先选择接入方式

**推荐：使用 Gemini 付费 API。** 通过 Google 提供的 OpenAI 兼容 API 地址，在主网关管理页添加 API 密钥和模型即可；无需安装本组件。订阅套餐与 API 计费不同，购买 Gemini 网页套餐不等于获得通用 API 额度。

**第三方订阅适配：高级、可选、默认关闭。** 本目录的脚本配合 CLIProxyAPI 的 Antigravity OAuth 适配，使用自己的 Google 账号授权；它不读取浏览器 cookie 或密码。Google 的相关条款限制第三方软件复用订阅登录访问这些后端，可能停用服务或账号访问。此方式不受 Google 官方支持，也不保证账号资格或长期可用。请自行阅读 [Antigravity 条款](https://antigravity.google/terms) 和 [Gemini CLI 条款说明](https://geminicli.com/docs/resources/tos-privacy/)。

只有你主动选择并传入 `-AcceptThirdPartyTerms`，脚本才会安装或连接。项目不自带 OAuth 客户端凭据；授权流程由你另行下载的第三方组件实现。不要把这个方式称为官方订阅 API；它使用该账号可用的 Antigravity 服务额度，不把网页聊天次数兑换为 API 余额。

## 安装独立组件

1. 先完成主网关安装。
2. 从本项目 [v2.6.0 发布附件](https://github.com/mickfire2023/codex-model-gateway/releases/download/v2.6.0/cliproxyapi-8.0.43-gateway.1-windows-amd64.zip) 下载 Windows x64 兼容构建并解压，保留原 MIT 许可证 `LICENSE-CLIProxyAPI`。
3. 核对 ZIP SHA-256：`0e8c0a0b49fd649f511e45a726eb024edc8f0ae01a7d73f489d7761978674b3a`。安装器还会核对解压后 EXE SHA-256：`71130aaff2b1dd3fd58177d868b2b331e1bf217bf16802441aa8e158e2f87e87`。发布页同时提供 `SHA256SUMS.txt`。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-gemini.ps1 `
  -BinaryPath 'D:\Downloads\CLIProxyAPI\cli-proxy-api.exe' `
  -LicensePath 'D:\Downloads\CLIProxyAPI\LICENSE-CLIProxyAPI' -AcceptThirdPartyTerms

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\connect-gemini.ps1 `
  -AcceptThirdPartyTerms
```

默认目录为 Windows“文档”下 `CodexGeminiBridge`，端口 8317；可通过参数修改，连接时传入相同目录。仅一个 Google 账号。登录会打开 Google 真正的授权页，短期回调器仅监听 `127.0.0.1:51121` 并校验 state；误关页面时，会话有效期内可重新打开 `http://127.0.0.1:51121/login`。成功、取消或超时会关闭回调器。

首次连接会从当前账号目录动态挑选最多两个具备完整资料的文本模型，做两轮模拟工具和续调检查；实际返回的思考签名也会验证。Claude 在简单工具请求中可能完全不输出思考项，这种情况允许直接验证工具结果续调；出现无效或缺少签名的思考项仍会拒绝。不会执行模拟工具，但会消耗少量订阅额度。通过后注册模型、开启自动发现、重启主网关。更换账号或重复执行安装不会覆盖原注册；请先断开旧服务商并重新核对权限与工具兼容性。

官方 CLIProxyAPI 8.0.43 和 8.0.44 会丢弃实际 Claude 5.5 的 channel 19（Q19）带签名思考，单纯通过工具调用测试不足以证明这种续调可用。兼容构建以 8.0.43 为基础，只放行已验证的 channel 18、19，继续拒绝未知 channel 20，并逐字节保留签名。补丁源码、构建步骤与固定摘要见 [vendor-patches](../vendor-patches/README.md) 和 [binary-manifest.json](../bridge/binary-manifest.json)；二进制作为发布附件提供，不提交到源码仓库。

仅使用 Gemini 时，仍可提供 [官方 8.0.43 Windows x64 ZIP](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.43)：ZIP SHA-256 为 `332cc8e0cd7370c841ce96b37cb1ae380136f1e4d7d54a610080ab81b5f6aec2`，EXE SHA-256 为 `1b444cc3c91bd8f33130ec282274b088bbb6b23c6e310dd945d746ee58dbd1a4`，`-LicensePath` 应指向该包的 `LICENSE`。使用原版二进制时，Claude 自动发现会保留为待处理；已注册 Claude 的请求返回要求升级的 503。能力判断核对实际 EXE 摘要，不能只修改安装元信息来启用。

## 思考深度

模型选择器只显示该型号上游资料明确声明的档位。当前 Gemini 4 Argon、Gemini 3.8 Flash 的资料声明 `low / medium / high`；Gemini 3 Flash、3.1 Flash Lite、3.5 Flash Lite 声明 `minimal / low / medium / high`。模型 ID 末尾的 `-high` 仍是原始 ID 的一部分；选择档位会另行发送参数，不修改型号 ID。资料缺失时不会凭名称猜测能力。

已知的 Claude Sonnet 5.5、Opus 5.5 提供 `low / medium / high`，与 Antigravity 原生菜单的三个档位一致，新发现的这两款模型默认 `medium`。固定版本桥接器分别发送 1024、8192、24576 的思考预算，均在上游声明的预算范围内。它们仍使用账号目录原有的 `-high` 型号 ID，通过单独参数选择深度。Claude 会自适应决定实际思考输出，简单任务可能不输出思考项，各档位的实际思考 token 不保证按预算比例增加；输出长度上限也可能进一步压低预算。不把这份已知型号映射套用到未知模型，也不提供未经支持的“关闭思考”。

Gemini 网页应用、Antigravity 各模型组与 OpenAI 的额度统计分别计算。这里调用的是 Antigravity 账号后端，不能根据 Gemini 网页应用的百分比判断路由；应结合网关的实际服务商和型号记录检查。网关不会把 Claude/Gemini 请求自动改发到 GPT。

## 自动发现与数据保护

主网关启动时及每 30 分钟检查。新发现或能力变化的型号每轮最多验证两个，通过后加入；已有型号不重复生成。额度/权限错误会统一退避；手工移除的型号不会自动加回。图像输出、资料不足或协议未知的型号会留在待处理列表。Google 权限目录自身可能缓存数小时，因此不保证发布瞬间可用。

只自动下载经过校验的公共模型 JSON，**不自动下载或运行二进制升级**。资料失败保留已验证列表；模型退役需要跨多个成功检查确认。管理页可暂停或立即检查；删除服务商不会自动重建。

OAuth JSON 为明文，安装目录的 Windows ACL 限制为当前用户；主网关中的本地组件密钥另用 DPAPI 加密。请求正文日志、额外生成重试、远程管理、付费 AI credits 自动兜底均关闭。不要上传该安装目录。主网关只在同一账号、模型、聊天和通道内保留实际接收过的工具思考签名；跨模型或被改写的签名不得复用。

## 启停与退出

从 2.5.1 起，组件内的监督进程会在子进程意外退出（包括退出码 0）后按 1、2、4、8、16、30 秒上限退避恢复。主网关启动、每 30 秒以及请求发送前也检查已启用的组件任务；任务被意外终止时恢复原任务。显式停止后不会自动重新启用，缺失任务或被其他程序占用的端口不会强行创建或替换。恢复本机服务不生成回复，也不会重放已经发出的模型请求。

已有安装需要同时升级主网关和组件辅助脚本，保留原 Google 登录与密钥：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\repair-gemini.ps1 `
  -BinaryPath 'D:\Downloads\CLIProxyAPI\cli-proxy-api.exe'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

自定义安装目录时分别传入 `-BridgeDirectory` 与 `-InstallDirectory`。`-BinaryPath` 指向前述兼容构建，修复脚本先核对摘要，再备份旧二进制、安装元信息和完整辅助脚本，并保存任务 XML 快照；失败时回滚原文件与任务。文件备份位于组件的 `private/helpers-before-repair-*`。配置、授权、密钥、模型目录缓存和原任务启用/停用状态均保留；无需运行 `connect-gemini.ps1` 或重新初始化。仅更新辅助脚本时可省略 `-BinaryPath`，此时保留原二进制，原版仍不能启用 Claude。升级会短暂重启已启用的组件，请在当前模型任务结束后运行。可先加 `-WhatIf` 查看目标。

主网关和组件计划任务改由 `wscript.exe` GUI 宿主启动 `task-launcher.vbs`，主网关的 Node 子进程也不创建窗口，避免 Windows 11 默认 Terminal 在 PowerShell 自行隐藏前分配可见窗口。升级只迁移精确匹配本安装的旧任务动作，保留其他 XML 字段及停用状态；监督进程跟随父 WSH 宿主退出，避免遗留孤儿进程。

退出时间、退出码、运行时长及退避秒数记录于组件 `private/lifecycle.jsonl`，轮换后最多两份；不记录上游输出、正文、账号或令牌。管理页将本机连接组件状态与模型目录更新状态分别显示。组件故障返回明确的 503，Google 权限或额度错误仍按上游状态报告。它修复本机组件停止导致的连接拒绝，不保证第三方上游永不故障。

在组件安装目录运行 `start.ps1`、`status.ps1`、`stop.ps1`，自定义端口时传入相同 `-Port`。它由独立的当前用户计划任务运行，停止影响该组件接入的 Gemini 和 Claude。主网关管理页可移除订阅服务商；移除后停用组件任务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Documents\CodexGeminiBridge\stop.ps1" -RemoveTask
```

恢复 GPT 直连会绕过整个主网关。需要重新使用模型时启用主网关和订阅组件。
