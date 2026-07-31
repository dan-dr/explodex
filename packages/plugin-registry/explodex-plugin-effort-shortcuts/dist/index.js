var __ExplodexPluginBundle = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    default: () => index_default
  });

  // explodex-sdk-shim:explodex-sdk-shim.js
  function definePlugin(definition) {
    if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
      throw new TypeError("definePlugin requires a plugin definition object");
    }
    if (typeof definition.setup !== "function") {
      throw new TypeError("definePlugin requires setup(api)");
    }
    for (const key of Object.keys(definition)) {
      if (key !== "setup") {
        throw new TypeError('definePlugin does not accept unknown field "' + key + '"');
      }
    }
    return Object.freeze({
      setup: definition.setup,
      __explodexDefinedPlugin: true
    });
  }

  // src/model.ts
  var SETTINGS_KEY = "explodex-effort-shortcuts";
  var LEGACY_SETTINGS_KEY = "explodex-reasoning-effort-prefix";
  var DEFAULT_HOST_ID = "local";
  var LEVEL_CATALOG = [
    { prefix: "xh", effort: "xhigh", label: "Extra High" },
    { prefix: "h", effort: "high", label: "High" },
    { prefix: "m", effort: "medium", label: "Medium" },
    { prefix: "l", effort: "low", label: "Low" },
    { prefix: "max", effort: "max", label: "Max" },
    { prefix: "min", effort: "minimal", label: "Minimal" }
  ];
  var ALL_PREFIXES = LEVEL_CATALOG.map((level) => level.prefix);
  var LEVEL_BY_EFFORT = new Map(
    LEVEL_CATALOG.map((level) => [level.effort, level])
  );
  var PREFIX_ORDER = [...LEVEL_CATALOG].sort(
    (left, right) => right.prefix.length - left.prefix.length
  );
  function record(value) {
    return value !== null && typeof value === "object" ? value : null;
  }
  function defaultEffortShortcutSettings() {
    return {
      enabledPrefixes: [...ALL_PREFIXES],
      showHint: true,
      stripOnSend: true,
      restoreAfterSend: true
    };
  }
  function normalizeEffortShortcutSettings(raw) {
    const base = defaultEffortShortcutSettings();
    const value = record(raw);
    if (value === null) return base;
    const rawPrefixes = Array.isArray(value.enabledPrefixes) ? value.enabledPrefixes : null;
    const enabledPrefixes = rawPrefixes ? ALL_PREFIXES.filter((prefix) => rawPrefixes.includes(prefix)) : base.enabledPrefixes;
    return {
      enabledPrefixes: enabledPrefixes.length ? enabledPrefixes : base.enabledPrefixes,
      showHint: value.showHint !== false,
      stripOnSend: value.stripOnSend !== false,
      restoreAfterSend: value.restoreAfterSend !== false
    };
  }
  function parseEffortPrefix(text, settings) {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("!")) return null;
    const body = trimmed.slice(1);
    for (const level of PREFIX_ORDER) {
      if (!settings.enabledPrefixes.includes(level.prefix)) continue;
      const pattern = new RegExp(`^${level.prefix}(?:\\s+|$)`, "i");
      if (!pattern.test(body)) continue;
      const consumed = 1 + level.prefix.length;
      return {
        level,
        prompt: trimmed.slice(consumed).replace(/^\s+/, "")
      };
    }
    return null;
  }
  function shouldShowEffortHint(text, settings) {
    if (!settings.showHint) return false;
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("!")) return false;
    if (trimmed === "!") return true;
    const partial = trimmed.slice(1);
    if (/\s/.test(partial)) return false;
    const normalized = partial.toLowerCase();
    return PREFIX_ORDER.some(
      (level) => settings.enabledPrefixes.includes(level.prefix) && level.prefix.startsWith(normalized)
    );
  }
  var CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function normalizeConversationId(value) {
    if (value == null) return null;
    const id = String(value).trim();
    if (!id || id === "undefined" || id === "null") return null;
    return CONVERSATION_ID_RE.test(id) ? id : null;
  }
  function conversationIdFromPath(pathname) {
    const patterns = [
      /\/local\/([^/]+)/,
      /\/thread\/([^/]+)/,
      /\/hotkey-window\/thread\/([^/]+)/
    ];
    for (const pattern of patterns) {
      const match = pathname.match(pattern);
      const id = normalizeConversationId(
        match?.[1] ? decodeURIComponent(match[1]) : null
      );
      if (id) return id;
    }
    return null;
  }
  function modelDescriptions(value) {
    return Array.isArray(value) ? value.filter(
      (entry) => entry !== null && typeof entry === "object"
    ) : [];
  }
  function defaultModelDescription(value) {
    return value !== null && typeof value === "object" ? value : null;
  }
  function normalizeModelsPayload(body) {
    const root = record(body);
    if (root === null) return { models: [], defaultModel: null };
    if (Array.isArray(root.models)) {
      return {
        models: modelDescriptions(root.models),
        defaultModel: defaultModelDescription(root.defaultModel)
      };
    }
    if (Array.isArray(root.data)) {
      return {
        models: modelDescriptions(root.data),
        defaultModel: defaultModelDescription(root.defaultModel)
      };
    }
    const nested = record(root.data);
    return {
      models: modelDescriptions(nested?.data),
      defaultModel: defaultModelDescription(nested?.defaultModel)
    };
  }
  function supportedEffortsForModel(models, modelId) {
    const entry = models.find((model) => model.model === modelId);
    if (!entry?.supportedReasoningEfforts?.length) {
      return LEVEL_CATALOG.map((level) => level.effort);
    }
    return entry.supportedReasoningEfforts.flatMap((supported) => {
      const effort = supported.reasoningEffort ?? supported.effort;
      return effort ? [effort] : [];
    });
  }
  function hostIdFromPath(pathname) {
    const remote = pathname.match(/\/remote\/([^/]+)/);
    return remote?.[1] ? decodeURIComponent(remote[1]) : DEFAULT_HOST_ID;
  }

  // src/dom.ts
  function conversationIdFromPortals(document, focusedInput) {
    const portals = [
      ...document.querySelectorAll("[data-above-composer-portal]"),
      ...document.querySelectorAll("[data-above-composer-queue-portal]"),
      ...document.querySelectorAll("[data-above-composer-conversation-id]")
    ];
    if (focusedInput) {
      for (const portal of portals) {
        if (!portal.contains(focusedInput)) continue;
        const id = normalizeConversationId(
          portal.getAttribute("data-above-composer-conversation-id")
        );
        if (id) return id;
      }
    }
    for (const portal of portals) {
      const id = normalizeConversationId(
        portal.getAttribute("data-above-composer-conversation-id")
      );
      if (id) return id;
    }
    return null;
  }
  function hostIdFromPortal(document) {
    const portal = document.querySelector("[data-above-composer-portal]");
    return portal?.getAttribute("data-above-composer-host-id") ?? portal?.getAttribute("data-host-id") ?? null;
  }
  function textControl(element) {
    const tag = element.tagName.toLowerCase();
    if (tag !== "textarea" && tag !== "input" || !("value" in element)) {
      return null;
    }
    return element;
  }
  function composerCaretRect(runtime, input) {
    if (!input) return null;
    const control = textControl(input);
    if (control) {
      const selection2 = control.selectionStart ?? control.value.length;
      const style = runtime.getComputedStyle(input);
      const canvas = runtime.document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (context) {
        context.font = style.font;
        const width = context.measureText(control.value.slice(0, selection2)).width;
        const bounds2 = input.getBoundingClientRect();
        const left = bounds2.left + (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.borderLeftWidth) || 0) + width;
        return {
          left,
          top: bounds2.top,
          right: left,
          bottom: bounds2.bottom,
          width: 0,
          height: bounds2.height
        };
      }
    }
    const selection = runtime.getSelection();
    if (!selection?.rangeCount) return input.getBoundingClientRect();
    const range = selection.getRangeAt(0);
    if (!input.contains(range.commonAncestorContainer)) {
      return input.getBoundingClientRect();
    }
    const bounds = range.getBoundingClientRect();
    if (bounds.width || bounds.height) return bounds;
    return range.getClientRects()[0] ?? bounds;
  }
  function isComposerSubmitClick(input, target) {
    if (!input || !(target instanceof Element)) return null;
    const button = target.closest("button");
    if (!(button instanceof HTMLButtonElement)) return null;
    if (button.disabled || button.closest(".ex-popover")) return null;
    let node = input.parentElement;
    for (let depth = 0; depth < 14 && node; depth += 1) {
      if (node.contains(button)) return button;
      node = node.parentElement;
    }
    const inputRect = input.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (!inputRect.width || !buttonRect.width) return null;
    const nearby = Math.abs(buttonRect.top - inputRect.bottom) < 140 && buttonRect.left >= inputRect.left - 80 && buttonRect.right <= inputRect.right + 220;
    return nearby && button.querySelector("svg") ? button : null;
  }

  // src/runtime.ts
  var MODELS_LIMIT = 100;
  var CACHE_MS = 6e4;
  var APPLY_DEBOUNCE_MS = 120;
  var RESTORE_AFTER_SUBMIT_MS = 1500;
  var HINT_WIDTH = 320;
  var FALLBACK_MODEL = "gpt-5.5";
  function objectRecord(value) {
    return value !== null && typeof value === "object" ? value : {};
  }
  function reasoningEffort(value, fallback) {
    return typeof value === "string" && value ? value : fallback;
  }
  async function setupEffortShortcuts(api, runtime = globalThis) {
    const { bridge, codex, composer, components, log, registerOptions, storage, ui } = api;
    const document = runtime.document;
    log.info("setup start (option D)");
    await api.migrate([
      {
        id: "rename-keys-from-reasoning-effort-prefix",
        run: ({ renameKey }) => {
          renameKey(LEGACY_SETTINGS_KEY, SETTINGS_KEY);
        }
      }
    ]);
    let settings = loadSettings();
    let modelCache = {
      at: 0,
      model: null,
      effort: null,
      levels: [],
      models: []
    };
    let hintOpen = false;
    let armed = null;
    let applyDebounceTimer = null;
    let restoreAfterSubmitTimer = null;
    let pendingApplyGeneration = 0;
    let pendingRestoreAfterSubmit = false;
    let allowNativeSubmitOnce = false;
    let suppressDisarmOnInput = false;
    let restoring = false;
    let observer = null;
    let boundInput = null;
    let selectionListener = null;
    let disposed = false;
    let lastInputSyncId = 0;
    function loadSettings() {
      return normalizeEffortShortcutSettings(
        storage.persisted.get(SETTINGS_KEY, null)
      );
    }
    function saveSettings() {
      storage.persisted.set(SETTINGS_KEY, settings);
    }
    function renderOptionsPanel(container) {
      container.replaceChildren();
      const fields = LEVEL_CATALOG.map(
        (level) => components.checkboxField({
          label: `!${level.prefix} - ${level.label}`,
          checked: settings.enabledPrefixes.includes(level.prefix),
          onChange: (checked) => {
            const next = new Set(settings.enabledPrefixes);
            if (checked) next.add(level.prefix);
            else next.delete(level.prefix);
            settings.enabledPrefixes = ALL_PREFIXES.filter((prefix) => next.has(prefix));
            saveSettings();
          }
        })
      );
      fields.push(
        components.checkboxField({
          label: "Show thinking-level hint",
          checked: settings.showHint,
          onChange: (value) => {
            settings.showHint = value;
            saveSettings();
            if (!value && hintOpen) closeHint();
          }
        }),
        components.checkboxField({
          label: "Strip prefix when sending",
          checked: settings.stripOnSend,
          onChange: (value) => {
            settings.stripOnSend = value;
            saveSettings();
            renderOptionsPanel(container);
          }
        })
      );
      if (!settings.stripOnSend) {
        fields.push(
          components.metaText(
            "Prefix text will remain in the sent message when stripping is disabled."
          )
        );
      }
      fields.push(
        components.checkboxField({
          label: "Restore previous effort after send",
          checked: settings.restoreAfterSend,
          onChange: (value) => {
            settings.restoreAfterSend = value;
            saveSettings();
          }
        })
      );
      container.appendChild(components.fieldStack(fields));
    }
    registerOptions({ render: renderOptionsPanel });
    settings = loadSettings();
    function getHostId() {
      return hostIdFromPortal(document) ?? hostIdFromPath(runtime.location?.pathname ?? "") ?? DEFAULT_HOST_ID;
    }
    function getConversationId() {
      return conversationIdFromPortals(document, composer.getInput()) ?? conversationIdFromPath(runtime.location?.pathname ?? "");
    }
    function isLikelyActiveThread() {
      return Boolean(
        getConversationId() || document.querySelector('[data-thread-scroll-footer="true"]') || document.querySelector("[data-local-conversation-item-target-ids]") || document.querySelector('[class*="local-conversation" i]')
      );
    }
    function isComposerFocused() {
      const input = composer.getInput();
      return Boolean(
        input && (document.activeElement === input || input.contains(document.activeElement))
      );
    }
    async function fetchModelContext(force = false) {
      const now = Date.now();
      if (!force && now - modelCache.at < CACHE_MS && modelCache.model) {
        return modelCache;
      }
      if (disposed || !bridge.isAvailable()) return modelCache;
      try {
        const hostId = getHostId();
        const [modelsResponse, configResponse] = await Promise.all([
          bridge.send("list-models-for-host", {
            hostId,
            includeHidden: true,
            cursor: null,
            limit: MODELS_LIMIT
          }),
          bridge.send("read-config-for-host", {
            hostId,
            includeLayers: false,
            cwd: null
          })
        ]);
        const { models, defaultModel } = normalizeModelsPayload(modelsResponse);
        const configRoot = objectRecord(configResponse);
        const config = objectRecord(configRoot.config ?? configResponse);
        const conversationId = getConversationId();
        const currentModel = (conversationId ? codex.getThreadModel(conversationId) : null) ?? (typeof config.model === "string" ? config.model : null) ?? defaultModel?.model ?? models.find((model) => model.isDefault)?.model ?? FALLBACK_MODEL;
        const currentEffort = reasoningEffort(
          (conversationId ? codex.getThreadEffort(conversationId) : null) ?? config.model_reasoning_effort ?? defaultModel?.defaultReasoningEffort,
          "medium"
        );
        const supported = new Set(supportedEffortsForModel(models, currentModel));
        const levels = LEVEL_CATALOG.filter((level) => supported.has(level.effort));
        modelCache = {
          at: now,
          model: currentModel,
          effort: currentEffort,
          levels: levels.length ? levels : LEVEL_CATALOG,
          models
        };
      } catch (error) {
        log.warn("model context fetch failed", error);
      }
      return modelCache;
    }
    function readBaselineEffort() {
      const trigger = document.querySelector("[data-codex-intelligence-trigger]");
      const fromUi = trigger?.getAttribute("data-selected-reasoning-effort");
      const conversationId = getConversationId();
      return reasoningEffort(
        fromUi ?? (conversationId ? codex.getThreadEffort(conversationId) : null) ?? modelCache.effort,
        "medium"
      );
    }
    async function pushThreadEffort(effort, model, conversationId) {
      if (!codex.getThreadConversation(conversationId)) {
        throw new Error("thread settings state unavailable for active thread");
      }
      const currentModel = codex.getThreadModel(conversationId) ?? model;
      const updated = await codex.applyThreadSettingsForNextTurn(conversationId, {
        model: currentModel,
        effort
      });
      if (!updated) throw new Error("in-renderer thread settings update failed");
      return { mode: "thread", conversationId };
    }
    async function pushDefaultEffort(effort, model) {
      await bridge.send("set-default-model-config-for-host", {
        hostId: getHostId(),
        model,
        reasoningEffort: effort,
        profile: null
      });
      return { mode: "default-config" };
    }
    async function applyEffort(effort, model) {
      if (disposed) return null;
      const conversationId = getConversationId();
      if (conversationId) return pushThreadEffort(effort, model, conversationId);
      if (isLikelyActiveThread()) {
        throw new Error("Could not resolve conversation id for active thread");
      }
      return pushDefaultEffort(effort, model);
    }
    function disarm() {
      armed = null;
      pendingRestoreAfterSubmit = false;
    }
    async function restoreBaselineEffort(force = false) {
      if (!armed || restoring) return;
      if (!force && disposed || !bridge.isAvailable()) {
        disarm();
        return;
      }
      restoring = true;
      const snapshot = armed;
      disarm();
      try {
        const model = snapshot.savedModel ?? modelCache.model ?? FALLBACK_MODEL;
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
      } catch (error) {
        log.warn("restore failed", error);
      } finally {
        restoring = false;
      }
    }
    async function applyLive(level) {
      if (disposed || !bridge.isAvailable()) return false;
      const context = await fetchModelContext();
      if (disposed || !context.levels.some(({ effort }) => effort === level.effort)) {
        return false;
      }
      const model = context.model ?? FALLBACK_MODEL;
      if (!armed) {
        armed = {
          savedEffort: readBaselineEffort(),
          savedModel: model,
          appliedEffort: null,
          appliedLevel: null,
          mode: null,
          conversationId: getConversationId()
        };
      }
      if (armed.appliedEffort === level.effort) return true;
      try {
        const applied = await applyEffort(level.effort, model);
        if (disposed || !applied || !armed) return false;
        armed.appliedEffort = level.effort;
        armed.appliedLevel = level;
        armed.mode = applied.mode;
        armed.conversationId = applied.conversationId ?? armed.conversationId;
        armed.savedModel = model;
        log.debug("live apply", { effort: level.effort, mode: applied.mode });
        return true;
      } catch (error) {
        log.warn("live apply failed", error);
        if (!armed?.appliedEffort) disarm();
        return false;
      }
    }
    function clearApplyDebounce() {
      if (applyDebounceTimer === null) return;
      runtime.clearTimeout(applyDebounceTimer);
      applyDebounceTimer = null;
    }
    function cancelPendingApply() {
      clearApplyDebounce();
      pendingApplyGeneration += 1;
    }
    function scheduleLiveApply(level) {
      clearApplyDebounce();
      const generation = pendingApplyGeneration + 1;
      pendingApplyGeneration = generation;
      applyDebounceTimer = runtime.setTimeout(() => {
        applyDebounceTimer = null;
        if (pendingApplyGeneration !== generation) return;
        void applyLive(level);
      }, APPLY_DEBOUNCE_MS);
    }
    async function flushLiveApply(level) {
      clearApplyDebounce();
      pendingApplyGeneration += 1;
      return applyLive(level);
    }
    function clearRestoreTimer() {
      if (restoreAfterSubmitTimer === null) return;
      runtime.clearTimeout(restoreAfterSubmitTimer);
      restoreAfterSubmitTimer = null;
    }
    function markSubmitRestorePending() {
      if (armed) pendingRestoreAfterSubmit = true;
    }
    function scheduleRestoreAfterSubmit() {
      if (!settings.restoreAfterSend) return;
      markSubmitRestorePending();
      clearRestoreTimer();
      restoreAfterSubmitTimer = runtime.setTimeout(() => {
        restoreAfterSubmitTimer = null;
        if (!pendingRestoreAfterSubmit) return;
        pendingRestoreAfterSubmit = false;
        void restoreBaselineEffort();
      }, RESTORE_AFTER_SUBMIT_MS);
    }
    function stopHintTracking() {
      if (!selectionListener) return;
      document.removeEventListener("selectionchange", selectionListener);
      selectionListener = null;
    }
    function closeHint() {
      hintOpen = false;
      stopHintTracking();
      ui.closePopover();
    }
    function hintAnchorRect() {
      const input = composer.getInput();
      return composerCaretRect(runtime, input) ?? input?.getBoundingClientRect() ?? void 0;
    }
    function renderHintContent(context) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:8px";
      const meta = document.createElement("div");
      meta.style.cssText = "font-size:11px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 55%,transparent))";
      meta.textContent = context.model ? `Model: ${context.model} \xB7 current: ${LEVEL_BY_EFFORT.get(context.effort ?? "")?.label ?? context.effort}` : "Loading model info\u2026";
      const list = document.createElement("pre");
      list.style.cssText = "margin:0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,currentColor 6%,transparent);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap";
      list.textContent = context.levels.map((level) => `!${level.prefix} - ${level.label}`).join("\n");
      const note = document.createElement("div");
      note.style.cssText = "font-size:11px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 50%,transparent))";
      note.textContent = "Effort applies while you type a valid prefix. Prefix is removed when you send.";
      wrap.append(meta, list, note);
      return wrap;
    }
    function repositionHint() {
      const input = composer.getInput();
      if (!input) return;
      ui.repositionPopover({
        anchor: input,
        anchorRect: hintAnchorRect(),
        side: "bottom",
        width: HINT_WIDTH
      });
    }
    async function openHint() {
      const input = composer.getInput();
      if (!input) return;
      hintOpen = true;
      const context = await fetchModelContext(true);
      if (disposed || !hintOpen || input !== composer.getInput() || !input.isConnected || !shouldShowEffortHint(composer.getText(), settings)) {
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
        content: () => renderHintContent(context)
      });
      selectionListener = () => {
        if (hintOpen) repositionHint();
      };
      document.addEventListener("selectionchange", selectionListener);
    }
    function refreshHintIfNeeded() {
      if (shouldShowEffortHint(composer.getText(), settings)) {
        if (!hintOpen) void openHint();
        else repositionHint();
      } else if (hintOpen) {
        closeHint();
      }
    }
    async function syncFromComposerText() {
      const syncId = lastInputSyncId += 1;
      const text = composer.getText();
      const parsed = parseEffortPrefix(text, settings);
      refreshHintIfNeeded();
      if (!parsed) {
        cancelPendingApply();
        if (armed && !suppressDisarmOnInput && !pendingRestoreAfterSubmit) {
          await restoreBaselineEffort();
        }
        return;
      }
      const context = await fetchModelContext();
      if (disposed || syncId !== lastInputSyncId || composer.getText() !== text) return;
      if (!context.levels.some(({ effort }) => effort === parsed.level.effort)) {
        cancelPendingApply();
        if (armed) await restoreBaselineEffort();
        return;
      }
      scheduleLiveApply(parsed.level);
    }
    function stripPrefixForSubmit(prompt) {
      if (!settings.stripOnSend) return;
      suppressDisarmOnInput = true;
      composer.setText(prompt);
      closeHint();
      runtime.queueMicrotask(() => {
        suppressDisarmOnInput = false;
      });
    }
    function dispatchEnterOnComposer() {
      const input = composer.getInput();
      if (!input) return;
      const options = {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true
      };
      input.dispatchEvent(new KeyboardEvent("keydown", options));
      input.dispatchEvent(new KeyboardEvent("keypress", options));
      input.dispatchEvent(new KeyboardEvent("keyup", options));
    }
    async function prepareSubmitFromPrefix(submitButton = null) {
      const parsed = parseEffortPrefix(composer.getText(), settings);
      if (!parsed || !parsed.prompt.trim()) return false;
      if (!bridge.isAvailable()) {
        components.statusToast("Bridge unavailable - cannot set thinking level");
        return true;
      }
      const context = await fetchModelContext(true);
      if (!context.levels.some(({ effort }) => effort === parsed.level.effort)) {
        components.statusToast(
          `!${parsed.level.prefix} not supported by ${context.model ?? "current model"}`
        );
        return true;
      }
      const needsFlush = !armed || armed.appliedEffort !== parsed.level.effort || applyDebounceTimer !== null;
      if (needsFlush && !await flushLiveApply(parsed.level)) {
        components.statusToast("Failed to set thinking level");
        return true;
      }
      if (settings.restoreAfterSend) markSubmitRestorePending();
      stripPrefixForSubmit(parsed.prompt);
      if (settings.restoreAfterSend) scheduleRestoreAfterSubmit();
      if (needsFlush) {
        allowNativeSubmitOnce = true;
        runtime.queueMicrotask(() => {
          if (submitButton) submitButton.click();
          else dispatchEnterOnComposer();
        });
        return true;
      }
      return false;
    }
    const onKeyDown = (rawEvent) => {
      const event = rawEvent;
      if (allowNativeSubmitOnce) {
        allowNativeSubmitOnce = false;
        return;
      }
      if (!isComposerFocused() || event.key !== "Enter" || event.shiftKey || event.isComposing) {
        return;
      }
      const parsed = parseEffortPrefix(composer.getText(), settings);
      if (!parsed) return;
      if (!parsed.prompt.trim()) {
        event.preventDefault();
        event.stopPropagation();
        components.statusToast(`Add a prompt after !${parsed.level.prefix}`);
        return;
      }
      const needsFlush = !armed || armed.appliedEffort !== parsed.level.effort || applyDebounceTimer !== null;
      if (needsFlush) {
        event.preventDefault();
        event.stopPropagation();
        void prepareSubmitFromPrefix();
        return;
      }
      markSubmitRestorePending();
      stripPrefixForSubmit(parsed.prompt);
      if (settings.restoreAfterSend) scheduleRestoreAfterSubmit();
    };
    const onPointerDown = (rawEvent) => {
      const event = rawEvent;
      if (allowNativeSubmitOnce || event.button !== 0) return;
      const button = isComposerSubmitClick(composer.getInput(), event.target);
      if (!button) return;
      const parsed = parseEffortPrefix(composer.getText(), settings);
      if (!parsed?.prompt.trim()) return;
      const needsFlush = !armed || armed.appliedEffort !== parsed.level.effort || applyDebounceTimer !== null;
      if (needsFlush) {
        event.preventDefault();
        event.stopPropagation();
        void prepareSubmitFromPrefix(button);
        return;
      }
      markSubmitRestorePending();
      stripPrefixForSubmit(parsed.prompt);
      if (settings.restoreAfterSend) scheduleRestoreAfterSubmit();
    };
    const onInput = () => {
      void syncFromComposerText();
    };
    function bindComposerInput() {
      const input = composer.getInput();
      if (boundInput && !boundInput.isConnected) {
        boundInput.removeEventListener("input", onInput);
        boundInput = null;
      }
      if (!input || input === boundInput) return;
      boundInput?.removeEventListener("input", onInput);
      boundInput = input;
      boundInput.addEventListener("input", onInput);
    }
    bindComposerInput();
    runtime.addEventListener("keydown", onKeyDown, true);
    runtime.addEventListener("pointerdown", onPointerDown, true);
    refreshHintIfNeeded();
    observer = new runtime.MutationObserver(() => {
      bindComposerInput();
      if (isComposerFocused()) refreshHintIfNeeded();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    void fetchModelContext(true).then(() => log.debug("model context loaded"));
    log.info("setup complete");
    return () => {
      log.info("teardown");
      disposed = true;
      lastInputSyncId += 1;
      closeHint();
      cancelPendingApply();
      clearRestoreTimer();
      runtime.removeEventListener("keydown", onKeyDown, true);
      runtime.removeEventListener("pointerdown", onPointerDown, true);
      boundInput?.removeEventListener("input", onInput);
      boundInput = null;
      observer?.disconnect();
      observer = null;
      void restoreBaselineEffort(true);
    };
  }

  // src/index.ts
  var index_default = definePlugin({
    setup: setupEffortShortcuts
  });
  return __toCommonJS(index_exports);
})();

;(function (global) {
  var exported = typeof __ExplodexPluginBundle !== "undefined" ? __ExplodexPluginBundle : undefined;
  var definition = exported;
  if (definition && typeof definition === "object" && "default" in definition) {
    definition = definition.default;
  }
  var register = global && global.__EXPLODEX_PRIVATE_REGISTER__;
  if (typeof register === "function") {
    register("effort-shortcuts", definition);
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : this));
//# sourceMappingURL=index.js.map
