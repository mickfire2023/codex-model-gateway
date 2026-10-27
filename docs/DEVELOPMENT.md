# Development

- `gateway/`: local proxy, adapters, provider storage, bounded in-memory history, catalog updaters and Windows lifecycle scripts.
- `bridge/`: optional third-party subscription adapter control, loopback OAuth broker and JSON catalog updater. No binary or account is bundled.
- `install.ps1`: fresh installation or preserving upgrade. Bootstrap preparation is isolated and protected before any backup is written.
- `scripts/`: opt-in component installation and source-release checks.
- `vendor-patches/`: minimal upstream compatibility patch and build instructions; `scripts/build-antigravity-bridge.ps1` builds the separate Windows x64 release asset.
- `tests/gateway`, `tests/gemini`: synthetic HTTP/WebSocket, provider isolation, cancellation, signature scope, CSRF, catalog failure/backoff and recovery tests.
- `tests/distribution`: first-install/upgrade coverage and publication checks.

Node 24 is required. Run `npm ci --ignore-scripts`, then `npm test`. On Windows, run the PowerShell tests separately; scheduled-task tests use unique temporary roots and ports and clean up only their owned tasks. They do not require provider credentials. Do not run real model validation in CI.

`npm run check:release` scans tracked and unignored files. Keep runtime paths, credentials, logs, binary releases and account-derived model catalogs out of commits. Synthetic test credentials must be clearly marked synthetic. The scan is a safeguard, not a guarantee against every possible secret format; review `git diff --cached` before publishing.

The optional Claude build is CLIProxyAPI `8.0.43-gateway.1`, based on upstream 8.0.43 commit `307803510bce87f986fcf7b1a84190f105c7b4aa`. [The binary manifest](../bridge/binary-manifest.json) pins the official Go 1.27.3 archive SHA-256, source archive, patch and resulting executable SHA-256. [The build script](../scripts/build-antigravity-bridge.ps1) uses a fresh isolated directory, checks the input hashes, applies the patch, runs upstream signature tests and checks the compiled output hash. Source, patch and build instructions are committed; the executable is supplied only as a release asset with the upstream MIT license.

Upstream 8.0.43 and 8.0.44 drop observed Claude 5.5 channel-19 signed thinking. The reviewed patch accepts channels 18 and 19 while retaining other envelope checks and rejecting unknown channel 20; it does not rewrite signature bytes. A tool-only success with no thinking items cannot validate signed replay. Synthetic wire tests check exact bytes and scope isolation; account-bound integration results are recorded separately in [validation](VALIDATION.md). Claude discovery and routing verify the actual installed executable hash, rather than trusting installation metadata. The pinned upstream binary remains usable for Gemini.

Windows scheduled tasks use GUI-hosted `task-launcher.vbs` files in `gateway/` and `bridge/`; the main Node child uses `CreateNoWindow`. This avoids a visible window allocated by the Windows 11 default Terminal before PowerShell can hide itself. Launcher migration requires an exact owned legacy action, preserves other task XML fields and disabled state, and supports rollback. Runners supervise the parent WSH host so ending a task does not leave its children orphaned. These lifecycle changes do not establish a cause or fix for OS crashes or Codex startup exits.

The first public source release is 2.4.0. It derives from the locally validated 2.3 gateway, adds a generic first-install entry point, empty catalog seeds, a portable test layout and opt-in component setup. Version numbers do not imply upstream Codex protocol stability. A component restart is tested; a full OS reboot is not part of the automated suite.
