# Project Folder Colors

Color-code project folders and threads in the Codex sidebar.

## Behavior

- **Hover picker**: a ◍ button appears on the left when you hover a project folder or thread row (does not override native right-click).
- **What to color** (Explodex page):
  - **Project folders** — folder headers only (+ any custom thread colors)
  - **Threads** — thread rows inherit their project color (+ any custom thread colors)
  - **Both** — project + threads as one grouped block; side accent is one continuous bar, full-width tint is one rounded block
- **Custom thread colors** always show, regardless of the mode above.
- **Auto-assign** applies to project colors only; threads inherit from their project.
- **Visual style**: side accent or full-width tint.
- **Palette**: customize picker swatches on the Explodex page (minimum 5).

Configure via sidebar **💥 Explodex** → **Project Folder Colors**.

## Persistence

`explodex-project-colors` in renderer persisted storage.

## Verify

1. `bun run package && bun run inject` (or `bun run install:app`)
2. Hover a project/thread row — ◍ appears on the left; click to pick a color.
3. Native right-click on rows still works.
4. **Threads** mode: all threads match their project color.
5. **Both** mode: one accent line / one tint block per project group.