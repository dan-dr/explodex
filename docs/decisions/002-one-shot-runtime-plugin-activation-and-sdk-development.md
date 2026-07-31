# ADR-002: Use one-shot runtime operations and disabled-by-default plugins

## Status

Accepted

This replaces the earlier supervisor-based ADR-002 draft. No supervisor version
was accepted or implemented.

## Date

2026-07-23

## Context

Explodex must support these behaviors without endangering the ChatGPT instance
that hosts the plugin-authoring conversation:

- launch or relaunch ChatGPT with CDP available;
- inject the SDK and approved plugins, then leave ChatGPT running;
- develop a dynamic plugin in the current authoring renderer without restart;
- move restart-required or SDK-runtime tests to an isolated development app;
- discover new installed plugins at startup or explicit refresh;
- show first-time enablement inside the renderer;
- keep disabled executable source out of the renderer;
- let a plugin and local SDK checkout be developed together;
- give normal authors a published CLI and SDK rather than requiring this repo.

A persistent supervisor, daemon, Unix socket, continuous filesystem watcher,
automatic reconnect loop, and crash monitor would make process coordination the
product's central architecture. V1 does not require that complexity. Explicit
launch, refresh, install, and development operations provide the needed control
points.

## Decision

Publish one TypeScript `explodex` CLI. Normal commands are one-shot operations.
They connect to ChatGPT through CDP, complete one bounded action, disconnect,
and exit. ChatGPT continues independently.

### Process model

```text
one-shot CLI operation
  ├── read installed artifacts and activation state
  ├── launch or connect to an exact ChatGPT target
  ├── inject SDK, metadata, and enabled plugin bytes
  ├── optionally wait for one in-renderer review decision
  └── disconnect and exit

ChatGPT renderer
  ├── SDK runtime
  ├── approved enabled plugins
  └── plugin review UI

explicit plugin development operation
  ├── remains foreground only while requested
  ├── watches selected plugin and optional SDK source
  ├── rebuilds and validates
  └── injects into exact main or owned development target
```

The CLI contains shared one-shot operations for host discovery, target
selection, injection, artifact handling, state, and output. It has no
`sessions/` supervisor client, no internal daemon entrypoint, and no socket
protocol.

The final public command names are decided in a later CLI and skill-surface
session. Automation-relevant operations provide stable `--json` results from
the start.

### Discovery and activation

Installed artifacts and persisted activation state are separate:

```text
~/.explodex/plugins/<plugin-id>/<version>-<shortdigest>/
~/.explodex/state/plugins.json
```

The state file is the single persisted source of truth. The renderer receives
an operation snapshot and does not maintain a competing authoritative state.

On launch, add, update check, or explicit refresh, the operation performs a
full scan and validates manifests plus checksums. It injects:

- metadata for disabled or pending plugins;
- executable source only for exact enabled artifacts.

When review is required, the CLI installs a nonce-bound, operation-scoped CDP
callback and opens `New plugins detected` in the renderer. Controls may begin
selected, but no plugin executes until the user chooses Continue or Enable
Selected. The CLI validates the selected exact identities, writes state,
injects those artifacts, removes the callback, and exits.

If the command ends before confirmation, nothing activates and the review
returns on the next explicit refresh. If a verified renderer-to-OS handoff can
start a new one-shot operation after the command exits, the UI may use it. That
handoff is optional and must not be replaced by a resident helper.

There is no Ignore state. General mid-run discovery occurs only through an
explicit add or refresh operation. Update Selected installs only selected
immutable artifacts. A previously disabled plugin remains disabled after an
update.

The review screen warns that enabled plugins are trusted, unsandboxed code that
may read or modify the ChatGPT UI and authenticated renderer state. This prompt
prevents accidental activation but is not a security boundary against already
enabled malicious code.

### Main and development targets

The current authoring ChatGPT instance is protected. A development operation
may dynamically inject, unload, load, and test there only when the exact CDP
target is known. It never restarts, reloads, navigates, closes, or stops that
instance.

Restart, renderer-reload, app-start, and SDK-runtime testing use a separate
ChatGPT development process with isolated mutable profile, `CODEX_HOME`, state,
logs, and CDP port. Lifecycle commands are also one-shot. Before restart or
stop, they re-prove the exact recorded development identity. Termination uses
CDP `Browser.close` or a signal to that verified PID, never a global quit by
bundle identifier.

An explicitly invoked plugin development command may stay alive while it
watches and rebuilds. Any reconnect or reinjection it performs is scoped to
that active operation. It does not become a general session supervisor.

### SDK plus plugin development

Normal plugins use a published SDK version range. When a plugin needs an SDK
change, use the plugin development operation with an explicit local SDK source:

```text
plugin development operation . --sdk-source /absolute/path/to/Explodex/packages/sdk
```

The operation watches both trees, builds the SDK first, builds the plugin
against generated public types, and tests the pair in the isolated development
instance by default. A bad SDK injection is recovered by a clean restart of the
owned development process.

There is no SDK-only command family, hot SDK rollback, permissions manifest, or
SDK capability negotiation. Plugin publication requires compatibility with a
released SDK version or range and never records a local SDK path.

## Alternatives considered

### Persistent foreground supervisor

Rejected for V1. It would make normal use depend on a long-running external
process even though startup and explicit refresh are sufficient.

### Detached supervisor or daemon

Rejected for V1. Sockets, locking, version skew, crash recovery, logout/reboot
survival, and lifecycle ownership are speculative robustness work.

### Continuous external plugin-directory watching

Rejected for normal use. Manual copies appear on startup or explicit refresh.
The foreground plugin development operation watches only the selected source
while the user is actively developing it.

### Automatically activate copied or updated plugins

Rejected. Installation and discovery are not consent to execute renderer code.

### Out-of-renderer first-time approval

Rejected for V1. Enablement stays in ChatGPT. The spoofing limitation is
accepted under the trusted-plugin model and must be documented honestly.

### Standalone SDK development commands

Rejected. SDK changes are made and proven through the plugin that needs them,
using a local SDK source override.

## Consequences

- Normal launch and refresh leave no Explodex process behind.
- The runtime has fewer lifecycle, recovery, and version-skew failure modes.
- New plugins and updates do not execute merely because files appeared.
- Disabled plugin executable source is unavailable to enabled plugin code
  through an injected catalog.
- Mid-run manual-copy detection requires explicit refresh.
- In-renderer enablement needs a proven operation-scoped CDP round trip. If that
  cannot be implemented without a resident helper or disabled source exposure,
  the product falls back to review followed by explicit refresh and requests a
  product decision.
- Automatic crash attribution, post-reload reconnect, and always-live plugin
  management are outside V1.
- SDK contributors use the same plugin-centered workflow as other authors.
