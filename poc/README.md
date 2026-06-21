# Explodex POC

This POC is intentionally local-only. The installed `/Applications/Codex.app`
was copied to `vendor/Codex.app`; do not run patching experiments against the
Applications bundle.

## What it proves

- A small SDK can expose extension zones without coupling to Codex's minified
  React component names.
- The first useful zones are DOM-based:
  - `sidebar`
  - `composerActions`
  - `aboveComposer`
- Plugins can add a sidebar item and a composer button today with a renderer
  injection script.

## Run the mock harness

Open `poc/harness.html` in a browser. You should see:

- a `💥 Explodex` item appended to the mock sidebar
- an `Insert hello` button appended near the mock composer
- clicking `Insert hello` inserts text into the textarea

## Run against the real Codex renderer (recommended: runtime injection)

**No asar patching required.** Use the remote debugger + a small CDP injector script.

This is the cleanest way for POC work (chosen as path #3).

1. Launch the workspace copy with debugging enabled:

   ```sh
   CODEX_ELECTRON_USER_DATA_PATH="$PWD/.explodex-user-data" \
     ./vendor/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9333
   ```

2. In another terminal, run the injector:

   ```sh
   python3 scripts/cdp-inject.py
   ```

   It will:
   - Wait for the debugger
   - Find the main renderer page
   - Inject `sdk/explodex-sdk.js` via `Page.addScriptToEvaluateOnNewDocument` (MAIN world)
   - Also do an immediate evaluate for pages that are already loaded

3. The demo plugin should appear:
   - `💥 Explodex` sidebar item
   - "Insert hello" composer button

4. Edit `sdk/explodex-sdk.js` and re-run `python3 scripts/cdp-inject.py` (or reload the page in Codex). No rebuild or re-sign needed.

If the UI elements don't show up:
- Open DevTools (via the port or app) and check `window.Explodex`
- Inspect actual sidebar/composer DOM and refine selectors in the SDK

**Why this is preferred for the POC:**
- Zero modification to the asar (no signing fights, no repack corruption risk)
- Matches how many real mods start (Discord users often begin with devtools paste)
- Extremely fast iteration

(If you later want a "permanently installed" version without running an extra script every time, we can revisit asar patching or preload injection.)

## Legacy asar patch path (optional)

If you want a self-contained patched bundle (no extra script at launch time), see `scripts/patch.py --apply`.

Only use restore when you want to go back to completely stock Codex:

```sh
./scripts/restore.sh
```
