# Development

- `gateway/`: local proxy, adapters, provider storage, bounded in-memory history, catalog updaters and Windows lifecycle scripts.
- `bridge/`: optional third-party subscription adapter control, loopback OAuth broker and JSON catalog updater. No binary or account is bundled.
- `install.ps1`: fresh installation or preserving upgrade. Bootstrap preparation is isolated and protected before any backup is written.
- `scripts/`: opt-in component installation and source-release checks.
- `tests/gateway`, `tests/gemini`: synthetic HTTP/WebSocket, provider isolation, cancellation, signature scope, CSRF, catalog failure/backoff and recovery tests.
- `tests/distribution`: first-install/upgrade coverage and publication checks.

Node 24 is required. Run `npm ci --ignore-scripts`, then `npm test`. On Windows, run the PowerShell tests separately; scheduled-task tests use unique temporary roots and ports and clean up only their owned tasks. They do not require provider credentials. Do not run real model validation in CI.

`npm run check:release` scans tracked and unignored files. Keep runtime paths, credentials, logs, binary releases and account-derived model catalogs out of commits. Synthetic test credentials must be clearly marked synthetic. The scan is a safeguard, not a guarantee against every possible secret format; review `git diff --cached` before publishing.

The first public source release is 2.4.0. It derives from the locally validated 2.3 gateway, adds a generic first-install entry point, empty catalog seeds, a portable test layout and opt-in component setup. Version numbers do not imply upstream Codex protocol stability. A component restart is tested; a full OS reboot is not part of the automated suite.
