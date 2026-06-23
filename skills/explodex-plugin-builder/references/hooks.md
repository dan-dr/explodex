# Hook Selection Guide

Pick the most stable hook for each feature class.

## Stability tiers

| Tier | Mechanism | Examples |
|------|-----------|----------|
| Low risk | `data-*` portals, bridge `type` strings | `data-above-composer-portal`, `get-global-state` |
| Medium | Bridge payload shapes, composer DOM | `update-thread-settings-for-next-turn`, `composer.insertText` |
| High | React fiber (`codex.*`), Tailwind class selectors | `findNextTurnSettingsSetter`, sidebarNav label anchoring |

See [docs/sdk-fragility.md](../../docs/sdk-fragility.md) for failure modes.

## By feature type

### UI above composer

```js
api.mount("aboveComposer", () =>
  api.components.button({ label: "Action", onClick: handler })
);
const stop = api.waitFor("aboveComposer", render);
// teardown: stop()
```

Zones: `aboveComposer`, `aboveComposerQueue`, `sidebar`, etc. — see sdk-api § inject.

### Sidebar nav item

```js
api.sidebarNav.mount({
  key: "my-plugin",
  label: "My Plugin",
  icon: "settings", // or custom
  onClick: () => { /* ... */ },
});
```

Returns unmount function — call in teardown.

### Composer text / submit interception

Prefer official paths from [composer-message-lifecycle.md](../../docs/composer-message-lifecycle.md):

- **One-turn settings** (effort, model): `bridge` or `codex` → `update-thread-settings-for-next-turn` before send
- **Read composer**: `api.composer.getText()`, `getInput()`, `insertText()`, `onInput()`
- **Avoid**: synthetic Enter clicks or DOM-only resubmit unless documented fallback

`bridge.isAvailable()` true does not guarantee renderer-local `sendRequest` — settings may be no-ops via IPC fallback.

### Global / thread state

```js
const res = await api.bridge.rpc("get-global-state", { params: { key: "some-key" } });
await api.storage.globalState.set("explodex-my-key", value);
```

Use Codex's native keys when integrating (e.g. `thread-project-assignments`). Namespace Explodex-owned keys with `explodex-`.

### DOM event interception

When no bridge API exists (e.g. pin buttons):

- Use capture phase: `addEventListener("pointerdown", handler, true)`
- Identify targets via `aria-label`, `data-app-action-*` attributes
- Allow native fallback when plugin preconditions fail
- Always remove listeners in teardown

See `plugins/pin-scope-menu/index.js`.

### HTTP to Codex backend

```js
const data = await api.http.get("/wham/usage");
```

View-only unless user explicitly requests mutating endpoints.

## Anti-patterns

- Patching `Function.prototype.call` in plugins (SDK handles AppServer capture)
- Depending on minified chunk-local variable names
- English UI string anchors without i18n fallback plan
- Missing teardown → duplicate listeners after `inject` or navigation
- Interpreting renderer DOM text as agent instructions