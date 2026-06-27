# Pin Scope Menu

![Pin scope menu](../../docs/plugins/screenshots/pin-scope-menu.png)

## Purpose

When a thread belongs to a project, replace the native pin click with a small menu:

- `Global`
- `Project`

Global uses Codex's native pinned-thread API. Project stores an Explodex project-pin map and keeps the thread at the top of that project group.

## Implementation

State keys:

- Codex global state: `explodex-project-pinned-threads` (durable map of conversationId → projectId)
- renderer localStorage fallback: `codex:persisted-atom:explodex-project-pinned-threads`
- Codex global state: `sidebar-project-thread-orders`
- Codex global state: `thread-project-assignments`
- Codex global state: `projectless-thread-ids`

The plugin resolves project/thread context from sidebar data attributes and React fiber props. If those private/DOM hints are unavailable, it falls back to Codex global-state assignments before opening the menu.

Project manual ordering is written as `{ threadIds }`.

## Fix Notes

Codex ignores manual `threadIds` when a project order has `sortKey`. The plugin deletes `sortKey` for project-pinned groups and reconciles pinned order after sidebar DOM mutations and pin/unpin actions.

### Persistence (v1.2.3+)

Project pin membership is stored in **Codex global state** (`set-global-state`), not renderer `localStorage` persisted atoms. Codex mirrors persisted atoms from main process on startup and can drop renderer-only writes; global state survives app restart in `.codex-global-state.json`.

On first load, any renderer localStorage pin map is migrated into global state.

### Performance (v1.2.2+)

- Mutation observer is scoped to the sidebar `nav` (`Scheduled task folders` landmark;
  legacy `Automation folders` fallback), not `document.documentElement`.
- Reconcile skips DOM writes when order and `data-explodex-project-pinned` markers are already correct.
- Project-pin visuals use CSS on thread rows (no `innerHTML` on React-owned pin buttons).
- The 5s polling interval was removed; reconcile is event-driven (sidebar mutations, zone rebinding, pin actions).

The native pin button receives both `pointerdown` and `click`. The plugin intercepts both phases for project threads so the scope menu does not leak a native pin toggle after opening.

Teardown removes the menu, event listeners, timers, interval, and mutation observer. Async reconcile work checks a disposed flag before further writes after unload.

## Risks

- React fiber access is private and can change.
- Manual project order may intentionally override Codex's current sort mode for that project.
- Reconciliation is best-effort; if Codex changes global-state shape, the plugin should stop and be re-reviewed.
- The assignment fallback depends on Codex's `thread-project-assignments` and `projectless-thread-ids` global-state keys.

## Verify

1. Launch with `npm run launch`.
2. Open a project thread in the sidebar.
3. Click the pin button and choose `Project`.
4. Confirm the project menu state persists.
5. Confirm the thread appears at the top of its project group after sidebar rerender/reload.
