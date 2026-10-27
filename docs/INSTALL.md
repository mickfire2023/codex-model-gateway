# 安装、升级与恢复

## 安装条件

Windows 10/11，当前用户能运行任务计划程序，系统 Windows PowerShell 5.1 可用，Node.js 24+ 已加入 PATH。企业策略可能禁止本地任务或脚本；请由设备管理员提供允许的运行方式。首次安装面向使用原生 OpenAI 服务商、没有额外 `openai_base_url` / `model_catalog_json` 覆盖的 Codex。

从可信的 Node.js 官方网站安装运行时，然后在源码目录执行 `npm ci --ignore-scripts`。该步骤只安装锁定的 `ws` 依赖。安装器复制当前 Node 运行时和依赖，不在安装过程中下载执行未知程序。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

自定义示例：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -InstallDirectory "$env:USERPROFILE\Documents\CodexModelGateway" `
  -ConfigPath "$env:USERPROFILE\.codex\config.toml" -Port 2156
```

自定义路径优先使用明确的物理磁盘目录。商店版应用的 AppData 文件系统重定向可能让应用内外看到不同文件；安装器会核对真实路径。源码根目录的几个兼容启动器仅查找默认 Documents 路径；自定义位置应使用安装时生成的桌面快捷方式或安装目录内的脚本。

默认读取 `CODEX_HOME/config.toml`，没有设置时使用用户目录 `.codex/config.toml`。安装后保存该配置目录，后台更新不会依赖调用者的临时环境变量。不会修改 `auth.json`、默认模型或其他服务商定义。

## 升级

下载新源码，执行 `npm ci --ignore-scripts`，再以相同 `-InstallDirectory` 运行安装器。它使用原有加密凭据和配置，先在暂存目录测试健康，再切换服务；失败时尝试恢复原文件和连接。保留上次可用的账号模型缓存，不使用发布包的空种子覆盖已有列表。

不要直接把自己的 `private`、`runtime`、模型缓存或日志复制回源码仓库。更新源码也不会更新可选的 CLIProxyAPI 二进制。

使用可选 Antigravity Claude 的已有安装，还需下载 2.6.0 的 `8.0.43-gateway.1` 兼容构建，并执行 `scripts/repair-gemini.ps1 -BinaryPath <解压后的EXE路径>`；完整命令与摘要见 [组件升级说明](GEMINI.md#启停与退出)。它保留现有授权、配置、密钥和停用状态，并为二进制、辅助脚本、安装元信息和任务恢复保留备份或快照；无需重新 OAuth、连接或初始化。原版 8.0.43 可继续使用 Gemini，Claude 路由则要求升级。

## 日常管理

在安装目录运行以下脚本，省略 `-Directory` 时使用脚本所在目录，支持中文、空格路径以及从其他工作目录调用：

```powershell
.\start.ps1
.\Open-dashboard.ps1
.\restart.ps1
.\restore.ps1
.\enable.ps1
```

需要完全独立运行时，使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "安装目录\脚本.ps1"`。常规情况下 Windows 登录时任务会自动启动服务；退出 Codex 不会终止它。

2.6.0 使用 `wscript.exe` 承载主网关和组件的后台任务，并让主网关 Node 子进程不创建窗口，避免 Windows 11 默认 Terminal 在 PowerShell 隐藏自身前弹出窗口。升级只迁移精确属于本安装的旧任务动作，保留其他任务 XML 字段和启用/停用状态；失败时恢复原任务。

## 排错

| 现象 | 处理 |
| --- | --- |
| 管理网页拒绝连接 | 从安装目录运行 `start.ps1`；确认端口未被其他程序占用，再运行 `Open-dashboard.ps1` |
| 管理页提示 access denied | 使用桌面入口重新打开包含本机令牌的地址，不手输 `/settings/key` |
| GPT 连接失败 | 先运行 `restore.ps1` 并重启 Codex，确认原生登录有效，再重新启用网关 |
| 没有新模型 | 检查管理页的目录状态、账号权限、客户端版本和待支持原因；兼容性未确认的型号不会自动加入 |
| Claude 提示组件需升级或返回相应 503 | 按组件文档提供兼容构建运行 `repair-gemini.ps1 -BinaryPath`，再升级主网关；不需要重新登录 |
| 其他服务商保存失败 | 核对基础地址与 `GET /models` 支持；远程必须 HTTPS，禁止通过重定向转交密钥 |
| 续聊提示历史缺失 | 网关内存历史可能已过期或重启，带摘要开启新聊天 |

`gateway.log` 仅包含运行元信息，仍应检查后再分享。不要上传完整 `private`、Google OAuth JSON 或截图中的管理令牌。

本次修复覆盖后台窗口、组件生命周期和模型协议兼容。它不代表已解决 Windows 蓝屏，也不能据此定位 Codex 首次启动退出的原因；本机服务健康通过仍需与下一次 Codex 冷启动结果分别核验。

## 恢复与卸载

1. 先运行安装目录 `restore.ps1`，健康结果失败也应检查提示；重启 Codex 并确认 GPT 可直连。
2. 如安装过 Gemini 订阅组件，运行其 `stop.ps1 -RemoveTask` 关闭并移除该组件自己的任务。
3. 在 Windows 任务计划程序中检查本工具带安装路径标识的任务已停用。确认不再需要本地模型设置、恢复备份及加密凭据后，再自行移除安装目录与桌面快捷方式。

不提供自动清空用户数据的卸载器。DPAPI 凭据与当前 Windows 用户绑定，不应当作跨电脑备份格式。
