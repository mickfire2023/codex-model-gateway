# Release validation — 2.5.0

Validated on Windows with Node.js 24.22.1 and Windows PowerShell 5.1. Test data uses synthetic identities, tokens, model metadata and loopback servers.

| Suite | Result |
| --- | --- |
| Node protocol, routing, storage, catalog, management and distribution checks | 258 passed, 0 failed |
| Fresh installation, preserving upgrade, direct recovery and occupied-port failure | 18 assertions passed |
| Main scheduled lifecycle, independent process lifetime, recovery, re-enable and failed deployment rollback | Passed; polling-dependent assertion count |
| Optional bridge lifecycle, readiness, own-task cleanup and child process cleanup | 39 assertions passed |
| Optional Chrome installer: configuration preservation, metadata integrity, conflict/refusal, failure and preview checks | 62 assertions passed |
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
