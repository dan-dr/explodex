/**
 * Explodex plugin: Effort Shortcuts
 *
 * Set reasoning effort from the composer — type !m or !xh, stripped on send,
 * restored after. Prefix stays plaintext in the composer; stripped on send.
 * Native Enter / send button — no synthetic resubmit except a rare
 * debounce-flush fallback.
 */
(function registerEffortShortcuts(global) {
  const BC = global.Explodex;
  if (!BC?.plugins?.register) {
    console.warn("[effort-shortcuts] Explodex SDK not loaded");
    return;
  }

  const DEFAULT_HOST_ID = "local";
  const MODELS_LIMIT = 100;
  const CACHE_MS = 60_000;
  const APPLY_DEBOUNCE_MS = 120;
  const RESTORE_AFTER_SUBMIT_MS = 1_500;

  const LEVEL_CATALOG = [
    { prefix: "xh", effort: "xhigh", label: "Extra High" },
    { prefix: "h", effort: "high", label: "High" },
    { prefix: "m", effort: "medium", label: "Medium" },
    { prefix: "l", effort: "low", label: "Low" },
    { prefix: "max", effort: "max", label: "Max" },
    { prefix: "min", effort: "minimal", label: "Minimal" },
  ];

  const LEVEL_BY_EFFORT = Object.fromEntries(LEVEL_CATALOG.map((l) => [l.effort, l]));
  const PREFIX_ORDER = [...LEVEL_CATALOG].sort((a, b) => b.prefix.length - a.prefix.length);

  BC.plugins.register(
    {
      id: "effort-shortcuts",
      name: "Effort Shortcuts",
      version: "2.3.0",
      dynamicLoadable: true,
      dynamicUnloadable: true,
    },
    (api) => {
      const { composer, bridge, codex, ui, components: c, log, storage, registerOptions } = api;
      log.info("setup start (option D)");

      const SETTINGS_KEY = "explodex-effort-shortcuts";
      const ALL_PREFIXES = LEVEL_CATALOG.map((level) => level.prefix);

      api.migrate([
        {
          id: "rename-keys-from-reasoning-effort-prefix",
          run: ({ renameKey }) =>
            renameKey("explodex-reasoning-effort-prefix", SETTINGS_KEY),
        },
      ]);

      function defaultSettings() {
        return {
          enabledPrefixes: [...ALL_PREFIXES],
          showHint: true,
          stripOnSend: true,
          restoreAfterSend: true,
        };
      }

      function normalizeSettings(raw) {
        const base = defaultSettings();
        if (!raw || typeof raw !== "object") return base;
        const enabledPrefixes = Array.isArray(raw.enabledPrefixes)
          ? ALL_PREFIXES.filter((prefix) => raw.enabledPrefixes.includes(prefix))
          : base.enabledPrefixes;
        return {
          enabledPrefixes: enabledPrefixes.length ? enabledPrefixes : base.enabledPrefixes,
          showHint: raw.showHint !== false,
          stripOnSend: raw.stripOnSend !== false,
          restoreAfterSend: raw.restoreAfterSend !== false,
        };
      }

      let settings = normalizeSettings(storage.persisted.get(SETTINGS_KEY, null));

      function saveSettings() {
        storage.persisted.set(SETTINGS_KEY, settings);
      }

      function loadSettings() {
        settings = normalizeSettings(storage.persisted.get(SETTINGS_KEY, null));
      }

      function isPrefixEnabled(prefix) {
        return settings.enabledPrefixes.includes(prefix);
      }

      function renderOptionsPanel(container) {
        container.replaceChildren();
        const fields = LEVEL_CATALOG.map((level) =>
          c.checkboxField({
            label: `!${level.prefix} — ${level.label}`,
            checked: settings.enabledPrefixes.includes(level.prefix),
            onChange: (checked) => {
              const next = new Set(settings.enabledPrefixes);
              if (checked) next.add(level.prefix);
              else next.delete(level.prefix);
              settings.enabledPrefixes = ALL_PREFIXES.filter((prefix) => next.has(prefix));
              saveSettings();
            },
          }),
        );
        fields.push(
          c.checkboxField({
            label: "Show thinking-level hint",
            checked: settings.showHint,
            onChange: (value) => {
              settings.showHint = value;
              saveSettings();
              if (!value && hintOpen) closeHint();
            },
          }),
        );
        fields.push(
          c.checkboxField({
            label: "Strip prefix when sending",
            checked: settings.stripOnSend,
            onChange: (value) => {
              settings.stripOnSend = value;
              saveSettings();
              renderOptionsPanel(container);
            },
          }),
        );
        if (!settings.stripOnSend) {
          fields.push(
            c.metaText("Prefix text will remain in the sent message when stripping is disabled."),
          );
        }
        fields.push(
          c.checkboxField({
            label: "Restore previous effort after send",
            checked: settings.restoreAfterSend,
            onChange: (value) => {
              settings.restoreAfterSend = value;
              saveSettings();
            },
          }),
        );
        container.appendChild(c.fieldStack(fields));
      }

      registerOptions({ render: renderOptionsPanel });
      loadSettings();

      let modelCache = { at: 0, model: null, effort: null, levels: [], models: [] };
      let hintOpen = false;
      let armed = null;
      let applyDebounceTimer = null;
      let pendingApplyGeneration = 0;
      let pendingRestoreAfterSubmit = false;
      let allowNativeSubmitOnce = false;
      let suppressDisarmOnInput = false;
      let restoring = false;
      let observer = null;
      let boundInput = null;
      let onSelectionChange = null;
      let restoreAfterSubmitTimer = null;
      let disposed = false;
      let lastInputSyncId = 0;

      function getHostId() {
        const portal = document.querySelector("[data-above-composer-portal]");
        const fromPortal =
          portal?.getAttribute("data-above-composer-host-id") ??
          portal?.getAttribute("data-host-id");
        if (fromPortal) return fromPortal;

        const path = global.location?.pathname ?? "";
        const remote = path.match(/\/remote\/([^/]+)/);
        if (remote) return decodeURIComponent(remote[1]);

        return DEFAULT_HOST_ID;
      }

      function isComposerFocused() {
        const input = composer.getInput();
        if (!input) return false;
        return document.activeElement === input || input.contains(document.activeElement);
      }

      const CONVERSATION_ID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      function normalizeConversationId(value) {
        if (value == null) return null;
        const id = String(value).trim();
        if (!id || id === "undefined" || id === "null") return null;
        return CONVERSATION_ID_RE.test(id) ? id : null;
      }

      function conversationIdFromPath(pathname) {
        const path = pathname ?? "";
        const patterns = [
          /\/local\/([^/]+)/,
          /\/thread\/([^/]+)/,
          /\/hotkey-window\/thread\/([^/]+)/,
        ];
        for (const pattern of patterns) {
          const match = path.match(pattern);
          const id = normalizeConversationId(match?.[1] ? decodeURIComponent(match[1]) : null);
          if (id) return id;
        }
        return null;
      }

      function conversationIdFromPortals(focusedInput = null) {
        const portals = [
          ...document.querySelectorAll("[data-above-composer-portal]"),
          ...document.querySelectorAll("[data-above-composer-queue-portal]"),
          ...document.querySelectorAll("[data-above-composer-conversation-id]"),
        ];

        if (focusedInput) {
          for (const portal of portals) {
            if (!portal.contains(focusedInput)) continue;
            const id = normalizeConversationId(
              portal.getAttribute("data-above-composer-conversation-id"),
            );
            if (id) return id;
          }
        }

        for (const portal of portals) {
          const id = normalizeConversationId(
            portal.getAttribute("data-above-composer-conversation-id"),
          );
          if (id) return id;
        }
        return null;
      }

      function getConversationId() {
        const input = composer.getInput();
        const fromPortal = conversationIdFromPortals(input);
        if (fromPortal) return fromPortal;

        const fromPath = conversationIdFromPath(global.location?.pathname ?? "");
        if (fromPath) return fromPath;

        return null;
      }

      function isLikelyActiveThread() {
        if (getConversationId()) return true;
        return Boolean(
          document.querySelector('[data-thread-scroll-footer="true"]') ||
            document.querySelector("[data-local-conversation-item-target-ids]") ||
            document.querySelector('[class*="local-conversation" i]'),
        );
      }

      function normalizeModelsPayload(body) {
        if (!body) return { models: [], defaultModel: null };
        if (Array.isArray(body.models)) return body;
        if (Array.isArray(body.data)) return { models: body.data, defaultModel: body.defaultModel ?? null };
        if (Array.isArray(body?.data?.data)) {
          return { models: body.data.data, defaultModel: body.data.defaultModel ?? null };
        }
        return { models: [], defaultModel: null };
      }

      function supportedEffortsForModel(models, modelId) {
        const entry = models.find((m) => m.model === modelId);
        if (!entry?.supportedReasoningEfforts?.length) {
          return LEVEL_CATALOG.map((l) => l.effort);
        }
        return entry.supportedReasoningEfforts
          .map((e) => e.reasoningEffort ?? e.effort)
          .filter(Boolean);
      }

      async function fetchModelContext(force = false) {
        const now = Date.now();
        if (!force && now - modelCache.at < CACHE_MS && modelCache.model) {
          return modelCache;
        }

        if (disposed || !bridge.isAvailable()) {
          return modelCache;
        }

        try {
          const hostId = getHostId();
          const [modelsRes, configRes] = await Promise.all([
            bridge.send("list-models-for-host", {
              hostId,
              includeHidden: true,
              cursor: null,
              limit: MODELS_LIMIT,
            }),
            bridge.send("read-config-for-host", {
              hostId,
              includeLayers: false,
              cwd: null,
            }),
          ]);

          const { models, defaultModel } = normalizeModelsPayload(modelsRes);
          const config = configRes?.config ?? configRes ?? {};
          // Prefer the active thread's live model (from the renderer fiber state)
          // so effort-only changes never alter the model. The IPC bridge reads
          // below are unreliable in current builds and only used as fallback.
          const activeConversationId = getConversationId();
          const activeModel = activeConversationId
            ? codex?.getThreadModel?.(activeConversationId)
            : null;
          const activeEffort = activeConversationId
            ? codex?.getThreadEffort?.(activeConversationId)
            : null;
          const currentModel =
            activeModel ??
            config.model ??
            defaultModel?.model ??
            models.find((m) => m.isDefault)?.model ??
            "gpt-5.5";
          const currentEffort =
            activeEffort ??
            config.model_reasoning_effort ??
            defaultModel?.defaultReasoningEffort ??
            "medium";
          const supported = new Set(supportedEffortsForModel(models, currentModel));
          const levels = LEVEL_CATALOG.filter((l) => supported.has(l.effort));

          modelCache = {
            at: now,
            model: currentModel,
            effort: currentEffort,
            levels: levels.length ? levels : LEVEL_CATALOG,
            models,
          };
        } catch (err) {
          console.warn("[effort-shortcuts] model context fetch failed", err);
        }

        return modelCache;
      }

      function parsePrefix(text) {
        const trimmed = text.trimStart();
        if (!trimmed.startsWith("!")) return null;

        const body = trimmed.slice(1);
        for (const level of PREFIX_ORDER) {
          if (!isPrefixEnabled(level.prefix)) continue;
          const re = new RegExp(`^${level.prefix}(?:\\s+|$)`, "i");
          if (!re.test(body)) continue;
          const consumed = 1 + level.prefix.length;
          const prompt = trimmed.slice(consumed).replace(/^\s+/, "");
          return { level, prompt };
        }
        return null;
      }

      function shouldShowHint(text) {
        if (!settings.showHint) return false;
        const trimmed = text.trimStart();
        if (!trimmed.startsWith("!")) return false;
        if (trimmed === "!") return true;

        const partial = trimmed.slice(1);
        // Once a space follows the prefix (e.g. "!m "), the user has committed to
        // the level and is writing their prompt — close the hint popover.
        if (/\s/.test(partial)) return false;

        return PREFIX_ORDER.some(
          (l) => isPrefixEnabled(l.prefix) && l.prefix.startsWith(partial.toLowerCase()),
        );
      }

      const HINT_WIDTH = 320;

      function getComposerCaretRect(input) {
        if (!input) return null;

        if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
          const sel = input.selectionStart ?? input.value.length;
          const style = global.getComputedStyle(input);
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.font = style.font;
            const textWidth = ctx.measureText(input.value.slice(0, sel)).width;
            const inputRect = input.getBoundingClientRect();
            const padLeft = Number.parseFloat(style.paddingLeft) || 0;
            const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
            const left = inputRect.left + padLeft + borderLeft + textWidth;
            return {
              left,
              top: inputRect.top,
              right: left,
              bottom: inputRect.bottom,
              width: 0,
              height: inputRect.height,
            };
          }
        }

        const sel = global.getSelection();
        if (!sel?.rangeCount) return null;
        const range = sel.getRangeAt(0);
        if (!input.contains(range.commonAncestorContainer)) return null;

        const rect = range.getBoundingClientRect();
        if (rect.width || rect.height) return rect;

        const rects = range.getClientRects();
        if (rects.length > 0) return rects[0];

        return rect;
      }

      function hintAnchorRect() {
        const input = composer.getInput();
        return getComposerCaretRect(input) ?? input?.getBoundingClientRect?.() ?? null;
      }

      function readBaselineEffort() {
        const trigger = document.querySelector("[data-codex-intelligence-trigger]");
        const fromUi = trigger?.getAttribute("data-selected-reasoning-effort");
        if (fromUi) return fromUi;
        const conversationId = getConversationId();
        const fromThread = conversationId ? codex?.getThreadEffort?.(conversationId) : null;
        if (fromThread) return fromThread;
        return modelCache.effort ?? "medium";
      }

      function setComposerText(text) {
        const input = composer.getInput();
        if (!input) return false;

        input.focus();

        if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
          input.value = text;
          input.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
          );
          return true;
        }

        const sel = global.getSelection();
        if (!sel) return false;
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertText", false, text);
        input.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
        );
        return true;
      }

      async function pushThreadEffort(effort, model, conversationId) {
        // Use the in-renderer callback (via fiber walk) rather than the IPC
        // bridge: the bridge routes to the main-process AppServer and never
        // updates the renderer atoms the composer ships at submit time.
        if (
          typeof codex?.applyThreadSettingsForNextTurn !== "function" ||
          typeof codex?.getThreadConversation !== "function"
        ) {
          throw new Error("in-renderer thread settings API unavailable");
        }
        if (!codex.getThreadConversation(conversationId)) {
          throw new Error("thread settings state unavailable for active thread");
        }
        const currentModel = codex?.getThreadModel?.(conversationId) ?? model;
        const ok = await codex.applyThreadSettingsForNextTurn(conversationId, {
          model: currentModel,
          effort,
        });
        if (!ok) {
          throw new Error("in-renderer thread settings update failed");
        }
        return { mode: "thread", conversationId };
      }

      async function pushDefaultEffort(effort, model) {
        const hostId = getHostId();
        await bridge.send("set-default-model-config-for-host", {
          hostId,
          model,
          reasoningEffort: effort,
          profile: null,
        });
        return { mode: "default-config" };
      }

      async function applyEffortToBridge(effort, model) {
        if (disposed) return null;
        const conversationId = getConversationId();

        if (conversationId) {
          return pushThreadEffort(effort, model, conversationId);
        }

        if (isLikelyActiveThread()) {
          throw new Error("Could not resolve conversation id for active thread");
        }

        return pushDefaultEffort(effort, model);
      }

      function disarm() {
        armed = null;
        pendingRestoreAfterSubmit = false;
      }

      async function restoreBaselineEffort({ force = false } = {}) {
        if (!armed || restoring) return;
        if ((!force && disposed) || !bridge.isAvailable()) {
          disarm();
          return;
        }

        restoring = true;
        const snapshot = armed;
        disarm();

        try {
          const model = snapshot.savedModel ?? modelCache.model ?? "gpt-5.5";
          if (snapshot.mode === "default-config") {
            await pushDefaultEffort(snapshot.savedEffort, model);
          } else {
            const conversationId = snapshot.conversationId ?? getConversationId();
            if (conversationId) {
              await pushThreadEffort(snapshot.savedEffort, model, conversationId);
            }
          }
          modelCache.at = 0;
          log.debug("restored baseline effort", { effort: snapshot.savedEffort });
        } catch (err) {
          console.warn("[effort-shortcuts] restore failed", err);
        } finally {
          restoring = false;
        }
      }

      async function applyLive(level) {
        if (disposed || !bridge.isAvailable()) return false;

        const ctx = await fetchModelContext();
        if (disposed) return false;
        if (!ctx.levels.some((l) => l.effort === level.effort)) {
          return false;
        }

        const model = ctx.model ?? "gpt-5.5";

        if (!armed) {
          armed = {
            savedEffort: readBaselineEffort(),
            savedModel: model,
            appliedEffort: null,
            appliedLevel: null,
            mode: null,
            conversationId: getConversationId(),
          };
        }

        if (armed.appliedEffort === level.effort) {
          return true;
        }

        try {
          const applied = await applyEffortToBridge(level.effort, model);
          if (disposed || !applied) return false;
          armed.appliedEffort = level.effort;
          armed.appliedLevel = level;
          armed.mode = applied.mode;
          armed.conversationId = applied.conversationId ?? armed.conversationId;
          armed.savedModel = model;
          log.debug("live apply", { effort: level.effort, mode: applied.mode });
          return true;
        } catch (err) {
          console.warn("[effort-shortcuts] live apply failed", err);
          if (!armed.appliedEffort) disarm();
          return false;
        }
      }

      function clearApplyDebounce() {
        if (applyDebounceTimer != null) {
          global.clearTimeout(applyDebounceTimer);
          applyDebounceTimer = null;
        }
      }

      function cancelPendingApply() {
        clearApplyDebounce();
        pendingApplyGeneration += 1;
      }

      function clearRestoreAfterSubmitTimer() {
        if (restoreAfterSubmitTimer != null) {
          global.clearTimeout(restoreAfterSubmitTimer);
          restoreAfterSubmitTimer = null;
        }
      }

      async function flushLiveApply(level) {
        clearApplyDebounce();
        pendingApplyGeneration += 1;
        return applyLive(level);
      }

      function scheduleLiveApply(level) {
        clearApplyDebounce();
        const generation = pendingApplyGeneration + 1;
        pendingApplyGeneration = generation;
        applyDebounceTimer = global.setTimeout(() => {
          applyDebounceTimer = null;
          if (pendingApplyGeneration !== generation) return;
          applyLive(level).catch((err) => {
            console.warn("[effort-shortcuts] debounced apply failed", err);
          });
        }, APPLY_DEBOUNCE_MS);
      }

      function markSubmitRestorePending() {
        if (armed) pendingRestoreAfterSubmit = true;
      }

      function scheduleRestoreAfterSubmit() {
        if (!settings.restoreAfterSend) return;
        markSubmitRestorePending();
        clearRestoreAfterSubmitTimer();
        restoreAfterSubmitTimer = global.setTimeout(() => {
          restoreAfterSubmitTimer = null;
          if (!pendingRestoreAfterSubmit) return;
          pendingRestoreAfterSubmit = false;
          restoreBaselineEffort().catch((err) => {
            console.warn("[effort-shortcuts] post-submit restore failed", err);
          });
        }, RESTORE_AFTER_SUBMIT_MS);
      }

      async function syncFromComposerText() {
        const syncId = (lastInputSyncId += 1);
        const text = composer.getText();
        const parsed = parsePrefix(text);

        refreshHintIfNeeded();

        if (!parsed) {
          cancelPendingApply();
          if (armed && !suppressDisarmOnInput && !pendingRestoreAfterSubmit) {
            await restoreBaselineEffort();
          }
          return;
        }

        const ctx = await fetchModelContext();
        if (disposed || syncId !== lastInputSyncId || composer.getText() !== text) return;
        if (!ctx.levels.some((l) => l.effort === parsed.level.effort)) {
          cancelPendingApply();
          if (armed) await restoreBaselineEffort();
          return;
        }

        scheduleLiveApply(parsed.level);
      }

      function stripPrefixForSubmit(prompt) {
        if (!settings.stripOnSend) return;
        suppressDisarmOnInput = true;
        setComposerText(prompt);
        closeHint();
        global.queueMicrotask(() => {
          suppressDisarmOnInput = false;
        });
      }

      function dispatchEnterOnComposer() {
        const input = composer.getInput();
        if (!input) return;
        const opts = {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        };
        input.dispatchEvent(new KeyboardEvent("keydown", opts));
        input.dispatchEvent(new KeyboardEvent("keypress", opts));
        input.dispatchEvent(new KeyboardEvent("keyup", opts));
      }

      async function prepareSubmitFromPrefix(submitButton = null) {
        const text = composer.getText();
        const parsed = parsePrefix(text);
        if (!parsed || !parsed.prompt.trim()) return false;

        if (!bridge.isAvailable()) {
          c.statusToast("Bridge unavailable — cannot set thinking level");
          return true;
        }

        const ctx = await fetchModelContext(true);
        if (!ctx.levels.some((l) => l.effort === parsed.level.effort)) {
          c.statusToast(`!${parsed.level.prefix} not supported by ${ctx.model ?? "current model"}`);
          return true;
        }

        const needsFlush =
          !armed || armed.appliedEffort !== parsed.level.effort || applyDebounceTimer != null;

        if (needsFlush) {
          const ok = await flushLiveApply(parsed.level);
          if (!ok) {
            c.statusToast("Failed to set thinking level");
            return true;
          }
        }

        if (settings.restoreAfterSend) markSubmitRestorePending();
        stripPrefixForSubmit(parsed.prompt);
        if (settings.restoreAfterSend) scheduleRestoreAfterSubmit();

        if (needsFlush) {
          allowNativeSubmitOnce = true;
          global.queueMicrotask(() => {
            if (submitButton) {
              submitButton.click();
              return;
            }
            dispatchEnterOnComposer();
          });
          return true;
        }

        return false;
      }

      function renderHintContent(ctx) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:8px";

        const meta = document.createElement("div");
        meta.style.cssText =
          "font-size:11px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 55%,transparent))";
        meta.textContent = ctx.model
          ? `Model: ${ctx.model} · current: ${LEVEL_BY_EFFORT[ctx.effort]?.label ?? ctx.effort}`
          : "Loading model info…";
        wrap.appendChild(meta);

        const list = document.createElement("pre");
        list.style.cssText =
          "margin:0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,currentColor 6%,transparent);" +
          "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap";
        list.textContent = ctx.levels.map((l) => `!${l.prefix} - ${l.label}`).join("\n");
        wrap.appendChild(list);

        const note = document.createElement("div");
        note.style.cssText =
          "font-size:11px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 50%,transparent))";
        note.textContent =
          "Effort applies while you type a valid prefix. Prefix is removed when you send.";
        wrap.appendChild(note);

        return wrap;
      }

      function stopHintTracking() {
        if (onSelectionChange) {
          document.removeEventListener("selectionchange", onSelectionChange);
          onSelectionChange = null;
        }
      }

      function startHintTracking() {
        if (onSelectionChange) return;
        onSelectionChange = () => {
          if (hintOpen) repositionHint();
        };
        document.addEventListener("selectionchange", onSelectionChange);
      }

      function closeHint() {
        hintOpen = false;
        stopHintTracking();
        ui.closePopover();
      }

      async function openHint() {
        const input = composer.getInput();
        if (!input) return;

        hintOpen = true;
        const ctx = await fetchModelContext(true);
        if (
          disposed ||
          !hintOpen ||
          input !== composer.getInput() ||
          !input.isConnected ||
          !shouldShowHint(composer.getText())
        ) {
          return;
        }
        ui.popover({
          anchor: input,
          anchorRect: hintAnchorRect(),
          side: "bottom",
          title: "Thinking levels",
          width: HINT_WIDTH,
          onClose: () => {
            hintOpen = false;
            stopHintTracking();
          },
          content: () => renderHintContent(ctx),
        });
        startHintTracking();
      }

      function repositionHint() {
        const input = composer.getInput();
        if (!input) return;
        ui.repositionPopover({
          anchor: input,
          anchorRect: hintAnchorRect(),
          side: "bottom",
          width: HINT_WIDTH,
        });
      }

      function refreshHintIfNeeded() {
        const text = composer.getText();
        if (shouldShowHint(text)) {
          if (!hintOpen) {
            openHint();
          } else {
            repositionHint();
          }
          return;
        }
        if (hintOpen) closeHint();
      }

      function isComposerSubmitClick(event) {
        const input = composer.getInput();
        if (!input) return false;

        const btn = event.target.closest?.("button");
        if (!btn || btn.disabled || btn.closest(".ex-popover")) return false;

        let node = input.parentElement;
        for (let depth = 0; depth < 14 && node; depth += 1) {
          if (node.contains(btn)) return true;
          node = node.parentElement;
        }

        const inputRect = input.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        if (!inputRect.width || !btnRect.width) return false;

        const nearComposer =
          Math.abs(btnRect.top - inputRect.bottom) < 140 &&
          btnRect.left >= inputRect.left - 80 &&
          btnRect.right <= inputRect.right + 220;
        return nearComposer && Boolean(btn.querySelector("svg"));
      }

      function onKeyDown(event) {
        if (allowNativeSubmitOnce) {
          allowNativeSubmitOnce = false;
          return;
        }
        if (!isComposerFocused()) return;
        if (event.key !== "Enter" || event.shiftKey) return;
        if (event.isComposing) return;

        const parsed = parsePrefix(composer.getText());
        if (!parsed) return;

        if (!parsed.prompt.trim()) {
          event.preventDefault();
          event.stopPropagation();
          c.statusToast(`Add a prompt after !${parsed.level.prefix}`);
          return;
        }

        const needsFlush =
          !armed || armed.appliedEffort !== parsed.level.effort || applyDebounceTimer != null;

        if (needsFlush) {
          event.preventDefault();
          event.stopPropagation();
          prepareSubmitFromPrefix().catch((err) => {
            console.warn("[effort-shortcuts] submit prepare failed", err);
            c.statusToast("Failed to prepare send");
          });
          return;
        }

        markSubmitRestorePending();
        stripPrefixForSubmit(parsed.prompt);
        if (settings.restoreAfterSend) scheduleRestoreAfterSubmit();
      }

      function onPointerDown(event) {
        if (allowNativeSubmitOnce) return;
        if (event.button !== 0) return;
        if (!isComposerSubmitClick(event)) return;

        const parsed = parsePrefix(composer.getText());
        if (!parsed || !parsed.prompt.trim()) return;

        const needsFlush =
          !armed || armed.appliedEffort !== parsed.level.effort || applyDebounceTimer != null;

        if (needsFlush) {
          event.preventDefault();
          event.stopPropagation();
          const btn = event.target.closest("button");
          prepareSubmitFromPrefix(btn).catch((err) => {
            console.warn("[effort-shortcuts] submit prepare failed", err);
            c.statusToast("Failed to prepare send");
          });
          return;
        }

        markSubmitRestorePending();
        stripPrefixForSubmit(parsed.prompt);
        if (settings.restoreAfterSend) scheduleRestoreAfterSubmit();
      }

      function onInput() {
        syncFromComposerText().catch((err) => {
          console.warn("[effort-shortcuts] sync failed", err);
        });
      }

      function bindComposerInput() {
        const input = composer.getInput();
        if (boundInput && !boundInput.isConnected) {
          boundInput.removeEventListener("input", onInput);
          boundInput = null;
        }
        if (!input || input === boundInput) return;
        if (boundInput) {
          boundInput.removeEventListener("input", onInput);
        }
        boundInput = input;
        boundInput.addEventListener("input", onInput);
      }

      function attach() {
        bindComposerInput();
        global.addEventListener("keydown", onKeyDown, true);
        global.addEventListener("pointerdown", onPointerDown, true);
        refreshHintIfNeeded();
      }

      function detach() {
        disposed = true;
        lastInputSyncId += 1;
        stopHintTracking();
        closeHint();
        cancelPendingApply();
        clearRestoreAfterSubmitTimer();
        global.removeEventListener("keydown", onKeyDown, true);
        global.removeEventListener("pointerdown", onPointerDown, true);
        if (boundInput) {
          boundInput.removeEventListener("input", onInput);
          boundInput = null;
        }
        observer?.disconnect();
        observer = null;
        restoreBaselineEffort({ force: true }).catch(() => {});
      }

      attach();
      log.info("composer listeners attached");
      observer = new MutationObserver(() => {
        bindComposerInput();
        if (isComposerFocused()) refreshHintIfNeeded();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });

      fetchModelContext(true)
        .then(() => log.debug("model context loaded"))
        .catch((err) => log.warn("model context fetch failed", err));

      log.info("setup complete");
      return () => {
        log.info("teardown");
        detach();
      };
    },
  );
})(window);
