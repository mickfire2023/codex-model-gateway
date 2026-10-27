# Antigravity Claude channel 19 compatibility build

`cliproxyapi-8.0.43-q19.patch` applies to the exact upstream CLIProxyAPI 8.0.43 source pinned in [the binary manifest](../bridge/binary-manifest.json). It permits observed thinking channel 19 alongside channel 18, retaining the existing envelope-version, infrastructure, block-kind and signature-container checks. Unknown channel 20 remains rejected. The patch includes synthetic regression envelopes and does not contain captured account signatures.

The resulting `8.0.43-gateway.1` executable is a project compatibility build, not an upstream release. CLIProxyAPI remains MIT licensed; include its original `LICENSE` when distributing the executable. The repository contains source and build instructions, not OAuth credentials or an executable.

To reproduce the Windows x64 build, install Git and run Windows PowerShell 5.1 or later:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-antigravity-bridge.ps1
```

The script creates a new isolated directory, downloads an official Go ZIP and pinned upstream source archive, verifies their SHA-256 hashes, checks and applies this patch, runs the upstream signature tests and compiles with limited parallelism. It does not install Go system-wide, change PATH, read account data or modify a running bridge. It verifies the output against the manifest before returning the executable and upstream license. Optional `-BuildDirectory`, `-SourceArchivePath` and `-GoArchivePath` parameters select a fresh destination or reuse already downloaded, hash-verified archives. `-WhatIf` previews the build destination without downloading or executing anything.

The original upstream executable remains supported for Gemini. Claude channel 19 requires the compatibility build; retaining an unchanged signature on a local wire fixture is verified separately from a real, account-bound continuation.
