# Release validation — 2.4.0

Validated on Windows with Node.js 24.22.1 and Windows PowerShell 5.1. Test data uses synthetic identities, tokens, model metadata and loopback servers.

| Suite | Result |
| --- | --- |
| Node protocol, routing, storage, catalog, management and distribution checks | 236 passed, 0 failed |
| Fresh installation, preserving upgrade, direct recovery and occupied-port failure | 18 assertions passed |
| Main scheduled lifecycle, independent process lifetime, recovery, re-enable and failed deployment rollback | 91 assertions passed |
| Optional bridge lifecycle, readiness, own-task cleanup and child process cleanup | 38 assertions passed |
| PowerShell source parsing | Passed |
| Tracked/unignored source release audit | Passed |

The first-install test uses a separate configuration file, account cache, install directory and ephemeral port. It verifies that the default model, unrelated plugin settings and synthetic auth file are preserved, that an upgrade retains its existing token and private state, and that an occupied-port failure does not alter the connection. Cleanup failures fail the test rather than silently leaving tasks behind.

The main lifecycle test exercises a deliberately unhealthy stable deployment after staging succeeds, then checks rollback and removal of only the test-owned task. It also verifies that independently scheduled control and gateway processes survive the initiating process exit.

No provider credentials are needed for the published test suite; it does not generate paid model responses. Actual provider availability depends on the user's account. These checks cover component lifecycle; a complete Windows reboot and every Codex distribution are not covered by this release's automated checks. GitHub Actions reruns the public source suite on a clean Windows runner.
