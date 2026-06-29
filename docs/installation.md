# Installation and launcher behavior

## Install

```sh
# pnpm
pnpm add -g explodex

# bun
bun install -g explodex

# npm
npm install -g explodex

# yarn
yarn global add explodex

explodex
```

Bun is the runtime used by the project. Node.js 22+ should also be compatible.

The package-manager command installs Explodex globally. Running `explodex` then opens the launcher app (creating it the first time, with confirmation), offers the plugin creator skill on the first interactive run, and checks the cached npm registry version notification.

On a terminal (TTY), `explodex` uses an interactive flow ([`@clack/prompts`](https://github.com/bombshell-dev/clack)):

- **Codex already running with Explodex** (the debug port is owned by Codex) → it does nothing and says so. No reopen, no re-inject, no launcher changes.
- **Launcher app exists** → it is opened as-is. The bare command never rewrites the launcher; run `explodex install` to reinstall it (e.g. after an upgrade).
- **Launcher app missing** → explodex asks whether to create it. The app's absence — not `~/.explodex` — drives this prompt, because the app may be missing simply because the user declined before. The first time explodex runs (detected by a missing `~/.explodex`) it also prints a short explanation, and it warns if Codex is not installed at `/Applications/Codex.app`.
  - **Confirm** → create `~/Applications/Explodex.app` and open it.
  - **Decline** → do **not** create the app, but still do what the app would do this once: start Codex with remote debugging and inject the SDK + plugins directly via the CLI. The hint suggests `explodex install` to add the launcher app later.
- Pass `-y`/`--yes` to skip the prompt and create the app. When output is not a TTY (pipes, CI, logs) the prompt is skipped, a missing launcher is created, an existing one is opened as-is, and plain status lines are printed.
- On the first interactive run, Explodex checks for `explodex-plugin-builder` and offers **Install plugin creator skill (Recommended)**. Accepting runs `npx skills add dan-dr/explodex`. `--yes` accepts this recommendation; non-interactive runs without `--yes` do not start a network install.

The interactive launch is only for the bare `explodex` command; the launcher app itself invokes `explodex --launch`, which stays non-interactive and runs the full launch state machine below. `--from-app` remains a deprecated alias for the same behavior. `install`/`uninstall` are aliases for `install-launcher`/`uninstall-launcher`.

The launcher is generated locally from plist, icon, zsh, and JXA/AppKit assets. Explodex does not distribute a native launcher executable, sign the generated launcher, clear quarantine attributes, re-sign Codex, or change Codex's bundle ID.

## Commands

| Command | Behavior |
|---|---|
| `explodex` | Open the user launcher; on first run, offer to create it |
| `explodex --yes` | Same, but skip the first-run confirmation prompt |
| `explodex install-launcher` | Install (or reinstall) the user launcher |
| `explodex install-launcher --system` | Install `/Applications/Explodex.app`; macOS requests authorization |
| `explodex install-launcher --force` | Reinstall only when the target has an Explodex ownership marker |
| `explodex uninstall-launcher` | Move the owned user launcher to Trash |
| `explodex uninstall-launcher --system` | Remove the owned system launcher after authorization |
| `explodex inject` | Inject into Codex already running on the configured debug port |
| `explodex install-skill` | Run `npx skills add dan-dr/explodex` to install the plugin creator skill |
| `explodex doctor` | Re-run onboarding checks for `Explodex.app` and the plugin creator skill; offer to repair missing pieces interactively |

An existing bundle without the Explodex ownership marker or legacy Explodex bundle identity is never overwritten or removed, including with `--force`.

## Launch state machine

Default debug port: `9333`; override with `EXPLODEX_DEBUG_PORT`.

| Observed state | Action |
|---|---|
| Codex stopped, port free | Launch Codex via `open -a /Applications/Codex.app --args --remote-debugging-port=<port>`, wait for the port, inject, activate, exit launcher runtime |
| Codex owns expected port | Inject, activate, exit launcher runtime |
| Codex running without expected port | Tell the user to quit Codex first, then exit; Explodex never quits Codex for you |
| Another process owns expected port | Stop with the owner and recovery action in the error |
| Codex missing, port timeout, injection failure | Stop with an actionable message and log paths |

Codex is started through LaunchServices (`open -a`), not by spawning its inner Mach-O binary, so Codex runs as its own top-level app with its own TCC identity. A binary spawned from a shell inherits the terminal's TCC identity, which makes macOS attribute Codex's own permission prompts (Screen Recording, Automation, etc.) to the controlling terminal instead of to Codex. Launching via `open` lets Codex's existing permission grants apply. Activation likewise uses `open -a` rather than an AppleScript `activate`, avoiding an Automation prompt. Dev mode remains isolated; see [local-development.md](./local-development.md).

## Logs and updates

Logs are under `~/.explodex/logs/`:

- `launcher.log`: state decisions and launcher/injector output

Because Codex is launched via `open` (LaunchServices), its stdout/stderr are not captured into `~/.explodex/logs/`; use Codex's own logging for that stream.

Explodex checks npm at most once per 24 hours in a detached background process. Cached results may print a new-version notification; Explodex never updates itself automatically. Reinstall with the package manager used for the global installation.

No daemon monitors Codex. Restart survival after Codex self-update is deferred research.
