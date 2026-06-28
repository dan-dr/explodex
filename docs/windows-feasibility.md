# Windows desktop feasibility spike

Status: feasibility notes only. **Windows support is not claimed or live-verified.** Linux is deferred because no official Linux desktop app is currently advertised.

## Platform-adapter mapping

The CLI routes installed-mode operations through a platform adapter. macOS is complete in `lib/platform/macos.mjs`; a Windows adapter would need live validation for every item below.

| Concern | Candidate Windows implementation | Verification required |
|---|---|---|
| Codex install path | Discover per-user or machine install from known app paths/uninstall registry rather than hard-code | Installer variants and Store/non-Store installs |
| Process detection | PowerShell/CIM `Win32_Process` or Node process API seam; match executable path and command line | Permission behavior and process tree |
| Debug flag | Start Codex executable with `--remote-debugging-port=9333` | Confirm Electron forwards the flag |
| Profile continuity | Do not set Electron user-data override in installed mode | Existing login, settings, projects persist |
| Port ownership | TCP owner PID via PowerShell/Get-NetTCPConnection, then resolve executable path | Foreign-owner and access-denied cases |
| Updater | Launch the currently installed executable; do not patch update resources | Behavior across auto-update restart |
| Shortcut | Per-user Start Menu/Desktop `.lnk` generated through PowerShell COM; optional elevated all-users shortcut | Repair and ownership marker semantics |
| Splash | PowerShell/WPF or a small local script-host UI; no distributed native launcher binary | Startup latency, focus, cancellation, accessibility |
| Injection | Reuse Node CDP injector and npm-packaged SDK/plugins | WebSocket/CDP behavior in production app |
| Logs | `%LOCALAPPDATA%\\Explodex\\logs` | Actionable errors and privacy |

## Open questions

1. Canonical Codex executable and updater paths across installer channels.
2. Whether a second launch hands off to an existing process before Chromium consumes the debug flag.
3. Reliable, non-admin process command-line inspection.
4. Shortcut ownership metadata and safe conflict behavior.
5. Normal-profile location and any updater-managed environment variables.

Do not add `win32` to `package.json#os` or advertise Windows until stopped/debug/plain/foreign-port branches, injection, plugin registration, update behavior, and profile continuity are live-tested on Windows.
