# Views

Persistent named workspaces for Codex threads and utility panes.

## Behavior

- Adds a **Views** section immediately above globally pinned threads.
- Creates named views that persist pane contents and the complete dock layout.
- Uses Dockview for tab dragging, edge docking, nested horizontal/vertical splits,
  sash resizing, maximization, keyboard navigation, and JSON serialization.
- Renders multiple threads from Codex's `recent-conversations-meta` query cache in
  one renderer. It does not create one Codex webview per thread.
- Adds **Open project view** to a project's context menu. The generated view uses
  up to four recent project threads in a two-by-two layout.
- Supports thread, browser, and terminal panes. Thread panes provide a lightweight
  transcript plus a quick prompt; the normal Codex thread remains the full editor.
- Exits the active view before Codex handles a normal sidebar thread click, so the
  selected thread cannot open underneath the view. **Escape** and **Exit view** in
  the toolbar provide explicit close paths.

The browser pane uses Electron's `<webview>` for external pages. Codex itself
cannot be duplicated into an iframe/webview: its `app://-` renderer routing and
state are owned by the existing renderer.

## Layout-manager research

Codex already bundles `@dnd-kit` and an app-shell tab controller. The controller
has exactly two targets, `right` and `bottom`, and can reorder or move tabs between
them. `thread-panel-state-*` likewise hard-codes those two panel IDs. No arbitrary
split-tree, docking model, or serializable workspace manager is present.

Options evaluated:

| Manager | Fit | Decision |
|---|---|---|
| [Dockview](https://dockview.dev/docs/overview/introduction/) | Vanilla JS package, zero runtime dependencies, nested docking, tabs, drag/drop, persistence, current v7 accessibility support | Selected |
| [Golden Layout](https://golden-layout.github.io/golden-layout/) | Framework-neutral and mature; virtual components are useful for iframe stability | Viable fallback; older API/theme model |
| [FlexLayout](https://github.com/caplin/FlexLayout) | Rich JSON tree and docking | Rejected here: React-only, while injected plugins do not own Codex's React root |
| [React Mosaic](https://nomcopter.github.io/react-mosaic/) | Strong tiling model | Rejected here: React-only and less tab/workbench-oriented |

Dockview 7.0.2 is vendored as `vendor/dockview.min.js` with its MIT license.
`plugin.json.scripts` loads the vendor runtime before `index.js`; runtime CDN
fetching is intentionally avoided.

## JavaScript API

The renderer exposes `Explodex.views` for automation and CDP-based testing:

- `list()`
- `create(name, panes?)`
- `open(viewId)` / `close()` / `remove(viewId)`
- `addPane(viewId, pane)`
- `openProject(projectId, label?)`

This is not registered as a model tool. Explodex plugins execute in the renderer,
while Codex model tools are registered by the app-server/main-process harness.
Bridging dynamic renderer APIs into that registry would require a new trusted IPC
and tool-discovery protocol, not a small plugin hook. Per scope, Views keeps the
callable JS API and does not patch the harness.
