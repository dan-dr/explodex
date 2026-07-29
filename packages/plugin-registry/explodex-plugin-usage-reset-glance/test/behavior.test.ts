import { describe, expect, test } from "bun:test";
import { setupUsageResetGlance } from "../src/index.ts";
import { PATH_RESET_CREDITS, PATH_USAGE } from "../src/model.ts";

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly style: Record<string, string> = {};
  children: FakeElement[] = [];
  isConnected = true;
  parentElement: FakeElement | null = null;
  tagName: string;
  type = "";
  title = "";
  private ownText = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
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
    this.ownText = "";
    this.children = [];
    this.append(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const registered = this.listeners.get(type) ?? new Set();
    registered.add(listener);
    this.listeners.set(type, registered);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener({ currentTarget: this, target: this });
    }
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === "span:last-child") {
      return [...this.children].reverse().find((child) => child.tagName === "SPAN") ?? null;
    }
    return null;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createHarness() {
  const persisted = new Map<string, unknown>([
    [
      "explodex-usage-reset-sidebar",
      {
        compactTemplate: "{usage.primary.left.percent}% • {resets.count}",
        refreshIntervalSec: 60,
        refreshPreset: "60",
      },
    ],
  ]);
  const requests: Array<{
    path: string;
    signal?: AbortSignal;
    deferred: ReturnType<typeof deferred<any>>;
  }> = [];
  const intervalCallbacks = new Map<number, () => void>();
  const intervalMs: number[] = [];
  const clearedIntervals: number[] = [];
  const bridgeHandlers = new Map<string, (message: unknown) => void>();
  const runtimeListeners = new Map<string, Set<(event: unknown) => void>>();
  let zoneCallback:
    | ((anchor: FakeElement, info: { previousAnchor: FakeElement | null }) => void)
    | null = null;
  let zoneUnsubscribed = 0;
  let bridgeUnsubscribed = 0;
  let navRemoved = 0;
  let popoverClosed = 0;
  let insertedButton: FakeElement | null = null;
  let latestPopoverContent: (() => FakeElement) | null = null;
  let optionsRender: ((container: FakeElement) => void) | null = null;
  const optionFields: Array<{ kind: string; options: any; element: FakeElement }> = [];
  let nextIntervalId = 1;

  const document = {
    createElement(tag: string) {
      return new FakeElement(tag);
    },
    createTextNode(text: string) {
      const node = new FakeElement("#text");
      node.textContent = text;
      return node;
    },
  };
  const runtime = {
    document,
    AbortController,
    addEventListener(type: string, listener: (event: unknown) => void) {
      const registered = runtimeListeners.get(type) ?? new Set();
      registered.add(listener);
      runtimeListeners.set(type, registered);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      runtimeListeners.get(type)?.delete(listener);
    },
    setInterval(callback: () => void, ms: number) {
      const id = nextIntervalId++;
      intervalCallbacks.set(id, callback);
      intervalMs.push(ms);
      return id;
    },
    clearInterval(id: number) {
      intervalCallbacks.delete(id);
      clearedIntervals.push(id);
    },
  };

  const field = (kind: string, options: any) => {
    const element = new FakeElement("div");
    optionFields.push({ kind, options, element });
    return element;
  };
  const api = {
    token: "usage-generation-1",
    log: {
      debug() {},
      error() {},
      info() {},
      warn() {},
    },
    async migrate(migrations: any[]) {
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
    http: {
      isAvailable: () => true,
      get(path: string, options?: { signal?: AbortSignal }) {
        const pending = deferred<any>();
        requests.push({ path, signal: options?.signal, deferred: pending });
        return pending.promise;
      },
    },
    bridge: {
      on(type: string, handler: (message: unknown) => void) {
        bridgeHandlers.set(type, handler);
        return () => {
          bridgeHandlers.delete(type);
          bridgeUnsubscribed += 1;
        };
      },
    },
    inject: {
      observeZone(
        _zone: string,
        callback: typeof zoneCallback,
        options: { includeMutations?: boolean },
      ) {
        expect(options.includeMutations).toBe(true);
        zoneCallback = callback;
        return () => {
          zoneCallback = null;
          zoneUnsubscribed += 1;
        };
      },
    },
    sidebarNav: {
      insertBefore(_labels: string[], button: FakeElement, key: string) {
        expect(key).toBe("usage-reset-glance");
        insertedButton = button;
        return true;
      },
      remove(key: string) {
        expect(key).toBe("usage-reset-glance");
        insertedButton = null;
        navRemoved += 1;
      },
    },
    ui: {
      navItem(options: { label?: string; onClick?: (event: any) => void }) {
        const button = new FakeElement("button");
        const label = new FakeElement("span");
        label.textContent = options.label ?? "";
        button.appendChild(label);
        if (options.onClick) button.addEventListener("click", options.onClick);
        return button;
      },
      popover(options: { content?: () => FakeElement }) {
        latestPopoverContent = options.content ?? null;
        return new FakeElement("div");
      },
      repositionPopover() {
        return true;
      },
      closePopover() {
        popoverClosed += 1;
      },
    },
    components: {
      fieldStack(children: FakeElement[]) {
        const stack = new FakeElement("div");
        stack.append(...children);
        return stack;
      },
      textField(options: any) {
        return field("text", options);
      },
      metaText(text: string) {
        const element = field("meta", { text });
        element.textContent = text;
        return element;
      },
      selectField(options: any) {
        return field("select", options);
      },
      numberField(options: any) {
        return field("number", options);
      },
    },
    registerOptions(handlers: { render(container: FakeElement): void }) {
      optionsRender = handlers.render;
    },
    format: {
      template(template: string, context: any, options?: { fallback?: string }) {
        return template.replace(
          /\{([^}]+)\}/g,
          (_match, path: string) =>
            path
              .replace(/\[(\d+)\]/g, ".$1")
              .split(".")
              .reduce((value: any, key: string) => value?.[key], context) ??
            options?.fallback ??
            "—",
        );
      },
      countdown(value: number | null | undefined) {
        return value == null ? "—" : `in:${value}`;
      },
      datetimeCountdown(value: number | null | undefined) {
        return value == null ? "—" : `at:${value}`;
      },
    },
  };

  return {
    api,
    runtime,
    requests,
    intervalCallbacks,
    intervalMs,
    clearedIntervals,
    bridgeHandlers,
    runtimeListeners,
    persisted,
    optionFields,
    get insertedButton() {
      return insertedButton;
    },
    get latestPopoverContent() {
      return latestPopoverContent;
    },
    get optionsRender() {
      return optionsRender;
    },
    get zoneCallback() {
      return zoneCallback;
    },
    counts() {
      return {
        bridgeUnsubscribed,
        navRemoved,
        popoverClosed,
        zoneUnsubscribed,
      };
    },
  };
}

describe("VAL-PLUG-010 Usage and Reset Glance lifecycle", () => {
  test("renders loading and populated sidebar/popover states, then refreshes by timer and event", async () => {
    const harness = createHarness();
    const teardown = await setupUsageResetGlance(
      harness.api as any,
      harness.runtime as any,
    );

    expect(harness.persisted.has("explodex-usage-reset-sidebar")).toBe(false);
    expect(harness.persisted.has("explodex-usage-reset-glance")).toBe(true);
    expect(harness.insertedButton?.textContent).toBe("Usage: loading…");
    expect(harness.requests.map((request) => request.path)).toEqual([
      PATH_USAGE,
      PATH_RESET_CREDITS,
    ]);

    harness.insertedButton?.click();
    expect(harness.latestPopoverContent?.().textContent).toContain("Loading…");

    harness.requests[0]!.deferred.resolve({
      rate_limit: {
        primary_window: {
          used_percent: 20,
          reset_at: 1_800_000_000,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          used_percent: 50,
          reset_at: 1_900_000_000,
          limit_window_seconds: 604_800,
        },
      },
    });
    harness.requests[1]!.deferred.resolve({
      available_count: 1,
      credits: [{ status: "available", title: "Reset A" }],
    });
    await settle();

    expect(harness.insertedButton?.textContent).toBe("80% • 1");
    const populated = harness.latestPopoverContent?.();
    expect(populated?.getAttribute("aria-readonly")).toBe("true");
    expect(populated?.textContent).toContain("Reset credits1");
    expect(populated?.textContent).toContain("Short window80% left");
    expect(populated?.textContent).toContain("Weekly50% left");
    expect(populated?.textContent).toContain(
      "View only — use Codex settings to redeem resets",
    );
    expect(harness.intervalMs).toEqual([60_000]);

    harness.intervalCallbacks.values().next().value?.();
    expect(harness.requests).toHaveLength(4);
    harness.bridgeHandlers.get("account/rateLimits/updated")?.({});
    expect(harness.requests).toHaveLength(6);
    expect(harness.requests.slice(4).map((request) => request.path)).toEqual([
      PATH_USAGE,
      PATH_RESET_CREDITS,
    ]);

    await teardown?.();
  });

  test("ignores stale completions, persists custom refresh options, and tears down all active work", async () => {
    const harness = createHarness();
    const teardown = await setupUsageResetGlance(
      harness.api as any,
      harness.runtime as any,
    );

    harness.bridgeHandlers.get("account/rateLimits/updated")?.({});
    expect(harness.requests[0]!.signal?.aborted).toBe(true);
    expect(harness.requests[1]!.signal?.aborted).toBe(true);

    harness.requests[2]!.deferred.resolve({
      rate_limit: {
        primary_window: {
          used_percent: 10,
          reset_at: 1_800_000_000,
          limit_window_seconds: 18_000,
        },
      },
    });
    harness.requests[3]!.deferred.resolve({ available_count: 3, credits: [] });
    await settle();
    expect(harness.insertedButton?.textContent).toBe("90% • 3");

    harness.requests[0]!.deferred.resolve({
      rate_limit: {
        primary_window: {
          used_percent: 99,
          reset_at: 1_800_000_000,
          limit_window_seconds: 18_000,
        },
      },
    });
    harness.requests[1]!.deferred.resolve({ available_count: 99, credits: [] });
    await settle();
    expect(harness.insertedButton?.textContent).toBe("90% • 3");

    const optionsContainer = new FakeElement("div");
    harness.optionsRender?.(optionsContainer);
    const refreshSelect = harness.optionFields.find(
      (field) => field.kind === "select",
    );
    refreshSelect?.options.onChange("custom");
    const customInterval = harness.optionFields.find(
      (field) => field.kind === "number",
    );
    customInterval?.options.onChange(17);
    expect(harness.persisted.get("explodex-usage-reset-glance")).toMatchObject({
      refreshIntervalSec: 17,
      refreshPreset: "custom",
    });
    expect(harness.intervalMs.at(-1)).toBe(17_000);

    harness.zoneCallback?.(new FakeElement("aside"), {
      previousAnchor: new FakeElement("aside"),
    });
    await teardown?.();
    await teardown?.();

    expect(harness.counts()).toEqual({
      bridgeUnsubscribed: 1,
      navRemoved: 1,
      popoverClosed: 1,
      zoneUnsubscribed: 1,
    });
    expect(harness.bridgeHandlers.size).toBe(0);
    expect(
      [...harness.runtimeListeners.values()].every(
        (listeners) => listeners.size === 0,
      ),
    ).toBe(true);
    expect(harness.intervalCallbacks.size).toBe(0);
    expect(harness.requests[2]!.signal?.aborted).toBe(false);
  });

  test("renders an error state without issuing any mutating request", async () => {
    const harness = createHarness();
    const teardown = await setupUsageResetGlance(
      harness.api as any,
      harness.runtime as any,
    );
    harness.insertedButton?.click();
    harness.requests[0]!.deferred.reject(new Error("usage failed"));
    harness.requests[1]!.deferred.resolve(null);
    await settle();

    expect(harness.insertedButton?.textContent).toBe("Usage: error");
    expect(harness.latestPopoverContent?.().textContent).toContain(
      "Errorusage failed",
    );
    expect(
      harness.requests.every((request) =>
        [PATH_USAGE, PATH_RESET_CREDITS].includes(request.path),
      ),
    ).toBe(true);
    await teardown?.();
  });
});
