# Release validation

## 2.5.0 automated checks

Validated on Windows with Node.js 24.22.1 and Windows PowerShell 5.1. Test data uses synthetic identities, tokens, model metadata and loopback servers.

| Suite | Result |
| --- | --- |
| Node protocol, routing, storage, catalog, management and distribution checks | 258 passed, 0 failed |
| Fresh installation, preserving upgrade, direct recovery and occupied-port failure | 18 assertions passed |
| Main scheduled lifecycle, independent process lifetime, recovery, re-enable and failed deployment rollback | Passed; polling-dependent assertion count |
| Optional bridge lifecycle, readiness, own-task cleanup and child process cleanup | 39 assertions passed |
| Optional Chrome installer: configuration preservation, metadata integrity, conflict/refusal, failure and preview checks | 71 assertions passed |
| PowerShell source parsing | Passed |
| Tracked/unignored source release audit | Passed |

The first-install test uses a separate configuration file, account cache, install directory and ephemeral port. It verifies that the default model, unrelated plugin settings and synthetic auth file are preserved, that an upgrade retains its existing token and private state, and that an occupied-port failure does not alter the connection. Cleanup failures fail the test rather than silently leaving tasks behind.

The main lifecycle test exercises a deliberately unhealthy stable deployment after staging succeeds, then checks rollback and removal of only the test-owned task. It also verifies that independently scheduled control and gateway processes survive the initiating process exit.

The 2.5.0 checks add direct MCP tool exposure for DeepSeek after catalog refresh, standards-compatible Chat screenshot observations after complete tool-result batches, exact-origin browser test guards, and fail-closed opt-in browser validation. Chrome installer fixtures use synthetic local executables and metadata; they do not download dependencies or start a browser.

## Native Chrome integration

Separate private checks on 2026-10-26 (Japan time) used the installed native Codex client, the real installed Google Chrome and official Microsoft Playwright MCP 0.0.83. Each test used an independent browser state and a local synthetic page. Page events verified navigation, exactly one click, typed receipt and result readback. For vision models, the screenshot tool had to return an image and the model had to read a random canvas-only code and submit it successfully; accessibility text did not contain that code. The text-only mode saved a screenshot without returning image bytes.

| Installed selectable model IDs | DOM actions | Screenshot capture | Screenshot visual challenge |
| --- | --- | --- | --- |
| gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna | 7/7 passed | 7/7 passed | 7/7 passed |
| deepseek-flash | Passed after tool-discovery fix | Passed | Passed |
| deepseek-v4-pro | Passed | Passed, image response omitted | Not tested: configured text-only |
| gemini-4-argon-high, gemini-3.8-flash-high, gemini-3-flash, gemini-3.1-flash-lite, gemini-3.5-flash-lite | 5/5 passed | 5/5 passed | 5/5 passed |

Gemini IDs above are the account-provided IDs under the optional `custom/gemini-subscription/` provider, not bundled model availability promises. Two hidden internal catalog entries were excluded. The Argon run initially exceeded a 120-second whole-task limit after completing page and visual actions; a fresh run with a 240-second limit completed in 79 seconds. No model action was treated as passed merely because it returned HTTP 200 or claimed success.

The Flash failure was reproduced with missing Chrome tools in the actual upstream request. Changing its client tool-discovery metadata made all seven test tools appear and the complete workflow succeeded. Private staging forced a fresh model catalog to avoid a cached old capability flag. Published catalog merging now applies the correction on every refresh while preserving the upstream source cache and GPT flags.

These checks establish the isolated Chrome MCP path. They do not certify every function of the original desktop browser extension, every website, login or future model version. Reproduce them with the opt-in runner in `scripts/browser-validation/`; configure the optional runtime as described in [Chrome setup](CHROME.md). Real-model checks are not run by public CI and can consume provider quota.

## Earlier compatibility checks

The 2.4.1 protocol regressions exercise Codex's no-generation prewarm followed by a real continuation, WebSocket status/retry errors, HTTP rejection before SSE headers, safe midstream failure events, provider-neutral catalog instructions and exact legacy-template migration. The bridge lifecycle test also verifies that checking the wrong port cannot hide an owned process or make failed startup cleanup finish early.

Private integration checks used the installed native Codex client with its complete 253-tool request, without removing tools or truncating user instructions. All five installed Gemini models completed a synthetic text conversation. Gemini also completed a shell tool read of a synthetic marker file and a subsequent answer. These account-dependent checks are separate from the public test suite, contain no published credentials or conversation bodies, and do not guarantee future provider quota or availability.

The first clean English Windows runner exposed a console-encoding failure: WSH could not write a Unicode path to its redirected legacy-code-page error stream, so a missing launcher reported exit code zero. The issue was reproduced locally using a supplementary Unicode character in the synthetic installation path. Console diagnostics now escape non-ASCII characters while message boxes retain Unicode; reporting failures cannot bypass the explicit error exit. The regression covers all three external launchers and the installed shared launcher.

No provider credentials are needed for the published test suite; it does not generate paid model responses. Actual provider availability depends on the user's account. These checks cover component lifecycle; a complete Windows reboot and every Codex distribution are not covered by this release's automated checks. GitHub Actions reruns the public source suite on a clean Windows runner.

## 2.5.1 Gemini 服务恢复

Node 自动检查 273 项通过；Windows PowerShell 5.1 的 Gemini 生命周期与修复检查 84 项通过；首次安装与保留配置升级检查 18 项通过。

部署后使用原生 Codex 客户端，通过实际主网关调用 Gemini 3.8 Flash，约 6.6 秒正常完成，无 502；保留原有 14 个可选模型。故障注入在独立的本机模拟组件上完成，未强制打断正在处理的生产请求。本轮没有进行 GPT 模型生成测试，也未执行整机重启测试。

新增故障用例覆盖：子进程退出 0、异常退出、强制终止、连续失败退避、端口被其他程序占用、监督任务意外终止后的恢复、用户主动停用、启动任务缺失、并发恢复、请求取消和凭据/配置保留。恢复前失败不得发送生成请求；已尝试发送的请求不得由网关重放。协议预热不调用服务恢复或模型生成。

旧版本只验证了计划内启停，未覆盖这些故障情形。现在将本机组件运行状态与模型目录状态分开报告，端口连接拒绝不再笼统标为外部网络故障。真实 Google 上游权限、限流与网络故障仍可能独立发生。

## 2.6.0 Antigravity Claude 与思考档位

2026-10-27（日本时间），当前账号提供的 `claude-sonnet-5-5-high`、`claude-opus-5-5-high` 均通过真实两轮模拟工具续调。随后在隔离网关中使用实际 Codex 客户端，两者分别执行 `Get-Content` 读取合成标记文件并返回正确结果，约 5.3 秒和 6.6 秒完成；每型号两次生成，发送完整的该测试客户端 15 个工具定义，通过 WebSocket 接入网关并转为上游 SSE。测试使用 `high` 和 65536 输出上限，没有发送 GPT 或 DeepSeek 生成请求。

这些简单工具任务均未输出思考项，符合 Claude 自适应输出的合法形态；它们验证工具调用与结果续调，不能证明真实带签名的思考续调。后续发现官方 CLIProxyAPI 8.0.43 和 8.0.44 会丢弃实际 Claude 5.5 channel 19（Q19）的带签名思考，因此仅增加型号或通过工具测试不足以支持完整 Claude 协议。

两个新增 Claude 型号也通过独立 Chrome 实测：读取合成页面 token、恰好点击一次 Advance、输入 Receipt 并通过页面校验、获得截图图像、识别只画在 canvas 上的随机合成代码并通过校验。Sonnet 约 25.9 秒完成（8 次生成），Opus 约 30.9 秒完成（11 次生成）；共 19 次 Antigravity 请求均为 HTTP 200，没有 GPT 或 DeepSeek 请求，也没有安全检查拒绝或协议错误。本次使用独立浏览器状态，不读取用户原有登录或标签页。

固定 SHA-256 的 CLIProxyAPI 8.0.43 离线测试使用独立配置、合成凭据和本机模拟上游，捕获真实桥接器发出的参数：Gemini 3.8 Flash 的 low/high、Flash Lite 的 minimal/high、两款 Claude 的 1024/8192/24576 预算，以及输出上限引起的预算裁剪。所有外部请求被阻止；这些测试不访问账号，也不生成真实模型回复。

本机 Antigravity 原生菜单也显示 Claude Opus 5.5 的 Low/Medium/High 三档，Sonnet 5.5 同样具有深度子菜单。结合原生菜单、上游声明的有效预算范围与真实桥接器参数捕获，这两个已知型号提供 low/medium/high（1024/8192/24576）并默认 medium。证据证明可选档位和参数转换；Claude 的实际思考输出是自适应的，不能用简单任务的 reasoning token 为零推断档位无效，也不能保证输出 token 按预算比例增加。Gemini 选项来自其上游明确声明的 thinking levels。

2026-10-28（日本时间），隔离的真实 Sonnet 5.5 检查使用兼容构建：首轮 `low` 约 4.856 秒返回实际 Q19 带签名思考及正确的代码推导结果，续轮 `medium` 约 1.929 秒成功完成。签名成功解包、原始签名字节一致、账号/模型/聊天来源范围一致、续调合成标记正确四项均通过；没有 GPT 或 DeepSeek 请求。该结果补足此前工具任务未覆盖的真实带签名续调证据，不公开签名或账号数据。

同日，Opus 5.5 的 `low / medium / high` 三档分别通过独立真实快速调用，各档均返回 HTTP 200 和正确结果。Sonnet 的 `high` 已由前述原生客户端工具检查覆盖；Sonnet 的 `low → medium` 由带签名续调覆盖。这些结果不等同于 Sonnet 三档独立快速调用均已通过。原始 `-high` 型号 ID 在全部档位中保留，未知模型不套用这两个已知型号的预算映射。

`8.0.43-gateway.1` 的受审最小补丁支持 channel 18、19，继续拒绝未知 channel 20，并精确保留签名字节。补丁、Go 1.27.3 官方下载摘要、8.0.43 源码提交与摘要、补丁摘要和最终 EXE 摘要记录在 [构建清单](../bridge/binary-manifest.json)，构建步骤见 [vendor-patches](../vendor-patches/README.md)。原版二进制仍可用于 Gemini；Claude 发现与已注册路由均须通过实际已安装 EXE 摘要检查。

窗口启动器更新前，Windows PowerShell 5.1 的组件生命周期与升级检查 133 项通过，覆盖当时完整 11 个辅助脚本更新、原二进制/配置/合成授权/目录缓存/任务定义和启用/停用状态保留，以及故意让新监督脚本无法启动后的回滚。该历史计数不代表后续二进制升级和启动器变更已完成全套验证。故障只注入独立模拟组件，生产组件未被强制中断。

2026-10-28 的独立固定 3 秒 WScript 启动检查退出码为 0，合成标记正确，未出现新的 Terminal 窗口。主网关与组件新增 GUI 宿主启动器，并对旧任务动作迁移、原 XML 字段/Disabled 保留、回滚和父 WSH 退出后的子进程清理增加检查；这些新增自动检查的完整发布结果另行记录。本次不声称已解决 Windows 蓝屏或定位 Codex 首次启动退出；完整系统重启和下一次 Codex 冷启动仍需单独核验。

发布前本机 Node 完整检查 313 项：311 项通过，2 项可选真实二进制离线检查另行执行并通过；不使用真实账号的参数捕获与签名捕获均通过。公开构建脚本在两个独立目录完成 Go 签名回归与完整构建，EXE 字节一致，SHA-256 与清单一致。

Windows 检查另通过：主网关生命周期 104 项、计划任务部署/控制 105 项、任务注册与迁移 47 项、组件生命周期 145 项、父来源定向检查 12 项、二进制升级及完整回滚 20 项、首次安装/保留配置升级 18 项。模拟进程和目录均独立，未通过强制中断生产任务测试失败恢复。

实际安装更新后，通过主网关运行原生 Codex 的 Claude Sonnet 5.5 工具读取与续答，约 6.2 秒完成且无错误。原有模型保留，安装二进制摘要匹配兼容构建，保存的密钥与 Codex 配置未改变，订阅账号身份一致；OAuth 访问令牌按正常流程刷新。两个服务改为无窗口任务，先前的 Terminal 进程已退出。
