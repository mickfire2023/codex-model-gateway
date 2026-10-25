# Third-party notices

- **ws 8.22.0** — MIT, [websockets/ws](https://github.com/websockets/ws). Installed through npm with a locked integrity hash. Its license is included in the installed npm package. Optional native extensions are not required.
- **Node.js** — its own license and third-party notices, [nodejs/node](https://github.com/nodejs/node/blob/main/LICENSE). Not committed to this repository. The installer copies the user's existing Node runtime and any adjacent LICENSE / NOTICE files when available.
- **CLIProxyAPI 8.0.43** — MIT, [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.43). Optional external component; neither binary nor OAuth client credentials are included here. Users download the official project release and provide its license to the separate installer, which verifies the pinned Windows x64 archive's extracted binary SHA-256.
- **@playwright/mcp 0.0.83** — Apache-2.0, [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp). Optional Chrome integration installed separately from the official npm registry with a pinned SHA-512 integrity check. Its package and dependencies retain their own licenses; no browser binary or personal Chrome profile is bundled.
- **Model definition data** — GPT catalogs come from the user's authenticated Codex endpoint; DeepSeek metadata comes from its public integration documentation. Optional Antigravity metadata comes from [router-for-me/models](https://github.com/router-for-me/models). These are downloaded at runtime and are not bundled in the source release.

Product and model names belong to their respective owners. This project does not grant access to a provider, extend subscriptions, or override provider terms.
