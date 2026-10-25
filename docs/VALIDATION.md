# Release validation — 2.4.1

Validated on Windows with Node.js 24.22.1 and Windows PowerShell 5.1. Test data uses synthetic identities, tokens, model metadata and loopback servers.

| Suite | Result |
| --- | --- |
| Node protocol, routing, storage, catalog, management and distribution checks | 246 passed, 0 failed |
| Fresh installation, preserving upgrade, direct recovery and occupied-port failure | 18 assertions passed |
| Main scheduled lifecycle, independent process lifetime, recovery, re-enable and failed deployment rollback | 91 assertions passed |
| Optional bridge lifecycle, readiness, own-task cleanup and child process cleanup | 39 assertions passed |
| PowerShell source parsing | Passed |
| Tracked/unignored source release audit | Passed |

The first-install test uses a separate configuration file, account cache, install directory and ephemeral port. It verifies that the default model, unrelated plugin settings and synthetic auth file are preserved, that an upgrade retains its existing token and private state, and that an occupied-port failure does not alter the connection. Cleanup failures fail the test rather than silently leaving tasks behind.

The main lifecycle test exercises a deliberately unhealthy stable deployment after staging succeeds, then checks rollback and removal of only the test-owned task. It also verifies that independently scheduled control and gateway processes survive the initiating process exit.

The 2.4.1 protocol regressions exercise Codex's no-generation prewarm followed by a real continuation, WebSocket status/retry errors, HTTP rejection before SSE headers, safe midstream failure events, provider-neutral catalog instructions and exact legacy-template migration. The bridge lifecycle test also verifies that checking the wrong port cannot hide an owned process or make failed startup cleanup finish early.

Private integration checks used the installed native Codex client with its complete 253-tool request, without removing tools or truncating user instructions. All five installed Gemini models completed a synthetic text conversation. Gemini also completed a shell tool read of a synthetic marker file and a subsequent answer. These account-dependent checks are separate from the public test suite, contain no published credentials or conversation bodies, and do not guarantee future provider quota or availability.

The first clean English Windows runner exposed a console-encoding failure: WSH could not write a Unicode path to its redirected legacy-code-page error stream, so a missing launcher reported exit code zero. The issue was reproduced locally using a supplementary Unicode character in the synthetic installation path. Console diagnostics now escape non-ASCII characters while message boxes retain Unicode; reporting failures cannot bypass the explicit error exit. The regression covers all three external launchers and the installed shared launcher.

No provider credentials are needed for the published test suite; it does not generate paid model responses. Actual provider availability depends on the user's account. These checks cover component lifecycle; a complete Windows reboot and every Codex distribution are not covered by this release's automated checks. GitHub Actions reruns the public source suite on a clean Windows runner.
