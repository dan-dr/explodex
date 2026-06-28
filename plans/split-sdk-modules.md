# Split SDK Modules and Migrate to TypeScript

This plan outlines the architecture review, file splitting strategy, TypeScript migration, and build integration for `sdk/explodex-sdk.js`.

## Architectural Review & Module Layout

The current SDK is a single ~3,200 line JavaScript file. To make it maintainable without introducing circular dependency complexity, we will group the codebase into **7 consolidated TypeScript modules**:

```text
sdk/
  src/
    core.ts         # Entry point, styles, logging, config/meta constants, icon-path-fix
    zones.ts        # DOM zones mounting, observation, and query selectors
    plugins.ts      # Plugin catalog, manager lifecycle, and data migrations
    bridge.ts       # IPC bridge, HTTP proxy, and Statsig config propagation
    codex.ts        # ProseMirror composer actions, React fiber walking (fragile layer)
    ui.ts           # Styled UI components, popovers, modals, countdown formatting, and sidebar inserts
    app-server.ts   # AppServer router capture (prototype call/apply monkeypatching)
```

### Architectural Rationale for 7 Modules

1. **Isolating Fragility**: As analyzed in `docs/sdk-fragility.md`, React fiber traversal (`codex.*`) is highly version-sensitive. By isolating it inside `codex.ts`, we prevent structural breakage from affecting the stable network and IPC layers inside `bridge.ts`.
2. **Cohesive UI Rendering**: All components, overlays, custom styles, formatting, and relative sidebar insertions live inside `ui.ts`. This simplifies token access and avoids circular imports between dialogs, popovers, and custom forms.
3. **Decoupled Bootstrapping**: `app-server.ts` handles the early prototype monkeypatching globally. By separating it from `core.ts` (which sets up `window.Explodex`), we keep the prototype interception self-contained and easy to disable or configure.

---

## Grouping Map

| Module | Contents |
|---|---|
| **`core.ts`** | IIFE initialization wrapper, reload safety, `log` namespace (entries buffer, log subscribers), stylesheet injection (`styles`), `icon-fix` (absolute pathing fix), and version metadata constants. |
| **`zones.ts`** | `ZONE_DEFINITIONS` list, resolving zone anchors, `mount` tracking, `waitFor` / `observeZone` triggers, and the `query` DOM selection namespace (`testId`, `portal`, `one`, `all`). |
| **`plugins.ts`** | Catalog declarations registry, `register` options, dynamic `load`/`unload`/`enable`/`disable` methods, options panel registry, and data migrations manager. |
| **`bridge.ts`** | Stable transport: `bridge` (IPC sending & RPCs), `http` authenticated backend proxy, and Statsig gate overrides & config invalidation (`flags`). |
| **`codex.ts`** | Codex framework hooks: `composer` text/caret actions, and `codex` React fiber tree walker helpers. |
| **`ui.ts`** | HTML UI rendering: styled elements (`components` buttons, select, checklists, text fields), `format` relative duration formatting helpers, `ui` popovers / dialog confirmation overlays, and `sidebarNav` Relative DOM insertions. |
| **`app-server.ts`** | Low-level prototype hooks to intercept the `sendRequest`/`setMessageHandler` connection in-renderer. |

---

## Build Integration & Git Hygiene

To ensure all compiled artifacts are never stale and don't clutter local code reviews, we will auto-generate both the JS bundle and the `.d.ts` declaration file:

1. **Git Ignore**: Add both `sdk/explodex-sdk.js` and `sdk/explodex-sdk.d.ts` to `.gitignore`. (They remain in the `package.json` `"files"` array, meaning npm will still package them during prepublish/prepack).
2. **Auto-Generated Types**: 
   We will write `scripts/build-sdk.ts` to automatically:
   * Build the JS bundle via `Bun.build`.
   * Bundle the TS module declarations into `sdk/explodex-sdk.d.ts` using `dts-bundle-generator`.
   * Append global scope declarations (e.g., `window.Explodex` and ambient `const Explodex: ExplodexAPI`) to the output `.d.ts` file automatically.
3. **Automatic Builds**:
   * **In Dev**: `scripts/package-app.ts` (called by `bun run dev` and `bun run package`) will automatically run the build script before staging.
   * **In Validation**: `scripts/validate.sh` will run `bun run build:sdk` as its first step.
   * **In prepublish**: `prepack` script in `package.json` will trigger `bun run build:sdk`.

---

## Detailed Step-by-Step Migration Plan

We will perform the migration incrementally to ensure validation passes at every checkpoint.

### Phase 1: Build Infrastructure and Setup

#### [NEW] `scripts/build-sdk.ts` (Build Script)
Create the Bun-based build script that bundles `sdk/src/core.ts` into the IIFE JS wrapper, runs `dts-bundle-generator` to compile `sdk/explodex-sdk.d.ts`, and appends the ambient global bindings.

#### [MODIFY] [tsconfig.json](file:///Users/dan/Projects/ddyo/Explodex/sdk/tsconfig.json)
Configure the compiler options to compile files in `sdk/src/` with DOM types and strict checks. Add `dts-bundle-generator` to `devDependencies` in `package.json`.

#### [MODIFY] [package.json](file:///Users/dan/Projects/ddyo/Explodex/package.json)
Add `build:sdk` script, and configure `.gitignore` to ignore the built `sdk/explodex-sdk.js` and `sdk/explodex-sdk.d.ts`.

### Phase 2: Code Decomposition

We will move code block-by-block out of the monolithic file:
1. **`app-server.ts`**: Move prototype patching logic.
2. **`zones.ts`**: Extract DOM matching, zones, and queries.
3. **`bridge.ts`**: Extract stable transport handlers (IPC, HTTP, statsig flags).
4. **`codex.ts`**: Extract ProseMirror actions and React fiber traversal.
5. **`ui.ts`**: Extract all UI elements, countdown formatters, popovers, and sidebar relative insertions.
6. **`plugins.ts`**: Move catalog lifecycle management and database migrations.
7. **`core.ts`**: Incorporate setup checks, styles, logging, and export references.

### Phase 3: Validation and Verification

1. Run `bun run build:sdk` to generate the new modular bundle and `.d.ts` file.
2. Verify that the generated bundle passes `scripts/validate.sh` successfully.
3. Launch Codex with `bun run dev` and confirm in DevTools that `window.Explodex` initializes correctly and all namespaces are present and functioning.
4. Run integration tests (`bun test`) to verify launcher and CLI contracts.

---

## Verification Plan

### Automated Tests
- `bun run validate` - Check zsh syntax, compile TS, test JSONs.
- `bun test` - CLI, launcher, and platform test suites.

### Manual Verification
- Launch the app with `bun run dev`.
- Execute `window.Explodex` in the DevTools console to verify namespaces.
- Verify plugins load correctly from the catalog.
- Reload/re-inject the SDK via `bun run inject` to verify reload-safety (confirm logs say `[Explodex] reloading`).
