# Installation and plugin trust

Explodex targets the installed, read-only `/Applications/ChatGPT.app`. The app
keeps its original bundle, signature, identity, and profile.

## Install the CLI

Explodex requires macOS and Node.js 22 or 24. Install the published package
globally with one package manager:

```sh
npm install -g explodex
# or: pnpm add -g explodex
# or: bun install -g explodex
# or: yarn global add explodex
```

Confirm the package CLI and host identity:

```sh
explodex --version
explodex host report
explodex compatibility status
```

The public CLI manages plugins with bounded operations. It does not install a
wrapper application, patch ChatGPT.app, or start a background service.

### Available command surface

| Command | Purpose |
| --- | --- |
| `host report` | Read-only canonical ChatGPT.app identity and compatibility summary |
| `compatibility status` | Read-only exact compatibility key and status |
| `main status` | Read-only authoring-main classification and separate port obstruction |
| `plugin create` | Scaffold a generated-only TypeScript workspace |
| `plugin validate` | Validate source and package authority |
| `plugin build` | Generate browser-safe `dist/` artifacts |
| `plugin package` | Package one immutable archive |
| `plugin artifact validate` | Independently validate a packaged artifact |
| `plugin install` | Install immutable bytes disabled and pending review |
| `plugin status` | Show installed, pending, and enabled identities |
| `plugin refresh` | Discover installed identities and present pending review |
| `plugin review` | Present metadata-only activation review |
| `plugin update check` | Check remote recommendations without applying |
| `plugin update apply` | Review and apply selected updates |
| `dev status/start/ensure/recover/inject/restart/stop/focus` | Operate only the exact isolated development instance |

Global options include `--json`, `--home <path>`, `--dev-root <path>`,
`--timeout <duration>`, and `--no-color`. `--json` emits one stable
schema-versioned envelope on stdout. Run `explodex --help` or
`explodex <group> <command> --help` for the descriptor-derived contract.

Reserved command paths appear in help but fail closed as unavailable. Do not
build automation around a reserved path.

## Install a plugin

Every source converges on the same result: an immutable, validated artifact is
installed disabled and pending a separate metadata-only review. Installation
does not grant execution authority.

### Local archive

```sh
explodex plugin install ./my-plugin-1.0.0-<payload-sha256>.tar.gz
```

The CLI computes and records the archive digest, but a local file has no
independent publisher trust anchor. Only install local archives whose origin
you already trust.

### First-party registry

```sh
explodex plugin install --registry effort-shortcuts
```

The registry is a checksummed `registry.json` published as a canonical Explodex
GitHub Release asset. The selected entry supplies the immutable artifact URL,
plugin identity, payload digest, and archive digest. The CLI validates all of
them before committing the artifact.

### Direct GitHub Release

```sh
explodex plugin install \
  --github-url https://github.com/OWNER/REPOSITORY/releases/download/TAG/PLUGIN.tar.gz \
  --archive-sha256 <64-lowercase-hex>
```

`--github-url` accepts only a canonical immutable GitHub Release asset URL and
requires an independently supplied archive SHA-256. Add
`--payload-sha256 <64-lowercase-hex>` when the publisher also provides the
canonical payload digest. Redirects stay inside the trusted GitHub host set.

The URL and matching digest prove which bytes were fetched. They do not prove
the publisher is trustworthy and do not sandbox the plugin.

Choose exactly one source per invocation: local archive, `--registry <id>`, or
`--github-url <url>`.

## Review and activation

```sh
explodex plugin status
explodex plugin review effort-shortcuts --target development
explodex plugin refresh --target main
```

`plugin install` defaults to `--target none`. Use `--target development` or
`--target main` to request review immediately when that exact target is
available. An unavailable target leaves the plugin disabled and pending.

The review shows metadata and the exact artifact identity. Enabling is a
separate explicit selection. Enabled plugins are trusted, unsandboxed renderer
code that can read or modify UI and authenticated renderer state. Checksums
protect byte identity, not publisher authenticity or runtime isolation.

Installed state lives under `~/.explodex/`. Reinstalling the exact identity is
idempotent and does not silently expand prior activation authority.

## Isolated development instance

Use the exact owned development instance for disruptive plugin testing:

```sh
explodex dev ensure
explodex dev status
explodex dev inject ./my-plugin.tar.gz
explodex dev focus
explodex dev restart
explodex dev stop
```

Its fixed default endpoint is `127.0.0.1:9444`, with isolated application data,
`CODEX_HOME`, Explodex state, and process ownership records under
`~/.explodex/dev/plugin-dev`. `dev ensure` reuses a healthy instance or starts
one bounded instance. It is not a supervisor and does not retry forever.

Stop and restart act only after exact PID, process-start identity, launch
marker, private paths, listener, target, and execution-context verification.
They never use app-wide quit, process-name signals, or the first reachable
renderer as a fallback.

## One-shot operation boundary

Explodex runs no daemon. Normal host, compatibility, plugin install, refresh,
review, update, and development lifecycle commands exit after their bounded
action. Only an explicitly invoked foreground plugin-development watch may stay
alive.

An existing authoring main is protected from automatic restart, reload,
navigation, close, and stop. Commands report a blocked or pending action when
ownership cannot be proven. See [local-development.md](./local-development.md)
for the complete session-safety workflow.
