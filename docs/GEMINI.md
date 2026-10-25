# 可选 Gemini 组件

## 先选择接入方式

**推荐：使用 Gemini 付费 API。** 通过 Google 提供的 OpenAI 兼容 API 地址，在主网关管理页添加 API 密钥和模型即可；无需安装本组件。订阅套餐与 API 计费不同，购买 Gemini 网页套餐不等于获得通用 API 额度。

**第三方订阅适配：高级、可选、默认关闭。** 本目录的脚本配合 CLIProxyAPI 的 Antigravity OAuth 适配，使用自己的 Google 账号授权；它不读取浏览器 cookie 或密码。Google 的相关条款限制第三方软件复用订阅登录访问这些后端，可能停用服务或账号访问。此方式不受 Google 官方支持，也不保证账号资格或长期可用。请自行阅读 [Antigravity 条款](https://antigravity.google/terms) 和 [Gemini CLI 条款说明](https://geminicli.com/docs/resources/tos-privacy/)。

只有你主动选择并传入 `-AcceptThirdPartyTerms`，脚本才会安装或连接。项目不自带 OAuth 客户端凭据；授权流程由你另行下载的第三方组件实现。不要把这个方式称为官方订阅 API；它使用该账号可用的 Antigravity 服务额度，不把网页聊天次数兑换为 API 余额。

## 安装独立组件

1. 先完成主网关安装。
2. 从 [CLIProxyAPI 8.0.43 官方项目发布页](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.43) 下载 Windows x64 ZIP 并解压，保留 LICENSE。
3. 核对 ZIP SHA-256：`332cc8e0cd7370c841ce96b37cb1ae380136f1e4d7d54a610080ab81b5f6aec2`。安装器还会核对解压后 EXE SHA-256：`1b444cc3c91bd8f33130ec282274b088bbb6b23c6e310dd945d746ee58dbd1a4`。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-gemini.ps1 `
  -BinaryPath 'D:\Downloads\CLIProxyAPI\cli-proxy-api.exe' `
  -LicensePath 'D:\Downloads\CLIProxyAPI\LICENSE' -AcceptThirdPartyTerms

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\connect-gemini.ps1 `
  -AcceptThirdPartyTerms
```

默认目录为 Windows“文档”下 `CodexGeminiBridge`，端口 8317；可通过参数修改，连接时传入相同目录。仅一个 Google 账号。登录会打开 Google 真正的授权页，短期回调器仅监听 `127.0.0.1:51121` 并校验 state；误关页面时，会话有效期内可重新打开 `http://127.0.0.1:51121/login`。成功、取消或超时会关闭回调器。

首次连接会从当前账号目录动态挑选最多两个具备完整资料的文本模型，做两轮模拟工具和签名续调检查；不会执行模拟工具，但会消耗少量订阅额度。通过后注册模型、开启自动发现、重启主网关。更换账号或重复执行安装不会覆盖原注册；请先断开旧服务商并重新核对权限与工具兼容性。

## 自动发现与数据保护

主网关启动时及每 30 分钟检查。新发现或能力变化的型号每轮最多验证两个，通过后加入；已有型号不重复生成。额度/权限错误会统一退避；手工移除的型号不会自动加回。图像输出、资料不足或协议未知的型号会留在待处理列表。Google 权限目录自身可能缓存数小时，因此不保证发布瞬间可用。

只自动下载经过校验的公共模型 JSON，**不自动下载或运行二进制升级**。资料失败保留已验证列表；模型退役需要跨多个成功检查确认。管理页可暂停或立即检查；删除服务商不会自动重建。

OAuth JSON 为明文，安装目录的 Windows ACL 限制为当前用户；主网关中的本地组件密钥另用 DPAPI 加密。请求正文日志、额外生成重试、远程管理、付费 AI credits 自动兜底均关闭。不要上传该安装目录。主网关只在同一账号、模型、聊天和通道内保留实际接收过的 Gemini 工具签名。

## 启停与退出

在组件安装目录运行 `start.ps1`、`status.ps1`、`stop.ps1`，自定义端口时传入相同 `-Port`。它由独立的当前用户计划任务运行，停止仅影响 Gemini。主网关管理页可移除 Gemini 服务商；移除后停用组件任务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Documents\CodexGeminiBridge\stop.ps1" -RemoveTask
```

恢复 GPT 直连会绕过整个主网关。需要重新使用模型时启用主网关和订阅组件。
