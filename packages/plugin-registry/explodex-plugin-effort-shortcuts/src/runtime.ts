import type {
  PluginApi,
  PluginTeardown,
  ReasoningEffort,
} from "@explodex/sdk";
import {
  composerCaretRect,
  conversationIdFromPortals,
  hostIdFromPortal,
  isComposerSubmitClick,
  type EffortDomRuntime,
} from "./dom";
import {
  ALL_PREFIXES,
  DEFAULT_HOST_ID,
  LEGACY_SETTINGS_KEY,
  LEVEL_BY_EFFORT,
  LEVEL_CATALOG,
  SETTINGS_KEY,
  conversationIdFromPath,
  hostIdFromPath,
  normalizeEffortShortcutSettings,
  normalizeModelsPayload,
  parseEffortPrefix,
  shouldShowEffortHint,
  supportedEffortsForModel,
  type EffortLevel,
  type EffortShortcutSettings,
  type ModelDescription,
} from "./model";

const MODELS_LIMIT = 100;
const CACHE_MS = 60_000;
const APPLY_DEBOUNCE_MS = 120;
const RESTORE_AFTER_SUBMIT_MS = 1_500;
const HINT_WIDTH = 320;
const FALLBACK_MODEL = "gpt-5.5";

export type EffortRuntime = EffortDomRuntime & {
  readonly MutationObserver: typeof MutationObserver;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  setTimeout(handler: () => void, milliseconds: number): number;
  clearTimeout(id: number): void;
  queueMicrotask(handler: () => void): void;
};

type ModelContext = {
  at: number;
  model: string | null;
  effort: ReasoningEffort | null;
  levels: readonly EffortLevel[];
  models: ModelDescription[];
};

type AppliedTarget = {
  mode: "thread" | "default-config";
  conversationId?: string;
};

type ArmedEffort = {
  savedEffort: ReasoningEffort;
  savedModel: string;
  appliedEffort: ReasoningEffort | null;
  appliedLevel: EffortLevel | null;
  mode: AppliedTarget["mode"] | null;
  conversationId: string | null;
};

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function reasoningEffort(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  return typeof value === "string" && value ? value : fallback;
}

export async function setupEffortShortcuts(
  api: PluginApi,
  runtime: EffortRuntime = globalThis as unknown as EffortRuntime,
): Promise<PluginTeardown> {
  const { bridge, codex, composer, components, log, registerOptions, storage, ui } = api;
  const document = runtime.document;
  log.info("setup start (option D)");

  await api.migrate([
    {
      id: "rename-keys-from-reasoning-effort-prefix",
      run: ({ renameKey }) => {
        renameKey(LEGACY_SETTINGS_KEY, SETTINGS_KEY);
      },
    },
  ]);

  let settings = loadSettings();
  let modelCache: ModelContext = {
    at: 0,
    model: null,
    effort: null,
    levels: [],
    models: [],
  };
  let hintOpen = false;
  let armed: ArmedEffort | null = null;
  let applyDebounceTimer: number | null = null;
  let restoreAfterSubmitTimer: number | null = null;
  let pendingApplyGeneration = 0;
  let pendingRestoreAfterSubmit = false;
  let allowNativeSubmitOnce = false;
  let suppressDisarmOnInput = false;
  let restoring = false;
  let observer: MutationObserver | null = null;
  let boundInput: HTMLElement | null = null;
  let selectionListener: EventListener | null = null;
  let disposed = false;
  let lastInputSyncId = 0;

  function loadSettings(): EffortShortcutSettings {
    return normalizeEffortShortcutSettings(
      storage.persisted.get(SETTINGS_KEY, null),
    );
  }

  function saveSettings(): void {
    storage.persisted.set(SETTINGS_KEY, settings);
  }

  function renderOptionsPanel(container: HTMLElement): void {
    container.replaceChildren();
    const fields: Node[] = LEVEL_CATALOG.map((level) =>
      components.checkboxField({
        label: `!${level.prefix} - ${level.label}`,
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
      components.checkboxField({
        label: "Show thinking-level hint",
        checked: settings.showHint,
        onChange: (value) => {
          settings.showHint = value;
          saveSettings();
          if (!value && hintOpen) closeHint();
        },
      }),
      components.checkboxField({
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
        components.metaText(
          "Prefix text will remain in the sent message when stripping is disabled.",
        ),
      );
    }
    fields.push(
      components.checkboxField({
        label: "Restore previous effort after send",
        checked: settings.restoreAfterSend,
        onChange: (value) => {
          settings.restoreAfterSend = value;
          saveSettings();
        },
      }),
    );
    container.appendChild(components.fieldStack(fields));
  }

  registerOptions({ render: renderOptionsPanel });
  settings = loadSettings();

  function getHostId(): string {
    return (
      hostIdFromPortal(document) ??
      hostIdFromPath(runtime.location?.pathname ?? "") ??
      DEFAULT_HOST_ID
    );
  }

  function getConversationId(): string | null {
    return (
      conversationIdFromPortals(document, composer.getInput()) ??
      conversationIdFromPath(runtime.location?.pathname ?? "")
    );
  }

  function isLikelyActiveThread(): boolean {
    return Boolean(
      getConversationId() ||
        document.querySelector('[data-thread-scroll-footer="true"]') ||
        document.querySelector("[data-local-conversation-item-target-ids]") ||
        document.querySelector('[class*="local-conversation" i]'),
    );
  }

  function isComposerFocused(): boolean {
    const input = composer.getInput();
    return Boolean(
      input &&
        (document.activeElement === input || input.contains(document.activeElement)),
    );
  }

  async function fetchModelContext(force = false): Promise<ModelContext> {
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
          limit: MODELS_LIMIT,
        }),
        bridge.send("read-config-for-host", {
          hostId,
          includeLayers: false,
          cwd: null,
        }),
      ]);
      const { models, defaultModel } = normalizeModelsPayload(modelsResponse);
      const configRoot = objectRecord(configResponse);
      const config = objectRecord(configRoot.config ?? configResponse);
      const conversationId = getConversationId();
      const currentModel =
        (conversationId ? codex.getThreadModel(conversationId) : null) ??
        (typeof config.model === "string" ? config.model : null) ??
        defaultModel?.model ??
        models.find((model) => model.isDefault)?.model ??
        FALLBACK_MODEL;
      const currentEffort = reasoningEffort(
        (conversationId ? codex.getThreadEffort(conversationId) : null) ??
          config.model_reasoning_effort ??
          defaultModel?.defaultReasoningEffort,
        "medium",
      );
      const supported = new Set(supportedEffortsForModel(models, currentModel));
      const levels = LEVEL_CATALOG.filter((level) => supported.has(level.effort));
      modelCache = {
        at: now,
        model: currentModel,
        effort: currentEffort,
        levels: levels.length ? levels : LEVEL_CATALOG,
        models,
      };
    } catch (error) {
      log.warn("model context fetch failed", error);
    }
    return modelCache;
  }

  function readBaselineEffort(): ReasoningEffort {
    const trigger = document.querySelector("[data-codex-intelligence-trigger]");
    const fromUi = trigger?.getAttribute("data-selected-reasoning-effort");
    const conversationId = getConversationId();
    return reasoningEffort(
      fromUi ??
        (conversationId ? codex.getThreadEffort(conversationId) : null) ??
        modelCache.effort,
      "medium",
    );
  }

  async function pushThreadEffort(
    effort: ReasoningEffort,
    model: string,
    conversationId: string,
  ): Promise<AppliedTarget> {
    if (!codex.getThreadConversation(conversationId)) {
      throw new Error("thread settings state unavailable for active thread");
    }
    const currentModel = codex.getThreadModel(conversationId) ?? model;
    const updated = await codex.applyThreadSettingsForNextTurn(conversationId, {
      model: currentModel,
      effort,
    });
    if (!updated) throw new Error("in-renderer thread settings update failed");
    return { mode: "thread", conversationId };
  }

  async function pushDefaultEffort(
    effort: ReasoningEffort,
    model: string,
  ): Promise<AppliedTarget> {
    await bridge.send("set-default-model-config-for-host", {
      hostId: getHostId(),
      model,
      reasoningEffort: effort,
      profile: null,
    });
    return { mode: "default-config" };
  }

  async function applyEffort(
    effort: ReasoningEffort,
    model: string,
  ): Promise<AppliedTarget | null> {
    if (disposed) return null;
    const conversationId = getConversationId();
    if (conversationId) return pushThreadEffort(effort, model, conversationId);
    if (isLikelyActiveThread()) {
      throw new Error("Could not resolve conversation id for active thread");
    }
    return pushDefaultEffort(effort, model);
  }

  function disarm(): void {
    armed = null;
    pendingRestoreAfterSubmit = false;
  }

  async function restoreBaselineEffort(force = false): Promise<void> {
    if (!armed || restoring) return;
    if ((!force && disposed) || !bridge.isAvailable()) {
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

  async function applyLive(level: EffortLevel): Promise<boolean> {
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
        conversationId: getConversationId(),
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

  function clearApplyDebounce(): void {
    if (applyDebounceTimer === null) return;
    runtime.clearTimeout(applyDebounceTimer);
    applyDebounceTimer = null;
  }

  function cancelPendingApply(): void {
    clearApplyDebounce();
    pendingApplyGeneration += 1;
  }

  function scheduleLiveApply(level: EffortLevel): void {
    clearApplyDebounce();
    const generation = pendingApplyGeneration + 1;
    pendingApplyGeneration = generation;
    applyDebounceTimer = runtime.setTimeout(() => {
      applyDebounceTimer = null;
      if (pendingApplyGeneration !== generation) return;
      void applyLive(level);
    }, APPLY_DEBOUNCE_MS);
  }

  async function flushLiveApply(level: EffortLevel): Promise<boolean> {
    clearApplyDebounce();
    pendingApplyGeneration += 1;
    return applyLive(level);
  }

  function clearRestoreTimer(): void {
    if (restoreAfterSubmitTimer === null) return;
    runtime.clearTimeout(restoreAfterSubmitTimer);
    restoreAfterSubmitTimer = null;
  }

  function markSubmitRestorePending(): void {
    if (armed) pendingRestoreAfterSubmit = true;
  }

  function scheduleRestoreAfterSubmit(): void {
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

  function stopHintTracking(): void {
    if (!selectionListener) return;
    document.removeEventListener("selectionchange", selectionListener);
    selectionListener = null;
  }

  function closeHint(): void {
    hintOpen = false;
    stopHintTracking();
    ui.closePopover();
  }

  function hintAnchorRect() {
    const input = composer.getInput();
    return composerCaretRect(runtime, input) ?? input?.getBoundingClientRect() ?? undefined;
  }

  function renderHintContent(context: ModelContext): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:8px";
    const meta = document.createElement("div");
    meta.style.cssText =
      "font-size:11px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 55%,transparent))";
    meta.textContent = context.model
      ? `Model: ${context.model} · current: ${LEVEL_BY_EFFORT.get(context.effort ?? "")?.label ?? context.effort}`
      : "Loading model info…";
    const list = document.createElement("pre");
    list.style.cssText =
      "margin:0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,currentColor 6%,transparent);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap";
    list.textContent = context.levels
      .map((level) => `!${level.prefix} - ${level.label}`)
      .join("\n");
    const note = document.createElement("div");
    note.style.cssText =
      "font-size:11px;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 50%,transparent))";
    note.textContent =
      "Effort applies while you type a valid prefix. Prefix is removed when you send.";
    wrap.append(meta, list, note);
    return wrap;
  }

  function repositionHint(): void {
    const input = composer.getInput();
    if (!input) return;
    ui.repositionPopover({
      anchor: input,
      anchorRect: hintAnchorRect(),
      side: "bottom",
      width: HINT_WIDTH,
    });
  }

  async function openHint(): Promise<void> {
    const input = composer.getInput();
    if (!input) return;
    hintOpen = true;
    const context = await fetchModelContext(true);
    if (
      disposed ||
      !hintOpen ||
      input !== composer.getInput() ||
      !input.isConnected ||
      !shouldShowEffortHint(composer.getText(), settings)
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
      content: () => renderHintContent(context),
    });
    selectionListener = () => {
      if (hintOpen) repositionHint();
    };
    document.addEventListener("selectionchange", selectionListener);
  }

  function refreshHintIfNeeded(): void {
    if (shouldShowEffortHint(composer.getText(), settings)) {
      if (!hintOpen) void openHint();
      else repositionHint();
    } else if (hintOpen) {
      closeHint();
    }
  }

  async function syncFromComposerText(): Promise<void> {
    const syncId = (lastInputSyncId += 1);
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

  function stripPrefixForSubmit(prompt: string): void {
    if (!settings.stripOnSend) return;
    suppressDisarmOnInput = true;
    composer.setText(prompt);
    closeHint();
    runtime.queueMicrotask(() => {
      suppressDisarmOnInput = false;
    });
  }

  function dispatchEnterOnComposer(): void {
    const input = composer.getInput();
    if (!input) return;
    const options: KeyboardEventInit = {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    };
    input.dispatchEvent(new KeyboardEvent("keydown", options));
    input.dispatchEvent(new KeyboardEvent("keypress", options));
    input.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  async function prepareSubmitFromPrefix(
    submitButton: HTMLButtonElement | null = null,
  ): Promise<boolean> {
    const parsed = parseEffortPrefix(composer.getText(), settings);
    if (!parsed || !parsed.prompt.trim()) return false;
    if (!bridge.isAvailable()) {
      components.statusToast("Bridge unavailable - cannot set thinking level");
      return true;
    }
    const context = await fetchModelContext(true);
    if (!context.levels.some(({ effort }) => effort === parsed.level.effort)) {
      components.statusToast(
        `!${parsed.level.prefix} not supported by ${context.model ?? "current model"}`,
      );
      return true;
    }
    const needsFlush =
      !armed ||
      armed.appliedEffort !== parsed.level.effort ||
      applyDebounceTimer !== null;
    if (needsFlush && !(await flushLiveApply(parsed.level))) {
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

  const onKeyDown: EventListener = (rawEvent) => {
    const event = rawEvent as KeyboardEvent;
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
    const needsFlush =
      !armed ||
      armed.appliedEffort !== parsed.level.effort ||
      applyDebounceTimer !== null;
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

  const onPointerDown: EventListener = (rawEvent) => {
    const event = rawEvent as PointerEvent;
    if (allowNativeSubmitOnce || event.button !== 0) return;
    const button = isComposerSubmitClick(composer.getInput(), event.target);
    if (!button) return;
    const parsed = parseEffortPrefix(composer.getText(), settings);
    if (!parsed?.prompt.trim()) return;
    const needsFlush =
      !armed ||
      armed.appliedEffort !== parsed.level.effort ||
      applyDebounceTimer !== null;
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

  const onInput: EventListener = () => {
    void syncFromComposerText();
  };

  function bindComposerInput(): void {
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
