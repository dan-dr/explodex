import { describe, expect, test } from "bun:test";
import type { PluginApi } from "@explodex/sdk";
import { setupEffortShortcuts, type EffortRuntime } from "../src/runtime.ts";
import {
  LEGACY_SETTINGS_KEY,
  SETTINGS_KEY,
} from "../src/model.ts";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  isConnected = true;
  textContent = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = [];
    this.append(...children);
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector(): FakeElement | null {
    return null;
  }

  getBoundingClientRect(): DOMRect {
    return {
      bottom: 40,
      height: 20,
      left: 10,
      right: 210,
      top: 20,
      width: 200,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    };
  }

  focus(): void {}

  dispatch(type: string): void {
    const event = { target: this } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeMutationObserver {
  disconnected = false;
  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  takeRecords(): MutationRecord[] {
    return [];
  }
}

type KeyboardProbe = Event & {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  prevented: boolean;
  stopped: boolean;
};

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createHarness() {
  const input = new FakeElement("div");
  const root = new FakeElement("html");
  root.appendChild(input);
  let composerText = "";
  const persisted = new Map<string, unknown>([
    [
      LEGACY_SETTINGS_KEY,
      {
        enabledPrefixes: ["m", "h"],
        showHint: false,
        stripOnSend: true,
        restoreAfterSend: true,
      },
    ],
  ]);
  const globalListeners = new Map<string, Set<EventListener>>();
  const timers = new Map<number, () => void>();
  const bridgeCalls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const effortCalls: Array<{ model?: string; effort?: string }> = [];
  const optionRenders: Array<(container: HTMLElement) => void> = [];
  const toasts: string[] = [];
  const observers: FakeMutationObserver[] = [];
  let nextTimer = 1;

  const document = {
    activeElement: input,
    documentElement: root,
    querySelector(): FakeElement | null {
      return null;
    },
    querySelectorAll(): FakeElement[] {
      return [];
    },
    createElement(tag: string): FakeElement {
      return new FakeElement(tag);
    },
    addEventListener(): void {},
    removeEventListener(): void {},
  };

  const runtime = {
    document,
    location: { pathname: `/thread/${THREAD_ID}` },
    MutationObserver: class extends FakeMutationObserver {
      constructor() {
        super();
        observers.push(this);
      }
    },
    addEventListener(type: string, listener: EventListener) {
      const listeners = globalListeners.get(type) ?? new Set<EventListener>();
      listeners.add(listener);
      globalListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: EventListener) {
      globalListeners.get(type)?.delete(listener);
    },
    setTimeout(callback: () => void) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    queueMicrotask,
    getComputedStyle() {
      return {};
    },
    getSelection() {
      return null;
    },
  } as unknown as EffortRuntime;

  const field = (): FakeElement => new FakeElement("label");
  const api = {
    log: { debug() {}, error() {}, info() {}, warn() {} },
    async migrate(migrations: Array<{ run(context: object): void | Promise<void> }>) {
      for (const migration of migrations) {
        await migration.run({
          renameKey(oldKey: string, newKey: string) {
            if (!persisted.has(oldKey)) return false;
            if (!persisted.has(newKey)) persisted.set(newKey, persisted.get(oldKey));
            persisted.delete(oldKey);
            return true;
          },
        });
      }
    },
    storage: {
      persisted: {
        get(key: string, fallback: unknown) {
          return persisted.has(key) ? persisted.get(key) : fallback;
        },
        set(key: string, value: unknown) {
          persisted.set(key, value);
        },
      },
    },
    registerOptions(handlers: { render(container: HTMLElement): void }) {
      optionRenders.push(handlers.render);
    },
    components: {
      checkboxField: field,
      metaText() {
        return new FakeElement("div");
      },
      fieldStack(children: FakeElement[]) {
        const stack = new FakeElement("div");
        stack.append(...children);
        return stack;
      },
      statusToast(message: string) {
        toasts.push(message);
      },
    },
    composer: {
      getInput: () => input,
      getText: () => composerText,
      setText(text: string) {
        composerText = text;
        return true;
      },
    },
    bridge: {
      isAvailable: () => true,
      async send(type: string, payload: Record<string, unknown>) {
        bridgeCalls.push({ type, payload });
        if (type === "list-models-for-host") {
          return {
            models: [
              {
                model: "gpt-test",
                supportedReasoningEfforts: [
                  { reasoningEffort: "medium" },
                  { reasoningEffort: "high" },
                ],
              },
            ],
            defaultModel: {
              model: "gpt-test",
              defaultReasoningEffort: "high",
            },
          };
        }
        if (type === "read-config-for-host") return { config: { model: "gpt-test" } };
        return null;
      },
    },
    codex: {
      getThreadConversation: () => ({ id: THREAD_ID }),
      getThreadModel: () => "gpt-test",
      getThreadEffort: () => "high",
      async applyThreadSettingsForNextTurn(
        _conversationId: string,
        settings: { model?: string; effort?: string },
      ) {
        effortCalls.push(settings);
        return true;
      },
    },
    ui: {
      closePopover() {},
      repositionPopover: () => true,
      popover: () => new FakeElement("div"),
    },
  } as unknown as PluginApi;

  function emitKeyDown(): KeyboardProbe {
    const event = {
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    } as unknown as KeyboardProbe;
    for (const listener of globalListeners.get("keydown") ?? []) listener(event);
    return event;
  }

  async function runNextTimer(): Promise<void> {
    const entry = timers.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("expected a pending timer");
    timers.delete(entry[0]);
    entry[1]();
    await settle();
  }

  return {
    api,
    bridgeCalls,
    effortCalls,
    emitKeyDown,
    globalListeners,
    input,
    observers,
    optionRenders,
    persisted,
    runNextTimer,
    runtime,
    setComposerText(value: string) {
      composerText = value;
    },
    getComposerText: () => composerText,
    timers,
    toasts,
  };
}

describe("VAL-PLUG-013 Effort Shortcuts behavior", () => {
  test("migrates settings, live-applies a prefix, strips on send, and restores", async () => {
    const harness = createHarness();
    const teardown = await setupEffortShortcuts(harness.api, harness.runtime);
    await settle();

    expect(harness.persisted.has(LEGACY_SETTINGS_KEY)).toBe(false);
    expect(harness.persisted.has(SETTINGS_KEY)).toBe(true);
    expect(harness.optionRenders).toHaveLength(1);

    harness.setComposerText("!m explain this");
    harness.input.dispatch("input");
    await settle();
    await harness.runNextTimer();
    expect(harness.effortCalls).toEqual([{ model: "gpt-test", effort: "medium" }]);

    const keyEvent = harness.emitKeyDown();
    expect(keyEvent.prevented).toBe(false);
    expect(harness.getComposerText()).toBe("explain this");
    await harness.runNextTimer();
    expect(harness.effortCalls).toEqual([
      { model: "gpt-test", effort: "medium" },
      { model: "gpt-test", effort: "high" },
    ]);
    expect(harness.toasts).toEqual([]);

    teardown();
    await settle();
    expect(harness.globalListeners.get("keydown")?.size ?? 0).toBe(0);
    expect(harness.globalListeners.get("pointerdown")?.size ?? 0).toBe(0);
    expect(harness.input.listeners.get("input")?.size ?? 0).toBe(0);
    expect(harness.observers[0]?.disconnected).toBe(true);
  });

  test("blocks an empty shortcut prompt without changing effort", async () => {
    const harness = createHarness();
    const teardown = await setupEffortShortcuts(harness.api, harness.runtime);
    await settle();
    harness.setComposerText("!m");
    const keyEvent = harness.emitKeyDown();
    expect(keyEvent.prevented).toBe(true);
    expect(keyEvent.stopped).toBe(true);
    expect(harness.toasts).toEqual(["Add a prompt after !m"]);
    expect(harness.effortCalls).toEqual([]);
    teardown();
  });
});
