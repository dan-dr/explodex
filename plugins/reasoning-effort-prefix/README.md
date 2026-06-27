# Reasoning Effort Prefix

![Reasoning effort prefix](../../docs/plugins/screenshots/reasoning-effort-prefix.png)

## Purpose

Set Codex reasoning effort for the next message by typing a leading prefix:

| Prefix | Effort |
|--------|--------|
| `!xh` | `xhigh` |
| `!h` | `high` |
| `!m` | `medium` |
| `!l` | `low` |
| `!max` | `max` |
| `!min` | `minimal` |

Example: `!m explain this function` sends `explain this function` with medium reasoning effort.

## Implementation

The plugin live-applies effort while the user is typing a valid prefix. On send, it strips the prefix, lets the native composer submit continue, then restores the previous effort after a short post-submit delay.

Effort is applied by driving the **same in-renderer React callback the intelligence dropdown uses**, reached via `Explodex.codex.applyThreadSettingsForNextTurn` (SDK fiber walk). The older `bridge.send("update-thread-settings-for-next-turn")` path is **not** used for existing threads: in current Codex builds the SDK's AppServer router capture fails, so that bridge call falls back to a main-process IPC path that never updates the renderer atoms the composer ships. See `docs/reasoning-effort-prefix-session.md` §12.

Key APIs:

- `Explodex.codex.applyThreadSettingsForNextTurn` (existing thread; in-renderer setter)
- `Explodex.codex.getThreadModel` / `getThreadEffort` (read current thread state so effort-only changes keep the model and restore the right baseline)
- `set-default-model-config-for-host` (new-thread fallback, via bridge)
- `list-models-for-host` / `read-config-for-host` (model context; bridge, best-effort)

## Current Fixes

- Live apply is debounced while typing valid prefixes.
- Pending debounced apply is cancelled when the prefix is removed or becomes unsupported, so a stale timer cannot arm effort after the composer no longer has a prefix.
- Existing-thread apply requires `Explodex.codex.getThreadConversation` to find live thread state before invoking the fiber setter, mirroring Codex's loaded-thread guard.
- Teardown clears input listeners, global submit listeners, hint tracking, mutation observers, debounce timers, and post-submit restore timers, then force-restores any armed effort.
- Async input and hint paths bail when the composer text/node changes or the plugin unloads.

## Risks

- ProseMirror text replacement still uses DOM insertion because Codex does not expose the composer controller.
- The `sC` guard is approximated through `Explodex.codex.getThreadConversation`; that fiber shape is private and may change across Codex releases. Rollout JSONL remains final truth for real effort behavior.
- New-thread default config restore is best-effort.

## Verify

1. Launch with `npm run launch`.
2. Type `!m hello`.
3. Confirm the prefix is stripped from the sent text.
4. Confirm the next turn uses medium effort in rollout JSONL.
5. Send a normal follow-up and confirm the previous effort is restored.
