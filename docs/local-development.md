# Local development and installed mode

Explodex has two deliberately separate launch paths.

## Installed mode

A global registry install (`pnpm add -g explodex`, or Bun/npm/Yarn equivalent) provides the CLI, SDK, bundled plugins, and CDP injector. The first `explodex` run generates `~/Applications/Explodex.app` and opens it. The generated bundle contains only:

- `Contents/Info.plist`
- `Contents/MacOS/Explodex` (zsh)
- `Contents/Resources/Explodex.icns`
- `Contents/Resources/progress.jxa` (JXA/AppKit progress UI)
- an Explodex ownership marker

The shell resolves `explodex --launch` through a login shell. This means an npm update is used without regenerating a native executable. `--from-app` is a deprecated alias. The CLI launches Codex through LaunchServices (`open -a /Applications/Codex.app --args --remote-debugging-port=<port>`) rather than spawning the inner Mach-O binary, injects package assets, activates Codex, and exits. Launching via `open` makes Codex its own top-level process with its own TCC identity, so a binary spawned from a terminal doesn't borrow the terminal's permission identity and macOS attributes Codex's permission prompts (Screen Recording, Automation) to Codex itself. It does not set `CODEX_ELECTRON_USER_DATA_PATH`; the LaunchServices session uses the normal Codex profile.

There is no daemon or supervisor. Surviving a Codex self-update restart is a low-priority research TODO, not current behavior.

See [installation.md](./installation.md) for the full state table and recovery commands.

## Source development

```sh
bun run dev
```

Development packages `dist/Explodex.app` from `templates/explodex-app/`, launches with CDP on port `9333`, injects repo SDK/plugins, and starts Chrome DevTools MCP. Development data stays isolated under `.explodex-user-data/` by default.

```sh
bun run inject
bun run package
bun run validate
```

`dist/Explodex.app`, `scripts/package-app.ts`, and templates are source-development tools. They are not npm distribution artifacts. No production ZIP, copied release app, `install.sh`, signing, or xattr-clearing flow is supported.

## Plugin paths

Installed injection layers bundled npm plugins first, then `~/.explodex/plugins/`; user plugins override bundled IDs. Dev injection may add repo plugins through `EXPLODEX_PLUGINS_DIR`.

## Profile boundary

- Installed mode: normal Codex profile; no profile override.
- Dev mode: isolated `.explodex-user-data/` unless explicitly overridden.

Never modify, re-sign, or change the bundle ID of `/Applications/Codex.app`.
