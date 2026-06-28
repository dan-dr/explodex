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

The package-manager command installs Explodex globally. `explodex` then idempotently creates or repairs `~/Applications/Explodex.app`, checks the cached npm registry update notification, and opens the app.

The launcher is generated locally from plist, icon, zsh, and JXA/AppKit assets. Explodex does not distribute a native launcher executable, sign the generated launcher, clear quarantine attributes, re-sign Codex, or change Codex's bundle ID.

## Commands

| Command | Behavior |
|---|---|
| `explodex` | Repair the user launcher, then open it |
| `explodex install-launcher` | Explicit user launcher install/repair |
| `explodex install-launcher --system` | Install `/Applications/Explodex.app`; macOS requests authorization |
| `explodex install-launcher --force` | Force regeneration only when the target has an Explodex ownership marker |
| `explodex uninstall-launcher` | Move the owned user launcher to Trash |
| `explodex uninstall-launcher --system` | Remove the owned system launcher after authorization |
| `explodex inject` | Inject into Codex already running on the configured debug port |
| `explodex update` | Run `npm install -g explodex@latest` |
| `explodex doctor` | Print Codex, injector, port, and log diagnostics |

An existing bundle without the Explodex ownership marker or legacy Explodex bundle identity is never overwritten or removed, including with `--force`.

## Launch state machine

Default debug port: `9333`; override with `EXPLODEX_DEBUG_PORT`.

| Observed state | Action |
|---|---|
| Codex stopped, port free | Start the normal Codex profile with remote debugging, wait, inject, activate, exit launcher runtime |
| Codex owns expected port | Inject, activate, exit launcher runtime |
| Codex running without expected port | Offer **Quit and Relaunch with Explodex** or **Cancel**; never quit without confirmation |
| Another process owns expected port | Stop with the owner and recovery action in the error |
| Codex missing, quit timeout, port timeout, injection failure | Stop with an actionable message and log paths |

Installed mode explicitly removes profile override variables before spawning Codex. Dev mode remains isolated; see [local-development.md](./local-development.md).

## Logs and updates

Logs are under `~/.explodex/logs/`:

- `launcher.log`: state decisions and launcher/injector output
- `codex.log`: Codex stdout/stderr for an Explodex-started process

Explodex checks npm at most once per 24 hours in a detached background process. Cached results may print a notification; Explodex never updates itself automatically. Run `explodex update` explicitly.

No daemon monitors Codex. Restart survival after Codex self-update is deferred research.
