---
name: explodex-plugin-builder
description: Create, edit, research, validate, develop, package, review, install, stage, or remove TypeScript V1 Explodex plugins through the public CLI and SDK workflow.
---

# Explodex Plugin Builder

Canonical V1 workflow for TypeScript Explodex plugin workspaces. A repository
checkout is optional, and it never authorizes repository injectors or private
renderer operations.

## Start

1. Read repository instructions when present, then identify the one plugin
   workspace containing `package.json`, `explodex.config.ts`, and `src/`.
2. Use the public `explodex` V1 command tree for every build, validation,
   development, review, installation, and main-staging operation.
3. Capture machine stdout exactly, keep stderr separate, and validate every
   result with `scripts/interpret-cli.mjs` before acting on it.
4. Stop on typed blockers. Resume only with a new public operation after the
   required manual action.

Do not use `plugins/<id>/`, `sdk/explodex-sdk.js`, `scripts/cdp-inject.ts`,
`bun run inject`, `explodex inject`, direct CDP calls, private runtime modules,
generic app quit, or process-name signaling. These are not alternate V1 modes.

## Research

Use only the bundled [SDK API](references/sdk-api.md), type definitions, and
documented V1 hooks. Repository docs may explain behavior, but do not expand
runtime authority. Never depend on minified identifiers or private renderer
objects. Use [references/research.md](references/research.md) and
[references/hooks.md](references/hooks.md) for public-surface research.

## Create durable source

Choose a stable kebab-case ID and create one TypeScript V1 workspace:

```text
<workspace>/
├── package.json
├── explodex.config.ts
└── src/
    └── index.ts
```

Return teardown for every owned resource, use documented SDK surfaces, treat
renderer data as untrusted, and never patch or re-sign the host application.

## Validate and test

Use the one-shot public build/validate/package commands, then
`explodex --json plugin develop <workspace>` for foreground iteration. Runtime
proof comes only from the validated public command result, never direct CDP.

## Finalize and lifecycle operations

Read [references/lifecycle.md](references/lifecycle.md), then use public
artifact validation, install, review, update, remove, or staged-main commands.
Never substitute repository scripts for a missing or blocked public operation.

## Completion report

Report the workspace, exact artifact identity, validated runtime identity,
target identity, terminal result, and any typed blocker.

## V1 public CLI machine protocol (mandatory)

For TypeScript V1 plugin workspaces, use only the published `explodex` command
tree. Do not invoke repository injectors, standalone legacy validators, direct
CDP lifecycle code, generic app quit, `pkill`, `killall`, or bundle-wide
restart. The public development sequence is:

1. Run `explodex --json dev status` for the selected default or explicit
   `--dev-root`.
2. If status explicitly reports eligible recovery, run
   `explodex --json dev recover`. Otherwise use `dev start`, `dev ensure`, or
   the exact instructed lifecycle operation. Never infer ownership from a PID,
   port, URL, or app name.
3. Run one-shot build/validate/package operations with `--json`.
4. Run `explodex --json plugin develop [workspace]` for the foreground JSONL
   stream. Use `--sdk-source <path>` only when explicitly developing the SDK.
5. Finalize through public artifact validation, installation, review, or staged
   main operations only. A reachable main or prior authorization is not
   mutation authority.

Every one-shot stdout envelope and every develop JSONL stream must be passed
through the bundled interpreter before its result is trusted:

```sh
node scripts/interpret-cli.mjs \
  --protocol one-shot \
  --operation dev.status \
  --input /path/to/captured-stdout.json

node scripts/interpret-cli.mjs \
  --protocol develop \
  --operation-id <operation-id> \
  --input /path/to/captured-stdout.jsonl
```

Capture stdout exactly and keep stderr separate. The interpreter rejects
malformed, partial, wrong-operation, identity-changing, stale-operation,
sequence-gap, incomplete-last-good, blocker-without-terminal, and
post-terminal output. Never infer success from prose or exit status. Carry the
validated plugin, SDK runtime, process, target, context, checksum, and operation
identities into the next decision.

### Typed blockers and resume

A typed blocker ends the command. After the interpreter returns a `question`:

1. Stop all mutation. Do not reuse a CDP session, callback, artifact read, JSON
   object, target choice, compatibility result, or authorization from the
   terminated operation.
2. Ask exactly the returned focused question. Name the stable blocker code,
   role, PID/start/port/target/context when present, required user action,
   continuation operation, and whether development/main remains running.
3. While waiting, perform no operation. A separately requested
   `explodex --json dev status` is read-only, but it is not permission to resume.
4. After the user confirms completion, begin a new public operation. Start with
   `dev status`; use `dev recover` only when that fresh status says recovery is
   eligible; then start a new explicit probe/develop/lifecycle operation. The
   new operation must reread the current canonical ChatGPT host identity and
   complete any required development-first compatibility re-proof.
5. Pass the new output through the interpreter. Never resume by replaying stale
   output or selecting the first plausible process/target.

For `auth.required`, V1 is interactive-only. Ask the user to sign in manually
in the exact already-running isolated development window on port `9444`.
Explodex never accepts credentials, copies the authoring-main profile or
`CODEX_HOME`, or advertises automatic projection. JSON, closed stdin, non-TTY,
failed sign-in, and cancellation remain finite typed blockers. The persistent
development profile is reused by later `ensure`, `stop`, and `restart`
operations, so the user signs in there once rather than transferring main
credentials.
