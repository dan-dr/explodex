# Command Menu Thread Search

![Command menu thread search](../../docs/plugins/screenshots/command-menu-thread-search.png)

## Purpose

Merge Cmd+G-style thread search into the Cmd+K command palette. When you open the command menu, threads appear **first** under a **Threads** header; commands follow unchanged.

## Behavior

| State | What happens |
|-------|----------------|
| Cmd+K, empty query | Commands only — no threads until you type. Placeholder: **Type command or search threads**. |
| Cmd+K, any typed query | Up to 5 matching threads under **Threads** (pinned first, then most recent activity), then native command results. Includes collapsed/hidden project threads via in-memory metadata. |
| Cmd+G (chats mode) | Native thread search unchanged; plugin relabels/reorders only (no duplicate injection). |

Selecting a plugin-injected thread clicks the matching sidebar row (falls back to `bridge.navigate('/local/{conversationId}')`) and closes the menu.

## Implementation

DOM observation only — Codex exposes no SDK API to register command-menu items.

1. `MutationObserver` on `document.documentElement` watches for `.global-command-menu-dialog [cmdk-root]`.
2. Thread list comes from Codex's in-memory `recent-conversations-meta` React Query cache (same source as native Cmd+G search), with pinned status from `list-pinned-threads`. Sidebar DOM is a fallback when the cache is empty.
3. Sidebar rows are still used when visible for activity labels; navigation uses `bridge.navigate('/local/{id}')` when the row is collapsed/hidden.
4. Native thread result groups are detected via `command-menu-quick-chat-result:` / `command-menu-first-chat-item` `data-value` prefixes and known headings (`Pinned chats`, `Recent chats`, etc.).
5. Teardown disconnects observers, cancels pending `requestAnimationFrame`, and removes `#explodex-cmdk-threads-group`.


## Risks

- **Fragile DOM**: cmdk attribute names, dialog class names, and sidebar `data-app-action-*` attributes may change on Codex upgrades. See `docs/sdk-fragility.md`.
- **Duplicate threads**: mitigated by skipping sidebar injection when native thread results are already visible.
- **React/cmdk conflicts**: DOM writes pause the list `MutationObserver`, skip unnecessary group reorders in Cmd+K mode, and wrap enhancement in try/catch so a bad mutation cannot take down the command menu.

## Verification

1. `bun run package && bun run inject`
2. Press **Cmd+K** — confirm **Threads** section first, then commands.
3. Type 2+ characters — confirm native thread search filters and stays above commands.
4. Select a thread — confirm navigation and menu close.