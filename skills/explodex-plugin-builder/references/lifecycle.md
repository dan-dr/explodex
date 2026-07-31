# Plugin lifecycle and delivery

## Source states

| State | Path | Meaning |
|---|---|---|
| Authored workspace | User-selected `explodex-plugin-<id>/` | Durable TypeScript source |
| Generated output | `<workspace>/dist/` | Deterministic inert runtime payload |
| Release artifact | `*.tar.gz` | Immutable validated install input |
| Installed payload | CLI-owned `~/.explodex/plugins/<id>/` identity path | Disabled until exact review and activation |

## Finalization gate

1. `explodex plugin validate <workspace>` succeeds.
2. Model and behavior tests pass.
3. `explodex plugin build <workspace>` generates only declared output.
4. `explodex plugin package <workspace>` produces a validated archive.
5. Isolated `plugin develop` proves behavior when a live renderer is required.
6. Teardown removes every plugin-owned resource.

## Install and activation

Install only a prebuilt archive, a verified registry entry, or an allowlisted
immutable GitHub release asset. Installation validates archive and payload
digests before committing a disabled payload. Metadata review and activation
are separate public CLI operations.

Never copy generated files directly into Explodex state. Never overwrite an
installed identity by hand. Use public install, review, update, disable, and
remove commands so state and renderer boundaries remain consistent.

## Remove

Use the public CLI removal operation with the exact installed identity. Source
workspace deletion is separate and requires explicit user intent. Use Trash for
authorized source deletion.
