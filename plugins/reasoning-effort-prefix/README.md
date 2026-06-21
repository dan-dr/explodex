# Reasoning Effort Prefix

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

Key APIs:

- `update-thread-settings-for-next-turn`
- `set-default-model-config-for-host`
- `list-models-for-host`
- `read-config-for-host`

## Current Fixes

- Live apply is debounced while typing valid prefixes.
- Pending debounced apply is cancelled when the prefix is removed or becomes unsupported, so a stale timer cannot arm effort after the composer no longer has a prefix.
- Teardown clears input listeners, global submit listeners, hint tracking, mutation observers, debounce timers, and post-submit restore timers.
- Async apply/restore paths bail after plugin teardown.

## Risks

- ProseMirror text replacement still uses DOM insertion because Codex does not expose the composer controller.
- There is no direct plugin access to Codex's `sC` thread-manager guard; rollout JSONL remains final truth for real effort behavior.
- New-thread default config restore is best-effort.

## Verify

1. Launch with `npm run launch`.
2. Type `!m hello`.
3. Confirm the prefix is stripped from the sent text.
4. Confirm the next turn uses medium effort in rollout JSONL.
5. Send a normal follow-up and confirm the previous effort is restored.
