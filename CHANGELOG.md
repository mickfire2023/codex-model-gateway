# Changelog

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
