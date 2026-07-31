# Effort Shortcuts

Set the reasoning effort for the next message with a composer prefix:

| Prefix | Effort |
| --- | --- |
| `!xh` | `xhigh` |
| `!h` | `high` |
| `!m` | `medium` |
| `!l` | `low` |
| `!max` | `max` |
| `!min` | `minimal` |

For example, `!m explain this function` sends `explain this function` at
medium effort.

## Behavior

- Applies a valid effort while the prefix is present in the composer.
- Uses the active thread's in-renderer settings callback so the selected model
  stays unchanged.
- Removes the prefix before the native Enter or send-button action.
- Restores the previous effort after the turn is submitted.
- Falls back to the host's default-model configuration for a new thread.
- Filters the shortcuts shown in the hint to the active model's supported
  efforts.

Options can disable individual prefixes, the thinking-level hint, prefix
stripping, or post-send restoration. Existing settings migrate from
`explodex-reasoning-effort-prefix` to `explodex-effort-shortcuts`.

## Development

From the repository root:

```text
bun test packages/plugin-registry/explodex-plugin-effort-shortcuts/test
bun ./node_modules/.bin/tsc -p packages/plugin-registry/explodex-plugin-effort-shortcuts/tsconfig.json
bun ./packages/cli/src/bin/explodex.ts plugin validate packages/plugin-registry/explodex-plugin-effort-shortcuts
bun ./packages/cli/src/bin/explodex.ts plugin build packages/plugin-registry/explodex-plugin-effort-shortcuts
bun ./packages/cli/src/bin/explodex.ts plugin package packages/plugin-registry/explodex-plugin-effort-shortcuts
```

The existing-thread path depends on `getThreadConversation`, `getThreadModel`,
`getThreadEffort`, and `applyThreadSettingsForNextTurn` from `@explodex/sdk`.
Those APIs follow renderer-private Codex state, so a live check and rollout
JSONL remain the final proof after a Codex update.
