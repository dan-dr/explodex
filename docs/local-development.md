# Local development boundaries

Explodex develops against the installed, read-only
`/Applications/ChatGPT.app`. Repository and plugin workflows do not copy,
patch, re-sign, or change the app's bundle identity.

## One-shot by default

The package CLI has no daemon or supervisor. Host inspection, compatibility
status, plugin installation, refresh, review, update, and development lifecycle
commands are bounded operations that exit. Only an explicitly invoked
foreground plugin-development watch may stay running.

An existing authoring main is protected. Explodex never automatically restarts,
reloads, navigates, closes, stops, or generically injects into it. A dynamic
plugin may be applied only to an exact identified target. If that target cannot
be proven, the operation reports pending or blocked instead of guessing.

## Isolated instance on 9444

Use one persistent development instance for disruptive testing:

```sh
explodex dev ensure
explodex dev status
explodex dev inject ./plugin.tar.gz
explodex dev focus
explodex dev restart
explodex dev stop
```

From the repository checkout:

```sh
bun run dev:ensure
bun run dev:status
bun run dev:restart
bun run dev:stop
```

The defaults are:

| Resource | Value |
| --- | --- |
| Development root | `~/.explodex/dev/plugin-dev` |
| CDP endpoint | `127.0.0.1:9444` |
| Application data | isolated under the development root |
| `CODEX_HOME` | isolated under the development root |
| Explodex state | isolated under the development root |

`dev ensure` reuses a healthy instance. It repairs only a confirmed-dead record
when port `9444` is free, then launches at most once. It does not poll forever,
supervise, or auto-restart.

Every disruptive operation revalidates the recorded PID, kernel process-start
identity, launch marker, private paths, listener, target, and execution context.
Stop and restart use dev-port `Browser.close` or exact-PID termination. They do
not use app-wide quit, bundle activation, `killall`, or process-name signals.

## Safe workflow

1. Author TypeScript against `@explodex/sdk`.
2. Run `explodex plugin validate` and `explodex plugin build`.
3. Package and independently validate the immutable archive.
4. Use dynamic verification on an authoring target only when that exact target
   is positively identified and no reload is required.
5. Use the isolated development instance for startup, renderer reload,
   SDK-runtime, compatibility, or restart-required work.
6. Rebuild against publishable SDK bytes before staging anything for main.
7. Apply to main only through a fresh, exact approval for the staged artifact
   and target.

If a restart is required and no verified development target exists, leave live
verification pending. Never restart the authoring app as a fallback.

## Local SDK source

The public CLI provides one explicit foreground command for plugin-plus-SDK
work:

```sh
explodex plugin develop . \
  --sdk-source /absolute/path/to/explodex/packages/sdk
```

SDK generation completes before its dependent plugin generation. Local SDK
authority remains scoped to the exact owned development renderer. Local-SDK
output cannot be packaged, recommended, or transferred to main. Graduation
requires a rebuild without the override and a fresh development validation of
the publishable bytes. Do not treat local-SDK development as graduated until
that rebuild and validation pass.

## Plugin installation state

Immutable installed artifacts and their approval state live under
`~/.explodex/`. Installation from a local archive, the first-party registry, or
a canonical GitHub Release URL always starts disabled unless the exact identity
already had authority. Review is separate from transport and artifact
validation. See [installation.md](./installation.md).

## Monorepo development

```sh
bun install --frozen-lockfile
bun run build:npm
bun run checkTs
bun run validate
```

First-party plugin packages live under
`packages/plugin-registry/explodex-plugin-*`. Build their committed `dist/`
artifacts through the package CLI. Never hand-edit generated JavaScript,
manifests, checksums, source maps, or generation receipts.

See [development.md](./development.md) for the complete package, registry, and
port-9444 renderer diagnostics workflow. See
[separate-dev-instances.md](./separate-dev-instances.md) for the ownership
contract.
