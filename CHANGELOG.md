# Changelog

## 2.6.0

- Discover account-listed Antigravity Claude text models alongside Gemini, requiring complete public/account metadata and a real two-turn tool compatibility check before registration. Preserve existing provider IDs, model IDs, credentials and manual exclusions.
- Advertise Gemini reasoning levels from the provider's declared model definitions and forward the selected/default level. Expose low/medium/high for the known Claude Sonnet 5.5 and Opus 5.5 models, matching the native Antigravity menu and validated bridge budgets; new discoveries of these two models default to medium. Actual thinking output remains adaptive and need not scale proportionally with the budget.
- Preserve signed Claude reasoning through Codex tool continuations with account/model/session provenance checks. Accept a Claude tool continuation without a reasoning carrier only when the response contains no reasoning items; unsigned or malformed thinking still fails validation.
- Add the reviewed CLIProxyAPI `8.0.43-gateway.1` compatibility build: accept Claude thinking channels 18 and 19, reject unknown channel 20, and preserve signature bytes exactly. Upstream 8.0.43 and 8.0.44 discard real Claude 5.5 channel-19 thinking; tool-only checks cannot establish signed continuation support. Pin source, patch, Go toolchain and executable hashes in the binary manifest; distribute the executable and upstream MIT license as a separate 2.6.0 release asset.
- Keep Gemini available with the pinned upstream binary, but leave Claude discoveries pending and reject already registered Claude routes with an upgrade-required 503 until the actual installed binary hash verifies support. Existing users can supply `repair-gemini.ps1 -BinaryPath` to replace the binary with backups and rollback, preserving account authorization, configuration, keys and disabled state; no new OAuth or initialization is needed.
- Show the existing default subscription provider as Antigravity without overwriting its saved name or user-defined names. Use GUI-hosted scheduled-task launchers and a windowless Node child to avoid Windows Terminal windows on Windows 11. Migrate only exactly owned legacy task actions, preserving other task XML fields and enabled/disabled state, with rollback and parent-host supervision.

## 2.5.1

- Recover an enabled Gemini service at gateway startup, every 30 seconds, and before dispatch when its local listener disappears. Concurrent callers share one recovery; requests already dispatched are never replayed by this mechanism.
- Supervise Gemini child exits, including exit 0, with capped backoff and private, bounded lifecycle metadata. Preserve explicit stop, account/configuration, exact process ownership and loopback restrictions.
- Return component-specific 503 errors and show the local Gemini service state separately from catalog freshness. Add an existing-installation supervisor repair script.
- Add fixture tests for child exits, parent interruption, disabled/missing tasks, occupied ports, cancellation, recovery serialization and no duplicate generation.

## 2.5.0

- Add optional isolated Chrome connections through the pinned official Microsoft Playwright MCP: text-only accessibility tools by default, plus a separately enabled screenshot-capable connection. Preserve existing models, authentication, plugins and normal approval settings.
- Fix DeepSeek MCP tool discovery by advertising direct tool exposure instead of unsupported client-side `tool_search`. Preserve upstream source metadata and GPT capabilities, including after catalog refresh.
- Fix Chat Completions screenshot tool results: retain textual tool messages and call IDs, then attach image observations after the complete tool-result batch in standard user multimodal messages.
- Add reproducible, explicitly enabled native-client Chrome validation with exact-origin synthetic-page guards, real page-event checks and screenshot-only random visual challenges. Public CI remains credential-free and does not run model/browser integration checks.
- Validate all 14 installed selectable model IDs through isolated Chrome: 13 completed DOM and visual checks; the text-only model completed DOM and screenshot capture without receiving image data.

## 2.4.1

- Fix Gemini failures with the real Codex client: use provider-neutral custom-model instructions instead of inheriting DeepSeek instructions. Migrate only exact legacy instruction matches for the Gemini subscription adapter; retain user/developer instructions and the full tool list.
- Complete `generate:false` WebSocket prewarming locally without generating or spending provider quota, and preserve continuation settings for the next real request.
- Return protocol-compatible WebSocket error status and bounded Retry-After metadata. Keep HTTP errors before streaming as HTTP errors; terminate interrupted streams with `response.failed` instead of leaving Codex waiting for idle timeout.
- Identify Gemini model cooldowns without exposing raw provider error bodies; include provider/model in redacted error diagnostics.
- Require the optional bridge's owned process to exit even when status was checked against a different port.
- Add native-client protocol regressions and validate all five installed Gemini models, including real tool-result continuation. Public automated tests use synthetic providers and credentials.

## 2.4.0

First general-purpose source release.

- Add a first-install entry point with explicit directory/port settings, protected local bootstrap, health-before-activation and preserving upgrade.
- Keep original ChatGPT login and native GPT models while adding independent compatible API providers.
- Preserve installed account catalogs when upgrading from empty source-release seeds.
- Keep provider credentials, personal model caches, runtime binaries and diagnostic artifacts out of source releases.
- Discover initial optional Gemini models from the account catalog rather than a fixed personal model list; require explicit opt-in to the third-party subscription adapter.
- Include Chinese/English setup guidance, recovery and security documentation, locked dependencies and Windows CI.
- Include synthetic protocol, signature isolation, management, discovery, first-install and scheduled lifecycle checks.
- Preserve failure exit codes when a VBS diagnostic contains a path that cannot be represented by the Windows console code page; retain Unicode in graphical messages.
