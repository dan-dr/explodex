# Reasoning effort prefix — development session log

> Session focus: Explodex plugin to set Codex **reasoning effort for the next message only** via composer prefixes (`!xh`, `!h`, `!m`, `!l`, etc.).  
> Status as of **2026-06-21**: **FIXED in v2.2.0.** Real root cause was *not* the React-snapshot race theorized below — it was the SDK's **broken in-renderer AppServer router capture**, which silently routed every `bridge.send` to the main-process AppServer (never updating renderer atoms). Fixed by driving the same in-renderer React callback the intelligence dropdown uses, located via fiber walk (`Explodex.codex.applyThreadSettingsForNextTurn`). See [§12](#12-real-root-cause--fix-v220-2026-06-21). Earlier sections (§6, §9, §11) are kept as historical analysis.

**Related docs**

- [composer-message-lifecycle.md](./composer-message-lifecycle.md) — send APIs, effort/collaborationMode, hook strategies
- [codex-architecture.md](./codex-architecture.md) — bundle topology, injection zones, IPC bridge
- [current-findings.md](./current-findings.md) — general Explodex / Codex RE notes
- [AGENTS.md](../AGENTS.md) — agent instructions (keep docs updated on research/document requests)

**Implementation**

- Plugin: [`plugins/reasoning-effort-prefix/index.js`](../plugins/reasoning-effort-prefix/index.js)
- Plugin docs: [`plugins/reasoning-effort-prefix/README.md`](../plugins/reasoning-effort-prefix/README.md)
- SDK: [`sdk/explodex-sdk.js`](../sdk/explodex-sdk.js) (`bridge.send`, `composer.*`)
- Deploy: `./scripts/sync-wrapper.sh` → `Explodex.app`

---

## Table of contents

1. [Goal](#1-goal)
2. [What we built (v1)](#2-what-we-built-v1)
3. [Research path](#3-research-path)
4. [Verification](#4-verification)
5. [What worked vs what did not](#5-what-worked-vs-what-did-not)
6. [Root cause analysis](#6-root-cause-analysis)
7. [Composer API mapping (key decision)](#7-composer-api-mapping-key-decision)
8. [Documentation decisions](#8-documentation-decisions)
9. [Fix direction: Option A](#9-fix-direction-option-a)
10. [Open questions and next steps](#10-open-questions-and-next-steps)

---

## 1. Goal

**User-facing behavior**

- Prefix a composer prompt with a short token to set **reasoning effort for the next message only**.
- Strip the prefix before the message is sent (user should not see `!m` in the thread).
- Supported prefixes (model-dependent): `!xh`, `!h`, `!m`, `!l`, `!max`, `!min` → map to Codex effort values (`xhigh`, `high`, `medium`, `low`, `max`, `minimal`).
- Typing `!` at the start opens a helper popover listing levels valid for the current model.
- Must preserve **full composer submit behavior** (attachments, mentions, IDE context, queue/steer) — not a stripped-down MCP send path.

**Non-goals (for v1)**

- Persisting effort across messages (explicitly “next message only”).
- Changing Codex UI dropdown state visually (nice-to-have; not required if rollout effort is correct).

---

## 2. What we built (v1)

Plugin `reasoning-effort-prefix` registers with Explodex SDK and:

1. **Intercepts submit** — capture-phase `keydown` (Enter) and `pointerdown` (send button near composer) when text matches `!<level> <prompt>`.
2. **Sets effort** via official bridge APIs:
   - **Existing thread** (`conversationId` from portal attrs or URL `/local/:id`): `update-thread-settings-for-next-turn` with `{ threadSettings: { model, effort } }` (same shape as UI dropdown).
   - **New thread** (no id): `set-default-model-config-for-host`, then restore previous default ~1.5s later.
3. **Strips prefix** — `setComposerText(prompt)` on the ProseMirror/contenteditable surface.
4. **Resubmits** — after 32ms, synthetic Enter or send-button click (`allowNativeSubmit` flag skips re-interception).

**Conversation ID resolution**

- Portal: `data-above-composer-conversation-id`, `data-above-composer-portal`
- URL patterns: `/local/:id`, `/thread/:id`, `/hotkey-window/thread/:id`
- Fallback heuristics when DOM hints exist but UUID not found

**Model context**

- `list-models-for-host` + `read-config-for-host` (cached 60s) to validate effort levels per model and toast on unsupported combos.

---

## 3. Research path

We did not guess API names from the SDK alone. Investigation followed the chain the **UI uses**, then compared the plugin’s path.

### Phase 1 — “Same API as the dropdown?”

Traced UI reasoning-effort change in extracted chunks:

| Chunk | Finding |
|-------|---------|
| `use-model-settings-B1SsY8bO.js` | Dropdown calls `update-thread-settings-for-next-turn` when `conversationId` exists and thread is in manager (`sC` = `gw[conversationId] != null`). Otherwise `set-default-model-config-for-host`. |
| `app-main-B-r-lCO_.js` | Bridge handler delegates to `manager.updateThreadSettingsForNextTurn`. |
| `thread-context-inputs-BhGjWqLR.js` | `updateThreadSettingsForNextTurn` merges via `Zu()` into `latestThreadSettings` and `latestCollaborationMode.settings.reasoning_effort`; turn start calls `waitForPendingThreadSettingsUpdate`. |

**Decision:** Use `update-thread-settings-for-next-turn` for existing threads — API choice was correct.

### Phase 2 — “Why doesn’t rollout effort change?”

User verified session `019ee99e-ede5-7e40-84c4-b1d606e6dabb`: prefix stripping worked; `turn_context.payload.effort` stayed `high` unless effort was changed in the Codex UI.

That split symptom (message text OK, effort wrong) pointed away from “wrong bridge type” and toward **submit timing / what gets attached to the turn**.

### Phase 3 — Map composer send lifecycle

User asked to map `start-conversation` vs `send-follow-up-message` vs `start-turn-for-host` and hook official paths. Full map lives in [composer-message-lifecycle.md](./composer-message-lifecycle.md). Summary:

- **Composer Enter does not use `send-follow-up-message`** (MCP tools, avatar overlay, etc. only).
- **New thread** (`followUp === undefined`): `start-conversation`.
- **Existing local thread**: `start-turn-for-host` or `steer-turn-for-host` (queue path enqueues without immediate turn API).
- Composer always sends `params.effort: null` and relies on **`collaborationMode`** for effort on the wire.

### Phase 4 — React vs manager

Traced effort at submit time:

```
use-model-settings → reasoningEffort (signal et / manager)
use-collaboration-mode → activeMode.settings.reasoning_effort
composer gg() → collaborationMode: context ?? activeCollaborationMode
start-turn-for-host → effort null; rollout reads collaborationMode.settings.reasoning_effort
```

**Insight:** `await bridge.send(update-thread-settings)` updates the **manager** immediately, but submit reads a **React snapshot** (`activeCollaborationMode`) that may still reflect the previous render if resubmit is immediate.

---

## 4. Verification

### Rollout watch

Effort on the wire is visible in session rollout JSONL:

```bash
tail -f ~/.codex/sessions/2026/06/21/rollout-*.jsonl \
  | jq -c 'select(.type=="turn_context") | {ts:.timestamp, effort:.payload.effort, model:.payload.model}'
```

Also relevant: `.payload.collaboration_mode.settings.reasoning_effort`.

### Session used

- Rollout: `rollout-2026-06-21T12-59-27-019ee99e-ede5-7e40-84c4-b1d606e6dabb.jsonl`
- Thread id: `019ee99e-ede5-7e40-84c4-b1d606e6dabb`

### Observed

| Behavior | Result |
|----------|--------|
| Prefix stripped from sent message | ✓ |
| `!m` / `!xh` changing `turn_context` effort | ✗ (stayed at UI default, e.g. `high`) |
| Changing effort in Codex dropdown then send | ✓ (rollout effort updates) |

---

## 5. What worked vs what did not

| Piece | Status | Notes |
|-------|--------|-------|
| Prefix parse (`!m hello`, longest-prefix match) | ✓ | Includes `xh` before `h` |
| Hint popover on `!` | ✓ | Model-aware level list |
| Bridge `update-thread-settings-for-next-turn` | ✓ (call succeeds) | Same API as UI |
| Manager `latestThreadSettings` after await | ✓ | RE confirms `Zu()` merge |
| Prefix stripped before send | ✓ | User-visible prompt clean |
| Effort on rollout / turn | ✗ | Stale `collaborationMode` at submit |
| Synthetic Enter resubmit | Fragile | PM uses internal `submit` event; not identical to user Enter |
| DOM `setComposerText` | Fragile | Submit reads ProseMirror doc via `getText()`, not `textContent` |

---

## 6. Root cause analysis

### Primary: stale React `collaborationMode` at submit time

Turn-start logic (`Rp` in `thread-context-inputs`) sets `params.effort` to **null** when `collaborationMode` is present (always for normal composer submits). Effort on the rollout comes from **`collaborationMode.settings.reasoning_effort`**, built from React hooks at submit time—not from a fresh manager read inside `gg()`.

**UI:** change effort → wait → send → React has re-rendered → correct effort on wire.

**Plugin v1:** `await` settings → strip → **32ms** synthetic submit → submit still uses **previous render’s** `activeCollaborationMode` → rollout shows old effort (e.g. `high`).

Manager was updated; the **submit path shipped the wrong snapshot**. This is the main bug.

### Secondary risks (not the main session finding)

1. **Synthetic resubmit** — ProseMirror keymap emits `submit` on Enter (`composer-controller-CNXNPPdo.js`); DOM `KeyboardEvent` may not always hit the same path.
2. **Text strip via DOM** — Official submit uses `composerController.getText()` from ProseMirror state; DOM-only edits can desync.
3. **No `sC` guard** — UI skips thread settings update if conversation not in manager atom `gw`; plugin always calls bridge when it has a UUID from URL/DOM.
4. **Queue / steer branches** — In-progress turn should use `steer-turn-for-host`; native submit handles this; synthetic path may not.

### Ruled out

- Wrong settings API name (`threadSettings.effort` matches UI).
- Composer sending explicit `effort` in params (intentionally `null`; effort via collaboration mode is by design).

---

## 7. Composer API mapping (key decision)

Early assumption: “maybe we should call `send-follow-up-message` like a follow-up API.” RE showed that was the wrong hook for composer Enter.

| API | Composer uses it? | Role |
|-----|-------------------|------|
| `update-thread-settings-for-next-turn` | Indirectly (dropdown; plugin) | Set effort for **next** turn only |
| `start-turn-for-host` | ✓ existing thread | Normal send |
| `steer-turn-for-host` | ✓ in-progress + steer | Interrupt-steer send |
| `start-conversation` | ✓ new thread only | Home / no `followUp` |
| `send-follow-up-message` | ✗ not composer | MCP / overlay; minimal context |

**Decision:** Hook **settings** with the dropdown API, then trigger **native composer submit** (not `send-follow-up-message`) so attachments and context stay intact.

Rejected for this feature:

- **`send-follow-up-message` path** — atomic settings+send but drops full context builder.
- **Plugin-owned `start-turn-for-host`** — full control but duplicates context/steer/queue logic.

Fix options under consideration:

- **Option A** — apply settings at submit time → strip → sync gate → native submit. See [§9](#9-fix-direction-option-a).
- **Option D (live apply + restore)** — apply settings while typing when prefix becomes valid; restore after send or when prefix removed/invalid; optional effort pill. See [§11](#11-option-d-live-apply--restore--pill). **Likely preferred** over A because it fixes the React sync race without heuristics at submit time.

---

## 8. Documentation decisions

During the session we moved knowledge out of chat into `docs/` (per later [AGENTS.md](../AGENTS.md) policy):

| Doc | Why created/updated |
|-----|---------------------|
| [composer-message-lifecycle.md](./composer-message-lifecycle.md) | User asked to map APIs and hook points; canonical reference for send/effort |
| [codex-architecture.md](./codex-architecture.md) | Added §9 cross-link to lifecycle doc |
| [AGENTS.md](../AGENTS.md) | Instruct agents to maintain docs; `research` / `document` → write/update `docs/` |
| **This file** | Session narrative: how we decided, what we tried, what’s next |

**Principle:** Architecture that affects plugin design should live in `docs/`, not only in issue comments or agent transcripts.

---

## 9. Fix direction: Option A

**Requirement:** Keep attachments, mentions, IDE context, queue/steer — use official `gg()` → `buildLocalContextForPrompt` → `handleSubmitLocal` path.

### Planned flow (not yet coded)

1. Intercept Enter / send when `!<level> <prompt>` matches.
2. `await update-thread-settings-for-next-turn` (existing thread) or `set-default-model-config-for-host` (new thread).
3. Strip prefix via **ProseMirror-safe** replace (equivalent to `composerController.setPromptText`, not DOM-only `execCommand`).
4. **Wait for React/manager sync** (see below).
5. Trigger **native** submit (ProseMirror submit path), not synthetic DOM Enter after 32ms.

### What “React/manager sync” means

Two layers:

| Layer | What updates | When plugin knows |
|-------|----------------|-------------------|
| **Manager** | `latestThreadSettings`, `latestCollaborationMode` via `Zu()` | When `await bridge.send(...)` resolves |
| **React** | `use-model-settings` → `use-collaboration-mode` → `activeCollaborationMode` | After subscribers re-render (next frame/tick) |

Bridge await = **manager sync**. It does **not** guarantee the composer’s React tree has recomputed `activeMode.settings.reasoning_effort` before submit runs.

**React/manager sync** = manager updated **and** composer submit will read fresh `reasoning_effort` in `collaborationMode` (because React caught up).

**Planned sync strategies (combine bridge await + one of):**

- **Render cycle wait** — `requestAnimationFrame` (×2) + microtask, then native submit.
- **UI signal poll** — wait until `[data-selected-reasoning-effort]` (intelligence trigger) matches intended effort.
- **Optional:** mirror React Query invalidation like `use-model-settings` (heavier; only if polling insufficient).

We are **not** waiting on rollout JSONL on disk—that appears after turn start.

### Why not skip sync and pass effort explicitly?

Composer submit passes non-null `collaborationMode`; turn logic then forces `params.effort` to null and uses mode settings. Bypassing that without leaving the composer path means either syncing React or reimplementing context build (rejected).

---

## 10. Open questions and next steps

### Next implementation tasks (Option D track)

- [x] Live apply on valid prefix (`!xh ` / `!xh` + prompt); debounce bridge calls (`plugins/reasoning-effort-prefix/index.js` v2.1.0)
- [x] Restore previous effort on send (microtask + rAF after strip), delete, or invalid prefix
- [x] Plaintext prefix in composer (no above-composer chip; intelligence UI shows effort)
- [x] Strip prefix on send in capture phase; native Enter when already armed
- [x] Add `sC`-style guard for thread settings (requires live `codex.getThreadConversation` before invoking the fiber setter)
- [x] Effort apply fixed (v2.2.0) — in-renderer fiber setter, verified live (indicator moves; turn streams at applied effort). Disk `turn_context.effort` re-check pending (see §12 caveat).

### Option A tasks (fallback if D insufficient)

- [ ] Sync gate + native submit at Enter intercept
- [ ] PM-safe strip at submit time

### Open questions

- Does `[data-selected-reasoning-effort]` update synchronously after `update-thread-settings-for-next-turn`, or only after dropdown-driven flows?
- Is double `rAF` sufficient on Apple Silicon / Electron 42, or do we need poll-with-timeout?
- Should we update intelligence trigger / query cache explicitly for snappier UI feedback?

## 11. Option D: Live apply + restore + pill

> Proposed 2026-06-21 after Option A discussion. Addresses the React/manager sync race by **separating settings apply from send by seconds of typing time**, not milliseconds.

### Idea

When the composer text has a **valid** leading prefix (`!xh`, `!m`, … — not `!xxx`):

1. **Immediately** call `update-thread-settings-for-next-turn` (same as intelligence dropdown).
2. UI should reflect it — `[data-codex-intelligence-trigger]` / `data-selected-reasoning-effort` updates after React re-render.
3. **Transform** the prefix into a visible **pill** (“Extra High” + icon); remove raw `!xh` from the prompt body the user edits.
4. User types the rest of the message; sends with normal Enter (no plugin resubmit hack).
5. **Restore** previous thinking level when:
   - message is **sent** (after turn has consumed the elevated effort), or
   - prefix is **deleted** / text no longer has a valid prefix, or
   - prefix becomes **invalid** (unknown `!foo`).

Invalid prefixes (`!xxx`) never arm the feature — only catalog entries in [prefix map](#quick-reference--prefix-map).

### Why this fixes the bug

| Option A | Option D |
|----------|----------|
| Settings + send in one gesture | Settings applied while user still types |
| Must guess when React caught up | React/UI sync during typing; send uses already-updated `activeCollaborationMode` |
| Intercept Enter + resubmit | Native Enter; plugin only restores after |

### Restore timing on send (critical)

Restore must **not** run before the turn reads effort:

```
WRONG:  apply xhigh → user Enter → restore high immediately → turn sees high
RIGHT:  apply xhigh → user Enter → native submit/turn start → then restore high
```

Use `update-thread-settings-for-next-turn` to restore **after** submit is dispatched (e.g. next macrotask / short delay / conversation turn-started signal if available). Same API as apply — “next turn” after restore means the *following* message uses old level, which matches “this message only” semantics.

### State machine (sketch)

```
IDLE
  → user types valid prefix → ARMED (savedPreviousEffort, appliedEffort, show pill, strip prefix from text)
ARMED
  → user edits away / invalid prefix → IDLE (restore if applied)
  → user sends → SENDING (native submit)
SENDING
  → turn started → IDLE (restore previous effort, hide pill)
```

### Pill UI — feasibility

Codex composer is **ProseMirror** with custom nodes (`atMention`, `skillMention`, …). Plugins **cannot** register new PM node types without patching Codex bundles.

**Recommended (v2): portal pill, not inline PM node**

1. When prefix validates, strip `!xh` from composer via PM-safe `setPromptText` (remainder only).
2. Mount a chip in **`aboveComposer`** portal (SDK zone): icon + “Extra High” + optional “next message” hint.
3. Style to match Codex: `components.badge()` / custom chip using `--color-*` tokens; icon from Codex intelligence trigger SVG or a simple sparkle/brain SVG inline.

**Harder: true inline pill replacing `!xh` in the text flow**

- Would need PM decoration widget or custom node (not available from plugin).
- Fallback: absolutely positioned overlay aligned to prefix `getBoundingClientRect()` — fragile on wrap/scroll/resize.

**UX compromise users may accept:** pill sits directly above the input (visually attached), composer text is clean prompt only — functionally “`!xh` became a pill” without fighting ProseMirror.

### Debouncing

Avoid bridge spam while user types `!` → `!x` → `!xh`:

- Apply only when `parsePrefix()` returns a **complete** valid level (catalog match).
- Optional: require trailing space or non-empty prompt before apply (`!xh ` or `!xh hello`).
- Revert without apply if user backs out to `!x` before completing `!xh`.

### Open questions (Option D)

- Does intelligence trigger update when settings change from bridge only (not dropdown click)? RE suggests yes via signal `et` — verify in app.
- Restore on send: **implemented** as `queueMicrotask` + `requestAnimationFrame` after prefix strip (effort already read synchronously in `gg()`).
- New-thread path: `set-default-model-config-for-host` on apply; restore on send/delete/teardown (no fixed 1500ms timeout).

### v2.0.0 implementation (2026-06-21)

Plugin `reasoning-effort-prefix.js` Option D:

1. **Input** — debounced `applyLive()` when `parsePrefix()` matches catalog; disarm + restore when prefix removed/invalid.
2. **Send** — capture-phase strip to prompt-only; `scheduleRestoreAfterSubmit()`; native Enter if already armed and debounce flushed.
3. **Fallback** — if user sends before debounce fires, flush apply + one synthetic Enter/click (same rare path as Option A resubmit, without re-applying at send time).
4. **UI** — plaintext `!xh` stays visible while typing; hint popover unchanged; no portal chip.

### Changelog (this doc)

| Date | Update |
|------|--------|
| 2026-06-21 | Initial session log: v1 behavior, RE, root cause, Option A plan |
| 2026-06-21 | Added Option D: live apply + restore + pill; preferred over A |
| 2026-06-21 | Implemented Option D v2.0.0: live apply, plaintext prefix, strip-on-send, post-submit restore |
| 2026-06-21 | Moved plugin docs to `plugins/reasoning-effort-prefix/README.md`; cancelled stale debounced apply after prefix removal |

---

## 12. Real root cause + fix (v2.2.0, 2026-06-21)

> The §6 "stale React `collaborationMode`" theory was **wrong**. Live debugging via Chrome DevTools (CDP on `:9333`) found the actual bug one layer lower, in the SDK bridge itself.

### Real root cause: broken router capture → silent IPC fallback

1. The SDK tries to capture the in-renderer AppServer `send` at injection time by patching `Function.prototype.call/apply` (top of `sdk/explodex-sdk.js`). This **fails**: injection happens *after* app load, and the router's methods are invoked directly (not via `.call/.apply`), so the hook never fires. Result: `window.__explodexAppServerSend` is never bound — confirmed live as `appServerSend: false`.
2. With no captured router, `bridge.send(...)` falls back to `electronBridge.sendMessageFromView`. That IPC path routes to the **main-process** AppServer and **does not** update the **in-renderer** manager / Jotai atoms the composer reads at submit time.
3. So `update-thread-settings-for-next-turn` over the bridge "succeeds" but the effort never reaches the turn. Proven live: sending it via `electronBridge` left `[data-selected-reasoning-effort]` unchanged.

This also explains why the dropdown worked but the plugin didn't: the dropdown calls an in-renderer React callback directly; it never touches the broken bridge path.

### The fix: drive the in-renderer callback via fiber walk

Added a `codex` namespace to the SDK (`sdk/explodex-sdk.js`) exposed on `Explodex.codex`:

- `getThreadConversation(id)` / `getThreadModel(id)` / `getThreadEffort(id)` — read the live conversation-state object from the React fiber tree (scan hook states + props for `{ id, latestThreadSettings }`).
- `applyThreadSettingsForNextTurn(id, { model, effort })` — locate the dropdown's `useCallback` setter and invoke it. The setter is matched precisely: its source contains the literal `"update-thread-settings-for-next-turn"` and its dependency array's first entry is the bound `conversationId`. This updates the **same atoms** the composer ships, so effort reaches the turn.

The plugin (`plugins/reasoning-effort-prefix/index.js` v2.2.0) now:

- `pushThreadEffort` calls `codex.applyThreadSettingsForNextTurn` instead of `bridge.send`. It reads the **current** model from `codex.getThreadModel` first, so an effort-only change never alters the model.
- `pushThreadEffort` now refuses to apply unless `codex.getThreadConversation(conversationId)` finds live thread state, approximating the UI's `sC` loaded-thread guard before touching settings.
- `fetchModelContext` prefers `codex.getThreadModel(activeConversationId)` and `codex.getThreadEffort(activeConversationId)` over the unreliable bridge reads.
- New-thread path (`pushDefaultEffort`) still uses the bridge as a best-effort fallback (separate, lower-priority problem).

### Hint-on-space fix

`shouldShowHint` now returns `false` as soon as a space follows the prefix (e.g. `!m `), so the popover closes when the user starts typing the prompt (previously it stayed open until a non-empty prompt existed).

### Verification (live, via CDP)

- `Explodex.codex.applyThreadSettingsForNextTurn(convId, {effort:"medium"})` → returns `true`, moves the live indicator `xhigh → medium`, model unchanged. The broken bridge path left it untouched.
- Typing `!m …` through the plugin: indicator → `medium`; hint popover closed after the space; Enter stripped the prefix and a real turn **streamed with the effort atom at `medium`**.
- **Rollout JSONL caveat:** could not capture `turn_context.effort` from disk for this specific dev conversation — CDP-driven sends to it did not persist under `~/.codex/sessions` (turns from other conversations do persist). Since the fix drives the exact same in-renderer callback/atom as a manual dropdown selection (indicator verified moving), the shipped effort is equivalent to a manual UI change. Re-confirm with `jq` on `turn_context.effort` during a normal hand-typed session when convenient.

### Tooling

Live debugging used two Bun CDP helpers in `~/Projects/agent-scripts`: `cdp-eval.ts` (eval JS in the renderer) and `cdp-key.ts` (trusted `Input.insertText` + `Input.dispatchKeyEvent`, needed because synthetic DOM `KeyboardEvent`s are untrusted and don't trigger ProseMirror submit).

### Changelog addendum

| Date | Update |
|------|--------|
| 2026-06-21 | v2.2.0: real root cause (broken router capture → IPC fallback); fix via fiber-walk `Explodex.codex` setter; hint closes on space; effort read from live thread model |
| 2026-06-22 | Hardened v2.2.0 plugin lifecycle: loaded-thread guard, live effort baseline restore, stale async input/hint cancellation, and unload restore |

---

## Quick reference — prefix map

| Prefix | Effort value | Label |
|--------|--------------|-------|
| `!xh` | `xhigh` | Extra High |
| `!h` | `high` | High |
| `!m` | `medium` | Medium |
| `!l` | `low` | Low |
| `!max` | `max` | Max |
| `!min` | `minimal` | Minimal |

Example: `!m explain this function` → send `explain this function` with medium effort for that turn only.
