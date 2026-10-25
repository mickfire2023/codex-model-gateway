# Codex Model Gateway

A local Windows gateway that keeps Codex's existing ChatGPT login and GPT models while adding DeepSeek and other OpenAI-compatible providers to the same model selector. Supports Responses / Chat Completions, streaming HTTP and WebSocket, tool translation, a Chinese management UI, and recovery to the original GPT connection.

Requirements: Windows 10/11, Windows PowerShell 5.1, Node.js 24+, and an existing working native Codex configuration. This is an independent project, not an official OpenAI, DeepSeek or Google integration.

```powershell
npm ci --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Restart Codex and open the model gateway shortcut created on the desktop. Add your provider URL, API key, exact model IDs and capabilities. Saving verifies model-list access; the explicit sample-generation button may incur charges. Remote providers must use HTTPS. Local loopback HTTP providers are supported.

The installer defaults to the Windows Documents folder, copies its Node runtime, validates service health before switching Codex, and installs a per-user scheduled task. It requires no administrator password. Re-running it upgrades an existing installation while preserving credentials and model settings. Custom first-install connection/catalog overrides are rejected rather than silently replaced.

GPT and DeepSeek catalogs refresh every 30 minutes. Other compatible providers are configured manually. Optional Gemini subscription discovery is a separate, disabled-by-default third-party adapter; it is not a public subscription API. Google restricts third-party reuse of subscription OAuth credentials and access may be suspended. Read [Gemini setup](GEMINI.md) before opting in. Using a paid Gemini API via its compatible endpoint does not require this component.

Optional [Chrome integration](CHROME.md) uses the pinned official Microsoft Playwright MCP in an independent Chrome session. Text models use accessibility snapshots and element actions; an explicitly enabled vision connection also returns screenshots. It preserves existing browser plugins, personal profiles, model settings and normal Codex approvals. Browser compatibility checks are separate, account-dependent tests, not part of the credential-free CI suite.

API keys are protected using the current Windows user's DPAPI and filesystem ACLs. Never upload an installed `private` directory, OAuth files, management URL token, model caches or logs. The repository ships empty catalogs and no accounts. The optional OAuth adapter's JSON tokens are plaintext within a restricted folder, not DPAPI-encrypted.

Restore the original GPT connection with the installed `restore.ps1` and restart Codex. If PowerShell is unavailable, use the installed `Emergency-restore-GPT.cmd`. In-memory cross-model conversation history is bounded and lost on gateway restart; some continuations require a new conversation with a summary.

```powershell
npm test
npm run check:release
npm run test:lifecycle
```

See [installation and troubleshooting](INSTALL.md), [development](DEVELOPMENT.md) and [security reporting](../SECURITY.md). MIT license; third-party components retain their own licenses.
