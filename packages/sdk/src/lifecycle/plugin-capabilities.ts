/**
 * Browser capability adapters for accepted plugin generations.
 * Private renderer objects are captured inside this module and never returned.
 */

import type {
  BridgeApi,
  BridgeMessage,
  ButtonColor,
  ButtonSize,
  CodexApi,
  ComponentsApi,
  ComposerApi,
  FlagsApi,
  FormatApi,
  HttpApi,
  HttpRequestOptions,
  HttpResponse,
  InjectApi,
  MountContext,
  MountStrategy,
  PluginCapabilityApi,
  PluginLogger,
  PluginMigration,
  PluginOptionsHandlers,
  QueryApi,
  QueryClientApi,
  QueryRecord,
  SidebarNavApi,
  UiApi,
  ZoneId,
} from "../types/index.ts";
import type { TrackedResourceRegistry } from "./tracked-resources.ts";

const PERSISTED_PREFIX = "codex:persisted-atom:";
const MIGRATION_LEDGER_PREFIX = "explodex-migrations:";
const STYLE_ID = "explodex-sdk-style";
const MOUNT_ATTR = "data-explodex-mount";
const PLUGIN_ATTR = "data-explodex-plugin";
const STATSIG_PATCH_STORE_KEY = "__explodexStatsigGatePatchStore";

type AppServerSend = (
  type: string,
  payload?: Record<string, unknown>,
) => Promise<unknown>;

type RendererBridge = {
  sendMessageFromView?(
    message: { type: string } & Record<string, unknown>,
  ): Promise<unknown>;
};

type Fiber = {
  return?: Fiber | null;
  child?: Fiber | null;
  sibling?: Fiber | null;
  memoizedState?: unknown;
  memoizedProps?: unknown;
};

type QueryClientInternal = {
  getQueryCache?(): {
    getAll?(): readonly QueryRecord[];
  };
  getQueryData?<T = unknown>(queryKey: readonly unknown[]): T | undefined;
  setQueryData?<T = unknown>(
    queryKey: readonly unknown[],
    value: T | ((current: T | undefined) => T | undefined),
  ): unknown;
  invalidateQueries?(options: {
    queryKey: readonly unknown[];
  }): Promise<unknown>;
};

type StatsigOverrideEntry = {
  owners: Map<string, boolean>;
};

type StatsigPatchStore = {
  origCheckGate?: (gate: string, ...rest: unknown[]) => boolean;
  origGetFeatureGate?: (
    gate: string,
    ...rest: unknown[]
  ) => Record<string, unknown>;
  origOverrideAdapter: StatsigClient["overrideAdapter"];
  gates: Map<string, StatsigOverrideEntry>;
};

type StatsigClient = {
  checkGate?: (gate: string, ...rest: unknown[]) => boolean;
  getFeatureGate?: (
    gate: string,
    ...rest: unknown[]
  ) => Record<string, unknown>;
  overrideAdapter?: {
    getGateOverride?(
      gate: { name?: string } | null,
      user?: unknown,
      options?: unknown,
    ): unknown;
    getDynamicConfigOverride?: (...args: unknown[]) => unknown;
    getExperimentOverride?: (...args: unknown[]) => unknown;
    getLayerOverride?: (...args: unknown[]) => unknown;
    getParamStoreOverride?: (...args: unknown[]) => unknown;
  } | null;
  _memoCache?: Record<string, unknown>;
  $emt?(event: Record<string, unknown>): void;
  loadingStatus?: string;
  [STATSIG_PATCH_STORE_KEY]?: StatsigPatchStore;
};

type CapabilityHost = Record<string, unknown> & {
  document?: Document;
  localStorage?: Storage;
  location?: Location | { pathname?: string };
  crypto?: Crypto;
  innerWidth?: number;
  innerHeight?: number;
  addEventListener?(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener?(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  dispatchEvent?(event: Event): boolean;
  requestAnimationFrame?(callback: FrameRequestCallback): number;
  cancelAnimationFrame?(handle: number): void;
  getSelection?(): Selection | null;
  __explodexAppServerSend?: AppServerSend;
  __bcAppServerSend?: AppServerSend;
  __STATSIG__?: {
    firstInstance?: StatsigClient;
    instance?: StatsigClient;
    instances?: Record<string, StatsigClient>;
  };
};

type CapabilityState = {
  options: Map<
    string,
    {
      active: boolean;
      handlers: PluginOptionsHandlers;
      containers: Set<HTMLElement>;
    }
  >;
  navMounts: Map<string, HTMLDivElement>;
  activePopover: HTMLDivElement | null;
  messageHandlers: Map<string, Set<(message: BridgeMessage) => void>>;
  messageListener: EventListener | null;
  styleOwners: Set<string>;
  styleNode: HTMLStyleElement | null;
};

const hostStates = new WeakMap<object, CapabilityState>();
const RENDERER_BRIDGE_KEY = ["elec", "tron", "Bridge"].join("");

function rendererBridge(host: CapabilityHost): RendererBridge | undefined {
  return host[RENDERER_BRIDGE_KEY] as RendererBridge | undefined;
}

const ZONE_SELECTORS: Record<ZoneId, readonly string[]> = {
  aboveComposer: ["[data-above-composer-portal]"],
  aboveComposerQueue: ["[data-above-composer-queue-portal]"],
  mcpAppPortal: ['[data-mcp-app-portal-target="true"]'],
  threadFooter: ['[data-thread-scroll-footer="true"]'],
  browserSidebarBanner: [
    '[data-testid="browser-sidebar-top-banner-portal"]',
  ],
  homeAmbient: ["[data-home-ambient-suggestions]"],
  sidebar: [
    '[data-testid="app-shell-floating-left-panel"]',
    '[data-testid="app-shell-left-panel"]',
    "aside",
  ],
  composerActions: [
    "[data-composer-actions]",
    ".ProseMirror",
    '[contenteditable="true"]',
  ],
  statusOverlay: ["body"],
};

const ZONE_MOUNTS: Record<ZoneId, MountStrategy> = {
  aboveComposer: "append",
  aboveComposerQueue: "append",
  mcpAppPortal: "append",
  threadFooter: "prepend",
  browserSidebarBanner: "append",
  homeAmbient: "append",
  sidebar: "append",
  composerActions: "after-input",
  statusOverlay: "fixed",
};

function stateFor(host: CapabilityHost): CapabilityState {
  const existing = hostStates.get(host);
  if (existing !== undefined) return existing;
  const created: CapabilityState = {
    options: new Map(),
    navMounts: new Map(),
    activePopover: null,
    messageHandlers: new Map(),
    messageListener: null,
    styleOwners: new Set(),
    styleNode: null,
  };
  hostStates.set(host, created);
  return created;
}

export function renderRegisteredPluginOptions(
  hostInput: Record<string, unknown>,
  pluginId: string,
  container: HTMLElement,
): boolean {
  const state = stateFor(hostInput as CapabilityHost);
  const registration = state.options.get(pluginId);
  if (registration === undefined) return false;
  for (const prior of registration.containers) {
    if (!prior.isConnected) registration.containers.delete(prior);
  }
  registration.containers.add(container);
  const refresh = (): void => {
    if (
      !container.isConnected ||
      state.options.get(pluginId) !== registration
    ) {
      return;
    }
    registration.handlers.render(container, { pluginId, refresh });
  };
  registration.handlers.render(container, { pluginId, refresh });
  return true;
}

function once(dispose: () => void): () => void {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    dispose();
  };
}

function trackSubscription(
  resources: TrackedResourceRegistry,
  dispose: () => void,
): () => void {
  const stop = once(dispose);
  resources.track.subscription(stop);
  return stop;
}

function firstExisting(
  document: Document,
  selectors: readonly string[],
): Element | null {
  for (const selector of selectors) {
    const found = document.querySelector(selector);
    if (found !== null) return found;
  }
  return null;
}

function resolveZoneAnchor(
  document: Document | undefined,
  zoneId: ZoneId,
): Element | null {
  return document === undefined
    ? null
    : firstExisting(document, ZONE_SELECTORS[zoneId]);
}

function installStyles(
  host: CapabilityHost,
  ownerKey: string,
  resources: TrackedResourceRegistry,
): void {
  const document = host.document;
  if (document === undefined) return;
  const state = stateFor(host);
  state.styleOwners.add(ownerKey);
  if (state.styleNode === null || !state.styleNode.isConnected) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
[${MOUNT_ATTR}] { box-sizing: border-box; }
.ex-mount-above-composer { width: 100%; }
.ex-mount-composer-actions { display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px; }
.ex-button { display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:8px;color:inherit;font:inherit;cursor:pointer;-webkit-app-region:no-drag; }
.ex-button:disabled { opacity:.5;cursor:default; }
.ex-field-stack { display:flex;flex-direction:column;gap:10px; }
.ex-field-row { display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;line-height:20px; }
.ex-field-label { flex:1;min-width:0; }
.ex-field-meta { font-size:11px;line-height:1.4;color:var(--color-text-tertiary,color-mix(in srgb,currentColor 55%,transparent)); }
.ex-field-input,.ex-field-input-wide,.ex-field-select { padding:4px 8px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:inherit; }
.ex-field-input { width:88px; }
.ex-field-input-wide { width:100%;box-sizing:border-box; }
.ex-field-input-mono { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
.ex-section { display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);background:color-mix(in srgb,currentColor 3%,transparent); }
.ex-section-title { font-weight:600;font-size:12px;line-height:16px; }
.ex-section-body,.ex-sortable-list { display:flex;flex-direction:column;gap:6px; }
.ex-sortable-item { display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 10%,transparent); }
.ex-sortable-item-label { flex:1;min-width:0;font-size:13px; }
.ex-sortable-item-actions { display:inline-flex;gap:2px; }
.ex-sortable-btn { border:0;border-radius:4px;padding:2px 6px;background:transparent;color:inherit;cursor:pointer; }
.ex-panel { border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:12px;background:color-mix(in srgb,currentColor 4%,transparent);padding:10px 12px;color:inherit;font:13px/1.4 system-ui,sans-serif; }
.ex-status-fixed { position:fixed;right:12px;bottom:48px;z-index:2147483646;padding:6px 10px;border-radius:8px;background:#111;color:#fff;font:12px/1.3 system-ui,sans-serif;pointer-events:none; }
.ex-nav-row { width:100%;-webkit-app-region:no-drag; }
.ex-nav-btn { display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:10px;background:transparent;color:inherit;font:445 14px/1.43 system-ui,sans-serif;text-align:left;cursor:pointer; }
.ex-popover-backdrop { position:fixed;inset:0;z-index:2147483645;background:transparent; }
.ex-popover { position:fixed;z-index:2147483646;overflow:hidden;display:flex;flex-direction:column;border-radius:12px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);background:var(--color-bg-primary,#111);color:inherit;box-shadow:0 12px 40px color-mix(in srgb,#000 45%,transparent);font:13px/1.4 system-ui,sans-serif; }
.ex-popover-header { display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent); }
.ex-popover-title { font-weight:600;font-size:14px; }
.ex-popover-body { padding:12px 14px 14px;display:flex;flex-direction:column;gap:10px;overflow:auto; }
`;
    document.head?.appendChild(style);
    state.styleNode = style;
  }
  trackSubscription(resources, () => {
    state.styleOwners.delete(ownerKey);
    if (state.styleOwners.size !== 0) return;
    state.styleNode?.remove();
    state.styleNode = null;
  });
}

function buttonStyle(
  button: HTMLButtonElement,
  color: ButtonColor,
  size: ButtonSize,
  uniform: boolean,
): void {
  const background =
    color === "primary"
      ? "var(--color-accent,#248aff)"
      : color === "danger"
        ? "color-mix(in srgb,#e5484d 18%,transparent)"
        : color === "secondary"
          ? "color-mix(in srgb,currentColor 10%,transparent)"
          : "transparent";
  button.style.background = background;
  button.style.padding =
    size === "icon" || size === "iconSm"
      ? "4px"
      : size === "composerSm"
        ? "4px 8px"
        : "6px 10px";
  if (uniform) button.style.aspectRatio = "1";
}

function createComponents(
  host: CapabilityHost,
  ownerKey: string,
  resources: TrackedResourceRegistry,
): ComponentsApi {
  const document = host.document;
  const requireDocument = (): Document => {
    if (document === undefined) {
      throw new Error("Plugin UI capabilities require a renderer document.");
    }
    installStyles(host, ownerKey, resources);
    return document;
  };
  const components: ComponentsApi = {
    button(options = {}) {
      const doc = requireDocument();
      const button = doc.createElement("button");
      button.type = options.type ?? "button";
      button.className = ["ex-button", options.className ?? ""]
        .filter(Boolean)
        .join(" ");
      buttonStyle(
        button,
        options.color ?? "primary",
        options.size ?? "default",
        options.uniform ?? false,
      );
      button.disabled = Boolean(options.disabled || options.loading);
      if (options.loading) button.appendChild(doc.createTextNode("…"));
      if (options.icon !== undefined) {
        button.appendChild(
          typeof options.icon === "string"
            ? doc.createTextNode(options.icon)
            : options.icon,
        );
      }
      const label = options.children ?? options.label;
      if (label) {
        const span = doc.createElement("span");
        span.textContent = label;
        button.appendChild(span);
      }
      if (options.onClick !== undefined) {
        button.addEventListener("click", options.onClick);
      }
      for (const [key, value] of Object.entries(options)) {
        if (
          ![
            "label",
            "children",
            "color",
            "size",
            "uniform",
            "loading",
            "disabled",
            "type",
            "className",
            "onClick",
            "icon",
          ].includes(key)
        ) {
          Reflect.set(button, key, value);
        }
      }
      return button;
    },
    panel(options = {}) {
      const doc = requireDocument();
      const element = doc.createElement("div");
      element.className = ["ex-panel", options.className ?? ""]
        .filter(Boolean)
        .join(" ");
      if (options.title) {
        const title = doc.createElement("div");
        title.style.cssText = "font-weight:600;margin-bottom:6px";
        title.textContent = options.title;
        element.appendChild(title);
      }
      if (options.children !== undefined) {
        const child =
          typeof options.children === "function"
            ? options.children()
            : options.children;
        element.appendChild(
          typeof child === "string" ? doc.createTextNode(child) : child,
        );
      }
      return element;
    },
    statusToast(message, options = {}) {
      const doc = requireDocument();
      const toast = doc.createElement("div");
      toast.className = "ex-status-fixed";
      toast.textContent = message;
      doc.body.appendChild(toast);
      resources.track.mount(toast);
      resources.track.timeout(
        () => toast.remove(),
        options.duration ?? 2_800,
      );
    },
    metaText(text = "") {
      const element = requireDocument().createElement("div");
      element.className = "ex-field-meta";
      element.textContent = text;
      return element;
    },
    fieldRow(options = {}) {
      const doc = requireDocument();
      const row = doc.createElement("div");
      row.className = "ex-field-row";
      if (options.label !== undefined) {
        const label = doc.createElement("span");
        label.className = "ex-field-label";
        label.textContent = options.label;
        row.appendChild(label);
      }
      if (options.control !== undefined) row.appendChild(options.control);
      if (!options.hint) return row;
      const wrap = doc.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
      wrap.append(row, components.metaText(options.hint));
      return wrap;
    },
    checkboxField(options = {}) {
      const doc = requireDocument();
      const input = doc.createElement("input");
      input.type = "checkbox";
      input.checked = options.checked ?? false;
      if (options.onChange !== undefined) {
        input.addEventListener("change", () =>
          options.onChange?.(input.checked)
        );
      }
      const row = doc.createElement("label");
      row.className = "ex-field-row";
      const label = doc.createElement("span");
      label.className = "ex-field-label";
      label.textContent = options.label ?? "";
      row.append(label, input);
      return row;
    },
    radioField(options = {}) {
      const doc = requireDocument();
      const input = doc.createElement("input");
      input.type = "radio";
      input.name = options.name ?? "";
      input.value = options.value ?? "";
      input.checked = options.checked ?? false;
      if (options.onChange !== undefined) {
        input.addEventListener("change", () => {
          if (input.checked) options.onChange?.(options.value);
        });
      }
      const row = doc.createElement("label");
      row.className = "ex-field-row";
      const label = doc.createElement("span");
      label.className = "ex-field-label";
      label.textContent = options.label ?? "";
      row.append(label, input);
      return row;
    },
    numberField(options = {}) {
      const doc = requireDocument();
      const input = doc.createElement("input");
      input.type = "number";
      input.className = "ex-field-input";
      input.value = String(options.value ?? 0);
      if (options.min !== undefined) input.min = String(options.min);
      if (options.max !== undefined) input.max = String(options.max);
      if (options.onChange !== undefined) {
        input.addEventListener("change", () => {
          const value = Number(input.value);
          if (Number.isFinite(value)) options.onChange?.(value);
        });
      }
      return components.fieldRow({
        label: options.label,
        control: input,
      });
    },
    textField(options = {}) {
      const doc = requireDocument();
      const input = doc.createElement("input");
      input.type = "text";
      input.className = [
        "ex-field-input-wide",
        options.monospace ? "ex-field-input-mono" : "",
      ]
        .filter(Boolean)
        .join(" ");
      input.value = options.value ?? "";
      input.placeholder = options.placeholder ?? "";
      if (options.onChange !== undefined) {
        input.addEventListener("change", () =>
          options.onChange?.(input.value)
        );
      }
      const wrap = doc.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:6px";
      if (options.label) {
        const label = doc.createElement("div");
        label.className = "ex-field-label";
        label.textContent = options.label;
        wrap.appendChild(label);
      }
      wrap.appendChild(input);
      return wrap;
    },
    selectField(options = {}) {
      const doc = requireDocument();
      const select = doc.createElement("select");
      select.className = "ex-field-select";
      for (const item of options.options ?? []) {
        const option = doc.createElement("option");
        option.value = item.value;
        option.textContent = item.label ?? item.value;
        option.selected = item.value === options.value;
        select.appendChild(option);
      }
      if (options.onChange !== undefined) {
        select.addEventListener("change", () =>
          options.onChange?.(select.value)
        );
      }
      return components.fieldRow({
        label: options.label,
        control: select,
      });
    },
    section(options = {}) {
      const doc = requireDocument();
      const element = doc.createElement("div");
      element.className = "ex-section";
      if (options.title) {
        const title = doc.createElement("div");
        title.className = "ex-section-title";
        title.textContent = options.title;
        element.appendChild(title);
      }
      if (options.hint) element.appendChild(components.metaText(options.hint));
      const body = doc.createElement("div");
      body.className = "ex-section-body";
      const children =
        typeof options.children === "function"
          ? [options.children()]
          : Array.isArray(options.children)
            ? options.children
            : options.children === undefined
              ? []
              : [options.children];
      body.append(...children);
      element.appendChild(body);
      return { el: element, body };
    },
    sortableList(options = {}) {
      const doc = requireDocument();
      const wrap = doc.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:6px";
      if (options.label) {
        const label = doc.createElement("div");
        label.className = "ex-field-label";
        label.textContent = options.label;
        wrap.appendChild(label);
      }
      let items = [...(options.items ?? [])];
      const list = doc.createElement("div");
      list.className = "ex-sortable-list";
      const paint = (): void => {
        list.replaceChildren();
        items.forEach((item, index) => {
          const row = doc.createElement("div");
          row.className = "ex-sortable-item";
          const label = doc.createElement("div");
          label.className = "ex-sortable-item-label";
          label.textContent =
            options.renderLabel?.(item) ?? item.label ?? item.id;
          const actions = doc.createElement("div");
          actions.className = "ex-sortable-item-actions";
          for (const [text, delta] of [
            ["▲", -1],
            ["▼", 1],
          ] as const) {
            const button = doc.createElement("button");
            button.type = "button";
            button.className = "ex-sortable-btn";
            button.textContent = text;
            button.disabled =
              (delta < 0 && index === 0) ||
              (delta > 0 && index === items.length - 1);
            button.addEventListener("click", () => {
              const target = index + delta;
              if (target < 0 || target >= items.length) return;
              const next = [...items];
              const [moved] = next.splice(index, 1);
              if (moved === undefined) return;
              next.splice(target, 0, moved);
              items = next;
              options.onReorder?.(items.map((entry) => entry.id));
              paint();
            });
            actions.appendChild(button);
          }
          row.append(label, actions);
          list.appendChild(row);
        });
      };
      paint();
      wrap.appendChild(list);
      return wrap;
    },
    fieldStack(children = []) {
      const element = requireDocument().createElement("div");
      element.className = "ex-field-stack";
      element.append(...children);
      return element;
    },
  };
  return components;
}

function createBridge(
  host: CapabilityHost,
  resources: TrackedResourceRegistry,
  getHttp: () => HttpApi,
): BridgeApi {
  const state = stateFor(host);
  const appServer = (): AppServerSend | undefined =>
    host.__explodexAppServerSend ?? host.__bcAppServerSend;
  const bridge: BridgeApi = {
    isAvailable() {
      return (
        appServer() !== undefined ||
        typeof rendererBridge(host)?.sendMessageFromView === "function"
      );
    },
    async send<T = unknown>(
      type: string,
      payload: Record<string, unknown> = {},
    ) {
      const send = appServer();
      if (send !== undefined) {
        try {
          return (await send(type, payload)) as T;
        } catch {
          return null;
        }
      }
      const nativeBridge = rendererBridge(host);
      if (typeof nativeBridge?.sendMessageFromView !== "function") return null;
      await nativeBridge.sendMessageFromView({ type, ...payload });
      return undefined;
    },
    async rpc<T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
    ) {
      const send = appServer();
      if (send !== undefined) {
        try {
          return (await send(method, params)) as T;
        } catch {
          return null;
        }
      }
      try {
        const flatRpcMethods = new Set([
          "get-global-state",
          "set-global-state",
        ]);
        const body = flatRpcMethods.has(method)
          ? (params.params ?? params)
          : params.params !== undefined
            ? { params: params.params }
            : params;
        return await getHttp().post<T>(`vscode://codex/${method}`, body);
      } catch {
        return null;
      }
    },
    navigate(path, navigationState) {
      return bridge.send(
        "navigate-to-route",
        navigationState === undefined
          ? { path }
          : { path, state: navigationState },
      );
    },
    on(type, handler) {
      const handlers = state.messageHandlers.get(type) ?? new Set();
      handlers.add(handler);
      state.messageHandlers.set(type, handlers);
      if (
        state.messageListener === null &&
        typeof host.addEventListener === "function"
      ) {
        state.messageListener = (event: Event): void => {
          const message = (event as MessageEvent<unknown>).data;
          if (
            typeof message !== "object" ||
            message === null ||
            typeof (message as { type?: unknown }).type !== "string"
          ) {
            return;
          }
          const typed = message as BridgeMessage;
          for (const callback of state.messageHandlers.get(typed.type) ?? []) {
            callback(typed);
          }
        };
        host.addEventListener("message", state.messageListener);
      }
      return trackSubscription(resources, () => {
        const registered = state.messageHandlers.get(type);
        registered?.delete(handler);
        if (registered?.size === 0) state.messageHandlers.delete(type);
        if (
          state.messageHandlers.size === 0 &&
          state.messageListener !== null &&
          typeof host.removeEventListener === "function"
        ) {
          host.removeEventListener("message", state.messageListener);
          state.messageListener = null;
        }
      });
    },
  };
  return bridge;
}

function queryClientInternal(
  host: CapabilityHost,
): QueryClientInternal | null {
  const document = host.document;
  if (document === undefined) return null;
  const node = document.querySelector("nav") ?? document.documentElement;
  const fiberKey = Object.keys(node).find(
    (key) =>
      key.startsWith("__reactContainer$") ||
      key.startsWith("__reactFiber$"),
  );
  let fiber =
    fiberKey === undefined
      ? null
      : (Reflect.get(node, fiberKey) as Fiber | null);
  for (let depth = 0; depth < 200 && fiber !== null; depth += 1) {
    const value =
      typeof fiber.memoizedProps === "object" &&
      fiber.memoizedProps !== null &&
      "value" in fiber.memoizedProps
        ? (fiber.memoizedProps as { value?: unknown }).value
        : undefined;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as QueryClientInternal).getQueryCache === "function" &&
      typeof (value as QueryClientInternal).setQueryData === "function"
    ) {
      return value as QueryClientInternal;
    }
    fiber = fiber.return ?? null;
  }
  return null;
}

function queryClientFacade(host: CapabilityHost): QueryClientApi | null {
  const client = queryClientInternal(host);
  if (client === null) return null;
  return {
    getQueryCache() {
      return {
        getAll() {
          return client.getQueryCache?.().getAll?.() ?? [];
        },
      };
    },
    getQueryData<T = unknown>(queryKey: readonly unknown[]) {
      return client.getQueryData?.<T>(queryKey);
    },
    setQueryData<T = unknown>(
      queryKey: readonly unknown[],
      value: T | ((current: T | undefined) => T | undefined),
    ) {
      return client.setQueryData?.(queryKey, value);
    },
    invalidateQueries(options) {
      return client.invalidateQueries?.(options) ?? Promise.resolve();
    },
  };
}

function getStatsigClients(host: CapabilityHost): StatsigClient[] {
  const statsig = host.__STATSIG__;
  if (statsig === undefined) return [];
  const clients = [
    statsig.firstInstance,
    statsig.instance,
    ...Object.values(statsig.instances ?? {}),
  ].filter((client): client is StatsigClient => client !== undefined);
  return [...new Set(clients)];
}

function ensureStatsigPatchStore(client: StatsigClient): StatsigPatchStore {
  const existing = client[STATSIG_PATCH_STORE_KEY];
  if (existing !== undefined) return existing;
  const created: StatsigPatchStore = {
    origCheckGate: client.checkGate?.bind(client),
    origGetFeatureGate: client.getFeatureGate?.bind(client),
    origOverrideAdapter: client.overrideAdapter ?? null,
    gates: new Map(),
  };
  client[STATSIG_PATCH_STORE_KEY] = created;
  return created;
}

function effectiveStatsigOverride(
  entry: StatsigOverrideEntry | undefined,
): boolean | undefined {
  if (entry === undefined) return undefined;
  let value: boolean | undefined;
  for (const ownerValue of entry.owners.values()) value = ownerValue;
  return value;
}

function reinstallStatsigOverrides(client: StatsigClient): void {
  const store = client[STATSIG_PATCH_STORE_KEY];
  if (store === undefined) return;
  if (store.gates.size === 0) {
    if (store.origCheckGate !== undefined) {
      client.checkGate = store.origCheckGate;
    }
    if (store.origGetFeatureGate !== undefined) {
      client.getFeatureGate = store.origGetFeatureGate;
    }
    client.overrideAdapter = store.origOverrideAdapter;
    delete client[STATSIG_PATCH_STORE_KEY];
    return;
  }
  const previous = store.origOverrideAdapter;
  client.overrideAdapter = {
    getGateOverride(gate, user, options) {
      const entry =
        gate?.name === undefined ? undefined : store.gates.get(gate.name);
      const value = effectiveStatsigOverride(entry);
      if (value !== undefined) {
        return {
          ...gate,
          value,
          ruleID: "explodex-override",
        };
      }
      return previous?.getGateOverride?.(gate, user, options) ?? null;
    },
    getDynamicConfigOverride:
      previous?.getDynamicConfigOverride?.bind(previous),
    getExperimentOverride: previous?.getExperimentOverride?.bind(previous),
    getLayerOverride: previous?.getLayerOverride?.bind(previous),
    getParamStoreOverride:
      previous?.getParamStoreOverride?.bind(previous),
  };
  if (store.origCheckGate !== undefined) {
    client.checkGate = (gate, ...rest) =>
      effectiveStatsigOverride(store.gates.get(gate)) ??
      store.origCheckGate?.(gate, ...rest) ??
      false;
  }
  if (store.origGetFeatureGate !== undefined) {
    client.getFeatureGate = (gate, ...rest) => {
      const value = effectiveStatsigOverride(store.gates.get(gate));
      if (value === undefined) {
        return store.origGetFeatureGate?.(gate, ...rest) ?? {};
      }
      return {
        name: gate,
        value,
        ruleID: "explodex-override",
        idType: "userID",
        details: { reason: "explodex-override" },
      };
    };
  }
}

function notifyStatsigValuesUpdated(host: CapabilityHost): void {
  for (const client of getStatsigClients(host)) {
    try {
      client._memoCache = {};
      client.$emt?.({
        name: "values_updated",
        status: client.loadingStatus ?? "Ready",
        values: null,
      });
    } catch {
      // One private client cannot prevent remaining clients from updating.
    }
  }
}

function createFlags(
  host: CapabilityHost,
  pluginId: string,
  ownerKey: string,
  resources: TrackedResourceRegistry,
): FlagsApi {
  const ownedOverrideKeys = new Set<string>();
  const ownerFor = (requestedPluginId?: string): string => {
    const owner =
      requestedPluginId === undefined || requestedPluginId === pluginId
      ? ownerKey
      : `${requestedPluginId}:${ownerKey}`;
    ownedOverrideKeys.add(owner);
    return owner;
  };
  const clearOwners = (owners: ReadonlySet<string>): number => {
    const clients = getStatsigClients(host);
    for (const client of clients) {
      const store = client[STATSIG_PATCH_STORE_KEY];
      if (store === undefined) continue;
      for (const [gateId, entry] of store.gates) {
        for (const owner of owners) entry.owners.delete(owner);
        if (entry.owners.size === 0) store.gates.delete(gateId);
      }
      reinstallStatsigOverrides(client);
    }
    return clients.length;
  };
  let overrideCleanupTracked = false;
  const ensureOverrideCleanup = (): void => {
    if (overrideCleanupTracked) return;
    overrideCleanupTracked = true;
    resources.track.subscription(() => {
      const clients = clearOwners(ownedOverrideKeys);
      ownedOverrideKeys.clear();
      if (clients > 0) notifyStatsigValuesUpdated(host);
    });
  };
  const flags: FlagsApi = {
    getQueryClient() {
      return queryClientFacade(host);
    },
    readStatsigGate(gateId) {
      try {
        const storage = host.localStorage;
        for (let index = 0; index < (storage?.length ?? 0); index += 1) {
          const key = storage?.key(index);
          if (!key?.startsWith("statsig.cached.evaluations.")) continue;
          const raw = storage?.getItem(key);
          if (!raw) continue;
          const envelope = JSON.parse(raw) as { data?: unknown };
          if (typeof envelope.data !== "string") continue;
          const data = JSON.parse(envelope.data) as {
            feature_gates?: Record<string, { value?: unknown }>;
          };
          const value = data.feature_gates?.[gateId]?.value;
          if (typeof value === "boolean") return value;
        }
      } catch {
        // Fall through to private clients.
      }
      for (const client of getStatsigClients(host)) {
        try {
          const value = client.checkGate?.(gateId);
          if (typeof value === "boolean") return value;
        } catch {
          // Continue across clients.
        }
      }
      return null;
    },
    setStatsigGateOverride(gateId, value, options = {}) {
      if (!gateId) return false;
      const clients = getStatsigClients(host);
      if (clients.length === 0) return false;
      const owner = ownerFor(options.pluginId);
      ensureOverrideCleanup();
      for (const client of clients) {
        const store = ensureStatsigPatchStore(client);
        if (value === null) {
          const entry = store.gates.get(gateId);
          entry?.owners.delete(owner);
          if (entry?.owners.size === 0) store.gates.delete(gateId);
        } else {
          const entry = store.gates.get(gateId) ?? {
            owners: new Map<string, boolean>(),
          };
          entry.owners.delete(owner);
          entry.owners.set(owner, value);
          store.gates.set(gateId, entry);
        }
        reinstallStatsigOverrides(client);
      }
      if (options.notify !== false) notifyStatsigValuesUpdated(host);
      return true;
    },
    clearStatsigGateOverrides(options = {}) {
      const owner = ownerFor(options.pluginId);
      const clients = clearOwners(new Set([owner]));
      ownedOverrideKeys.delete(owner);
      if (clients > 0) notifyStatsigValuesUpdated(host);
    },
    notifyStatsigValuesUpdated() {
      notifyStatsigValuesUpdated(host);
    },
    async invalidateQueries(queryKeys) {
      const client = queryClientFacade(host);
      if (client !== null) {
        await Promise.all(
          queryKeys.map((queryKey) =>
            client.invalidateQueries({ queryKey }).catch(() => undefined)
          ),
        );
      }
      const nativeBridge = rendererBridge(host);
      const sendMessage =
        nativeBridge?.sendMessageFromView?.bind(nativeBridge);
      if (sendMessage === undefined) return;
      await Promise.all(
        queryKeys.map((queryKey) =>
          sendMessage({
              type: "query-cache-invalidate",
              queryKey,
            })
            .catch(() => undefined)
        ),
      );
    },
    async propagate(options = {}) {
      if (options.statsigGates !== undefined) {
        for (const [gateId, value] of Object.entries(options.statsigGates)) {
          flags.setStatsigGateOverride(gateId, value, {
            pluginId: options.pluginId ?? pluginId,
            notify: false,
          });
        }
      }
      notifyStatsigValuesUpdated(host);
      const keys = [...(options.queryKeys ?? [])];
      if (!options.skipStandardInvalidation && options.hostId) {
        keys.push(
          ["experimental-features", "list", options.hostId],
          ["config", "user", options.hostId],
          ["user-saved-config"],
        );
      }
      const unique = new Map<string, readonly unknown[]>();
      for (const key of keys) unique.set(JSON.stringify(key), key);
      await flags.invalidateQueries([...unique.values()]);
    },
  };
  return flags;
}

function createStorage(
  host: CapabilityHost,
  bridge: BridgeApi,
  resources: TrackedResourceRegistry,
): PluginCapabilityApi["storage"] {
  const fullKey = (key: string): string =>
    key.startsWith(PERSISTED_PREFIX) ? key : `${PERSISTED_PREFIX}${key}`;
  return {
    persisted: {
      get<T = unknown>(key: string, fallback?: T): T {
        const raw = host.localStorage?.getItem(fullKey(key));
        if (raw === null || raw === undefined) return fallback as T;
        try {
          return JSON.parse(raw) as T;
        } catch {
          return raw as T;
        }
      },
      set(key, value) {
        if (value === undefined) {
          host.localStorage?.removeItem(fullKey(key));
          return;
        }
        host.localStorage?.setItem(fullKey(key), JSON.stringify(value));
      },
      remove(key) {
        host.localStorage?.removeItem(fullKey(key));
      },
      keys() {
        const keys: string[] = [];
        const storage = host.localStorage;
        for (let index = 0; index < (storage?.length ?? 0); index += 1) {
          const key = storage?.key(index);
          if (key?.startsWith(PERSISTED_PREFIX)) {
            keys.push(key.slice(PERSISTED_PREFIX.length));
          }
        }
        return keys;
      },
      subscribe<T = unknown>(key: string, callback: (value: T) => void) {
        const handler = (event: Event): void => {
          if ((event as StorageEvent).key === fullKey(key)) {
            callback(this.get<T>(key));
          }
        };
        if (typeof host.addEventListener === "function") {
          host.addEventListener("storage", handler);
        }
        return trackSubscription(resources, () => {
          host.removeEventListener?.("storage", handler);
        });
      },
    },
    settings: {
      async get<T = unknown>(key: string, fallback?: T) {
        const response = await bridge.rpc<{ value?: T }>("get-setting", {
          params: { key },
        });
        return response?.value ?? (fallback as T);
      },
      async set(key, value) {
        await bridge.rpc("set-setting", {
          params: { key, value },
        });
      },
    },
    globalState: {
      async get<T = unknown>(key: string) {
        const response = await bridge.rpc<{ value?: T }>("get-global-state", {
          params: { key },
        });
        return response?.value;
      },
      async set(key, value) {
        await bridge.rpc("set-global-state", {
          params: { key, value },
        });
        queryClientFacade(host)?.setQueryData(
          ["vscode", "get-global-state", JSON.stringify({ key })],
          { value },
        );
      },
    },
  };
}

function createHttp(
  host: CapabilityHost,
  bridge: BridgeApi,
  resources: TrackedResourceRegistry,
): HttpApi {
  let nextRequest = 1;
  return {
    isAvailable() {
      return bridge.isAvailable();
    },
    request<T = unknown>(
      method: string,
      url: string,
      options: HttpRequestOptions = {},
    ): Promise<HttpResponse<T>> {
      if (!bridge.isAvailable()) {
        return Promise.reject(new Error("Renderer bridge unavailable"));
      }
      const requestId =
        host.crypto?.randomUUID?.() ??
        `explodex-${Date.now()}-${nextRequest++}`;
      const controller = new AbortController();
      const signal = options.signal;
      const onAbort = (): void => controller.abort();
      if (signal !== undefined) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      return new Promise<HttpResponse<T>>((resolve, reject) => {
        let settled = false;
        const cleanupAbort = trackSubscription(resources, () => {
          if (!settled) controller.abort();
        });
        const finish = (): void => {
          if (settled) return;
          settled = true;
          stop();
          signal?.removeEventListener("abort", onAbort);
          cleanupAbort();
        };
        const onMessage = (message: BridgeMessage): void => {
          if (message.requestId !== requestId) return;
          finish();
          if (
            message.responseType === "success" &&
            typeof message.status === "number" &&
            message.status >= 200 &&
            message.status < 300
          ) {
            try {
              resolve({
                status: message.status,
                headers:
                  typeof message.headers === "object" &&
                  message.headers !== null
                    ? (message.headers as Record<string, string>)
                    : {},
                body:
                  typeof message.bodyJsonString === "string"
                    ? (JSON.parse(message.bodyJsonString) as T)
                    : null,
              });
            } catch (error: unknown) {
              reject(error);
            }
            return;
          }
          reject(
            new Error(
              typeof message.errorMessage === "string"
                ? message.errorMessage
                : `HTTP ${String(message.status ?? "request failed")}`,
            ),
          );
        };
        const stop = bridge.on("fetch-response", onMessage);
        controller.signal.addEventListener(
          "abort",
          () => {
            if (settled) return;
            finish();
            void bridge.send("cancel-fetch", { requestId });
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
        if (controller.signal.aborted) {
          finish();
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        void bridge.send("fetch", {
            requestId,
            method,
            url,
            headers: {
              "OAI-Language": "en",
              originator: "Codex Desktop",
              ...options.headers,
            },
            body:
              options.body === undefined
                ? undefined
                : JSON.stringify(options.body),
          })
          .then((sent) => {
            if (sent !== null || settled) return;
            finish();
            reject(new Error("Renderer bridge request failed"));
          })
          .catch((error: unknown) => {
            if (settled) return;
            finish();
            reject(error);
          });
      });
    },
    async get<T = unknown>(url: string, options?: HttpRequestOptions) {
      return (await this.request<T>("GET", url, options)).body;
    },
    async post<T = unknown>(
      url: string,
      body?: unknown,
      options: HttpRequestOptions = {},
    ) {
      return (await this.request<T>("POST", url, { ...options, body })).body;
    },
  };
}

function rootFiber(document: Document | undefined): Fiber | null {
  if (document === undefined) return null;
  const root = document.querySelector("#root") ?? document.body;
  if (root === null) return null;
  const key = Object.keys(root).find(
    (name) =>
      name.startsWith("__reactContainer$") ||
      name.startsWith("__reactFiber$"),
  );
  let fiber =
    key === undefined ? null : (Reflect.get(root, key) as Fiber | null);
  while (fiber?.return) fiber = fiber.return;
  return fiber;
}

function walkFibers(
  document: Document | undefined,
  visit: (fiber: Fiber) => boolean,
  max = 150_000,
): boolean {
  const root = rootFiber(document);
  if (root === null) return false;
  const stack = [root];
  const seen = new Set<Fiber>();
  for (let count = 0; stack.length > 0 && count < max; count += 1) {
    const fiber = stack.pop();
    if (fiber === undefined || seen.has(fiber)) continue;
    seen.add(fiber);
    try {
      if (visit(fiber)) return true;
    } catch {
      // Private host traversal is best effort.
    }
    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
  }
  return false;
}

function fiberHookStates(fiber: Fiber): unknown[] {
  const values: unknown[] = [];
  let hook = fiber.memoizedState;
  for (let guard = 0; guard < 400 && hook !== null; guard += 1) {
    if (typeof hook !== "object" || hook === null) break;
    const record = hook as { memoizedState?: unknown; next?: unknown };
    values.push(record.memoizedState);
    hook = record.next;
  }
  return values;
}

function findThreadConversation(
  document: Document | undefined,
  conversationId: string,
): PluginCapabilityApi["codex"] extends {
  getThreadConversation(id: string): infer T;
}
  ? T
  : never {
  let found: ReturnType<CodexApi["getThreadConversation"]> = null;
  walkFibers(document, (fiber) => {
    const seen = new WeakSet<object>();
    const scan = (value: unknown, depth: number): void => {
      if (
        found !== null ||
        depth > 4 ||
        typeof value !== "object" ||
        value === null ||
        seen.has(value)
      ) {
        return;
      }
      seen.add(value);
      const record = value as Record<string, unknown>;
      if (
        record.id === conversationId &&
        typeof record.latestThreadSettings === "object" &&
        record.latestThreadSettings !== null
      ) {
        found = record as ReturnType<CodexApi["getThreadConversation"]>;
        return;
      }
      for (const key of Object.keys(record).slice(0, 50)) {
        scan(record[key], depth + 1);
      }
    };
    for (const state of fiberHookStates(fiber)) scan(state, 1);
    scan(fiber.memoizedProps, 1);
    return found !== null;
  });
  return found;
}

function findNextTurnSetter(
  document: Document | undefined,
  conversationId: string,
): ((model: string, effort?: string) => unknown) | null {
  let setter: ((model: string, effort?: string) => unknown) | null = null;
  walkFibers(document, (fiber) => {
    for (const state of fiberHookStates(fiber)) {
      if (!Array.isArray(state) || typeof state[0] !== "function") continue;
      const source = Function.prototype.toString.call(state[0]);
      if (!source.includes("update-thread-settings-for-next-turn")) continue;
      if (Array.isArray(state[1]) && state[1][0] === conversationId) {
        setter = state[0] as (model: string, effort?: string) => unknown;
        return true;
      }
    }
    return false;
  });
  return setter;
}

function createCodex(host: CapabilityHost): CodexApi {
  return {
    getThreadConversation(conversationId) {
      return findThreadConversation(host.document, conversationId);
    },
    getThreadModel(conversationId) {
      const conversation = findThreadConversation(
        host.document,
        conversationId,
      );
      return (
        conversation?.latestThreadSettings?.model ??
        conversation?.latestCollaborationMode?.settings?.model ??
        conversation?.latestModel ??
        null
      );
    },
    getThreadEffort(conversationId) {
      const conversation = findThreadConversation(
        host.document,
        conversationId,
      );
      return (
        conversation?.latestCollaborationMode?.settings?.reasoning_effort ??
        conversation?.latestThreadSettings?.effort ??
        conversation?.latestReasoningEffort ??
        null
      );
    },
    async applyThreadSettingsForNextTurn(conversationId, settings = {}) {
      const setter = findNextTurnSetter(host.document, conversationId);
      const model = settings.model ?? this.getThreadModel(conversationId);
      if (setter === null || model === null) return false;
      try {
        return (await setter(model, settings.effort)) !== false;
      } catch {
        return false;
      }
    },
  };
}

function createComposer(host: CapabilityHost): ComposerApi {
  const input = (): HTMLElement | null => {
    const document = host.document;
    if (document === undefined) return null;
    const found =
      document.querySelector(".ProseMirror") ??
      firstExisting(document, [
        "textarea",
        '[contenteditable="true"]',
        '[role="textbox"]',
      ]);
    return found instanceof HTMLElement ? found : null;
  };
  const blocked = (): boolean => {
    const document = host.document;
    return Boolean(
      document?.querySelector('[role="dialog"][data-state="open"]') ??
        document?.querySelector("[data-codex-terminal]:focus-within"),
    );
  };
  const dispatch = (
    target: HTMLElement,
    text: string,
    inputType: string,
  ): void => {
    target.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType,
        data: text,
      }),
    );
  };
  return {
    getInput: input,
    focus() {
      const found = input();
      found?.focus();
      return found !== null;
    },
    getText() {
      const found = input();
      if (found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement) {
        return found.value;
      }
      return found?.textContent ?? "";
    },
    insertText(text) {
      const found = input();
      if (found === null || blocked()) return false;
      found.focus();
      if (found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement) {
        const start = found.selectionStart ?? found.value.length;
        const end = found.selectionEnd ?? found.value.length;
        found.value = `${found.value.slice(0, start)}${text}${found.value.slice(end)}`;
        found.selectionStart = found.selectionEnd = start + text.length;
        dispatch(found, text, "insertText");
        return true;
      }
      host.document?.execCommand("insertText", false, text);
      dispatch(found, text, "insertText");
      return true;
    },
    setText(text) {
      const found = input();
      if (found === null || blocked()) return false;
      found.focus();
      if (found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement) {
        found.value = text;
        found.selectionStart = found.selectionEnd = text.length;
        dispatch(found, text, "insertReplacementText");
        return true;
      }
      const selection = host.getSelection?.();
      if (selection !== null && selection !== undefined && host.document) {
        const range = host.document.createRange();
        range.selectNodeContents(found);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      host.document?.execCommand("insertText", false, text);
      dispatch(found, text, "insertReplacementText");
      return true;
    },
  };
}

function createFormat(): FormatApi {
  const resolvePath = (context: unknown, path: string): unknown => {
    const segments: Array<string | number> = [];
    const expression = /([^[.\]]+)|\[(\d+)\]/g;
    for (const match of path.matchAll(expression)) {
      segments.push(match[1] ?? Number(match[2]));
    }
    let current = context;
    for (const segment of segments) {
      if (typeof current !== "object" || current === null) return undefined;
      current = Reflect.get(current, segment);
    }
    return current;
  };
  const duration = (
    differenceMs: number,
    options: {
      past?: string;
      ceilMinutes?: boolean;
      includeMinuteRemainder?: boolean;
      dayThresholdHours?: number;
    } = {},
  ): string => {
    if (differenceMs <= 0) return options.past ?? "0m";
    const minutes =
      options.ceilMinutes === false
        ? Math.floor(differenceMs / 60_000)
        : Math.ceil(differenceMs / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < (options.dayThresholdHours ?? 48)) {
      const remainder = minutes % 60;
      return options.includeMinuteRemainder === false || remainder === 0
        ? `${hours}h`
        : `${hours}h${remainder}m`;
    }
    return `${Math.floor(hours / 24)}d`;
  };
  return {
    template(template, context, options = {}) {
      return template.replace(/\{([^{}]+)\}/g, (_full, path: string) => {
        const value = resolvePath(context, path.trim());
        return value === null || value === undefined || value === ""
          ? options.fallback ?? "—"
          : String(value);
      });
    },
    countdown(unixSeconds, options = {}) {
      if (unixSeconds === null || unixSeconds === undefined) {
        return options.fallback ?? "—";
      }
      return duration(unixSeconds * 1_000 - Date.now(), options);
    },
    datetimeCountdown(unixSeconds, options = {}) {
      if (unixSeconds === null || unixSeconds === undefined) {
        return options.fallback ?? "—";
      }
      const date = new Date(unixSeconds * 1_000);
      if (Number.isNaN(date.getTime())) return options.fallback ?? "—";
      const datePart = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(date);
      const timePart = new Intl.DateTimeFormat(undefined, {
        timeStyle: "short",
      }).format(date);
      const difference = date.getTime() - Date.now();
      if (difference <= 0) {
        return `${datePart} ${timePart} ${options.pastLabel ?? "(passed)"}`;
      }
      return `${datePart} ${timePart}${options.separator ?? " · "}in ${duration(
        difference,
        {
          ...options,
          ceilMinutes: false,
          includeMinuteRemainder: false,
        },
      )}`;
    },
  };
}

function createQuery(host: CapabilityHost): QueryApi {
  return {
    testId(id) {
      return host.document?.querySelector(`[data-testid="${id}"]`) ?? null;
    },
    portal(name) {
      const aliases: Record<string, string> = {
        aboveComposer: "[data-above-composer-portal]",
        aboveComposerQueue: "[data-above-composer-queue-portal]",
        mcpApp: '[data-mcp-app-portal-target="true"]',
        threadFooter: '[data-thread-scroll-footer="true"]',
        browserBanner:
          '[data-testid="browser-sidebar-top-banner-portal"]',
      };
      return (
        host.document?.querySelector(aliases[name] ?? `[data-${name}]`) ??
        null
      );
    },
    one(selector) {
      return host.document?.querySelector(selector) ?? null;
    },
    all(selector) {
      return Array.from(host.document?.querySelectorAll(selector) ?? []);
    },
  };
}

function createInjection(
  host: CapabilityHost,
  pluginId: string,
  ownerKey: string,
  resources: TrackedResourceRegistry,
  api: () => PluginCapabilityApi,
): InjectApi {
  const mounts = new Map<ZoneId, HTMLDivElement>();
  const positionMount = (
    anchor: Element,
    mount: HTMLDivElement,
    zoneId: ZoneId,
    strategy: MountStrategy,
  ): void => {
    if (strategy === "prepend") {
      anchor.insertBefore(mount, anchor.firstChild);
    } else if (
      strategy === "after-input" &&
      anchor.parentElement !== null
    ) {
      mount.className = "ex-mount-composer-actions";
      anchor.parentElement.appendChild(mount);
    } else if (strategy === "fixed") {
      mount.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:2147483640";
      anchor.appendChild(mount);
    } else {
      if (zoneId === "aboveComposer") {
        mount.className = "ex-mount-above-composer";
      }
      anchor.appendChild(mount);
    }
  };
  const inject: InjectApi = {
    mount(zoneId, nodeOrFactory, options = {}) {
      const document = host.document;
      const anchor = resolveZoneAnchor(document, zoneId);
      if (document === undefined || anchor === null) return false;
      installStyles(host, ownerKey, resources);
      let mount = mounts.get(zoneId);
      if (mount === undefined || !mount.isConnected) {
        mount = document.createElement("div");
        mount.setAttribute(MOUNT_ATTR, zoneId);
        mount.setAttribute(PLUGIN_ATTR, options.pluginId ?? pluginId);
        positionMount(
          anchor,
          mount,
          zoneId,
          options.position ?? ZONE_MOUNTS[zoneId],
        );
        mounts.set(zoneId, mount);
        resources.track.mount(mount);
      }
      if (mount.childElementCount > 0 && !options.replace) return true;
      const context: MountContext = {
        api: api(),
        mountPoint: mount,
        zoneId,
        pluginId,
      };
      mount.replaceChildren(
        typeof nodeOrFactory === "function"
          ? nodeOrFactory(context)
          : nodeOrFactory,
      );
      return true;
    },
    waitFor(zoneId, callback) {
      return inject.observeZone(zoneId, callback, { once: true });
    },
    observeZone(zoneId, callback, options = {}) {
      const document = host.document;
      if (
        document === undefined ||
        typeof MutationObserver !== "function"
      ) {
        return trackSubscription(resources, () => {});
      }
      let stopped = false;
      let frame: number | null = null;
      let previous: Element | null = null;
      const cancelFrame = (): void => {
        if (frame === null) return;
        host.cancelAnimationFrame?.(frame);
        frame = null;
      };
      const check = (): void => {
        frame = null;
        if (stopped) return;
        const anchor = resolveZoneAnchor(document, zoneId);
        if (anchor === null) {
          previous = null;
          return;
        }
        if (
          !options.includeMutations &&
          anchor === previous &&
          anchor.isConnected
        ) {
          return;
        }
        const old = previous;
        previous = anchor;
        callback(anchor, { zoneId, previousAnchor: old });
        if (options.once) stop();
      };
      const schedule = (): void => {
        if (stopped || frame !== null) return;
        frame =
          host.requestAnimationFrame?.(() => check()) ??
          (setTimeout(check, 0) as unknown as number);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      const stop = trackSubscription(resources, () => {
        stopped = true;
        cancelFrame();
        observer.disconnect();
      });
      schedule();
      return stop;
    },
    observe(zoneId, callback, options) {
      return inject.observeZone(zoneId, callback, options);
    },
  };
  return inject;
}

function sidebarRoot(host: CapabilityHost): Element | null {
  return resolveZoneAnchor(host.document, "sidebar");
}

function elementLabel(element: Element | null): string {
  return (
    element?.getAttribute("aria-label") ??
    element?.textContent ??
    ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

function createSidebarNav(
  host: CapabilityHost,
  ownerKey: string,
  resources: TrackedResourceRegistry,
): SidebarNavApi {
  const state = stateFor(host);
  const find = (
    labels: readonly string[],
    options: { exact?: boolean; fromEnd?: boolean } = {},
  ): Element | null => {
    const root = sidebarRoot(host);
    if (root === null) return null;
    const candidates = Array.from(
      root.querySelectorAll(
        "button, a, [role='button'], [role='menuitem']",
      ),
    );
    if (options.fromEnd) candidates.reverse();
    for (const candidate of candidates) {
      const text = elementLabel(candidate).toLowerCase();
      if (
        labels.some((label) => {
          const wanted = label.toLowerCase();
          return options.exact
            ? text === wanted || text.startsWith(`${wanted} `)
            : text === wanted ||
                text.startsWith(`${wanted} `) ||
                text.includes(wanted);
        })
      ) {
        return candidate;
      }
    }
    return null;
  };
  const mountFor = (key: string): HTMLDivElement | null => {
    const document = host.document;
    if (document === undefined) return null;
    const fullKey = `${ownerKey}:${key}`;
    const existing = state.navMounts.get(fullKey);
    if (existing?.isConnected) return existing;
    const mount = document.createElement("div");
    mount.className = "ex-nav-row";
    mount.dataset.explodexNav = fullKey;
    state.navMounts.set(fullKey, mount);
    resources.track.mount(mount);
    resources.track.subscription(() => state.navMounts.delete(fullKey));
    return mount;
  };
  return {
    find,
    insertAfter(referenceLabels, elementOrFactory, key = "nav-after") {
      const reference = find(referenceLabels);
      const row =
        reference?.closest("[data-explodex-nav]") ??
        reference?.closest("li") ??
        reference?.parentElement ??
        null;
      const mount = mountFor(key);
      if (row === null || row.parentElement === null || mount === null) {
        return false;
      }
      mount.replaceChildren(
        typeof elementOrFactory === "function"
          ? elementOrFactory({ mount })
          : elementOrFactory,
      );
      row.parentElement.insertBefore(mount, row.nextSibling);
      return true;
    },
    insertBefore(referenceLabels, elementOrFactory, key = "nav-before") {
      const labels =
        typeof referenceLabels === "string"
          ? [referenceLabels]
          : [...referenceLabels];
      const footer = labels.some((label) =>
        ["settings", "profile", "account"].includes(label.toLowerCase())
      );
      const reference = find(labels, {
        exact: footer,
        fromEnd: footer,
      });
      const mount = mountFor(key);
      if (mount === null) return false;
      mount.replaceChildren(
        typeof elementOrFactory === "function"
          ? elementOrFactory({ mount })
          : elementOrFactory,
      );
      if (footer) {
        const root = sidebarRoot(host);
        const footerHost =
          reference?.closest('[class*="absolute"][class*="bottom-0"]') ??
          root?.querySelector('[class*="absolute"][class*="bottom-0"]');
        if (footerHost === null || footerHost === undefined) return false;
        footerHost.insertBefore(mount, footerHost.firstChild);
        return true;
      }
      const row =
        reference?.closest("[data-explodex-nav]") ??
        reference?.closest("li") ??
        reference?.parentElement ??
        null;
      if (row === null || row.parentElement === null) return false;
      row.parentElement.insertBefore(mount, row);
      return true;
    },
    remove(key) {
      const fullKey = `${ownerKey}:${key}`;
      state.navMounts.get(fullKey)?.remove();
      state.navMounts.delete(fullKey);
    },
  };
}

function createUi(
  host: CapabilityHost,
  components: ComponentsApi,
  resources: TrackedResourceRegistry,
): UiApi {
  const state = stateFor(host);
  const close = (): void => {
    state.activePopover?.remove();
    state.activePopover = null;
  };
  const position = (
    panel: HTMLDivElement,
    options: {
      anchor?: Element;
      anchorRect?: Record<string, number | undefined>;
      width: number;
      side: "right" | "left" | "bottom";
    },
  ): void => {
    const rect =
      options.anchor?.getBoundingClientRect() ??
      (options.anchorRect === undefined
        ? null
        : {
            left: options.anchorRect.left ?? options.anchorRect.x ?? 0,
            top: options.anchorRect.top ?? options.anchorRect.y ?? 0,
            right:
              options.anchorRect.right ??
              (options.anchorRect.left ?? options.anchorRect.x ?? 0) +
                (options.anchorRect.width ?? 0),
            bottom:
              options.anchorRect.bottom ??
              (options.anchorRect.top ?? options.anchorRect.y ?? 0) +
                (options.anchorRect.height ?? 0),
          });
    if (rect === null) {
      panel.style.left = "12px";
      panel.style.top = "12px";
      return;
    }
    const margin = 8;
    const offset = 6;
    let left =
      options.side === "left"
        ? rect.left - options.width - offset
        : rect.right + offset;
    let top =
      options.side === "bottom" ? rect.bottom + offset : rect.top;
    left = Math.min(
      Math.max(margin, left),
      (host.innerWidth ?? 1_024) - options.width - margin,
    );
    top = Math.min(
      Math.max(margin, top),
      (host.innerHeight ?? 768) - (panel.offsetHeight || 360) - margin,
    );
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };
  return {
    navItem(options = {}) {
      const document = host.document;
      if (document === undefined) {
        throw new Error("Plugin UI capabilities require a renderer document.");
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = [
        "ex-nav-btn",
        options.compact ? "ex-nav-btn-compact" : "",
        options.className ?? "",
      ]
        .filter(Boolean)
        .join(" ");
      if (options.active) button.setAttribute("aria-current", "page");
      if (options.icon) {
        const icon = document.createElement("span");
        icon.textContent = options.icon;
        icon.setAttribute("aria-hidden", "true");
        button.appendChild(icon);
      }
      const text = document.createElement("span");
      text.style.flex = "1";
      text.textContent = options.subtitle ?? options.label ?? "";
      if (options.subtitle && options.label) text.title = options.label;
      button.appendChild(text);
      if (options.onClick) {
        button.addEventListener("click", options.onClick);
      }
      return button;
    },
    closePopover: close,
    repositionPopover(options = {}) {
      const backdrop = state.activePopover;
      const popoverState = backdrop?.dataset;
      const panel = backdrop?.querySelector(".ex-popover");
      if (
        backdrop === null ||
        backdrop === undefined ||
        !(panel instanceof HTMLDivElement)
      ) {
        return false;
      }
      const width = options.width ?? Number(popoverState?.width ?? 380);
      const side =
        options.side ??
        ((popoverState?.side as "right" | "left" | "bottom") || "right");
      panel.style.width = `${width}px`;
      position(panel, {
        anchor: options.anchor,
        anchorRect: options.anchorRect,
        width,
        side,
      });
      return true;
    },
    popover(options = {}) {
      const document = host.document;
      if (document === undefined) {
        throw new Error("Plugin UI capabilities require a renderer document.");
      }
      close();
      const backdrop = document.createElement("div");
      backdrop.className = "ex-popover-backdrop";
      const panel = document.createElement("div");
      panel.className = "ex-popover";
      const width = options.width ?? 380;
      const side = options.side ?? "right";
      panel.style.width = `${width}px`;
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", options.title ?? "Panel");
      const header = document.createElement("div");
      header.className = "ex-popover-header";
      const title = document.createElement("div");
      title.className = "ex-popover-title";
      title.textContent = options.title ?? "";
      header.append(
        title,
        components.button({
          label: "✕",
          color: "ghost",
          size: "iconSm",
          onClick: () => {
            close();
            options.onClose?.();
          },
        }),
      );
      const body = document.createElement("div");
      body.className = "ex-popover-body";
      const content =
        typeof options.content === "function"
          ? options.content()
          : options.content;
      if (typeof content === "string") body.textContent = content;
      else if (content !== undefined) body.appendChild(content);
      panel.append(header, body);
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);
      backdrop.dataset.width = String(width);
      backdrop.dataset.side = side;
      state.activePopover = backdrop;
      position(panel, {
        anchor: options.anchor,
        anchorRect: options.anchorRect,
        width,
        side,
      });
      const onClick = (event: MouseEvent): void => {
        if (event.target === backdrop) {
          close();
          options.onClose?.();
        }
      };
      backdrop.addEventListener("click", onClick);
      resources.track.mount(backdrop);
      resources.track.subscription(() => {
        if (state.activePopover === backdrop) state.activePopover = null;
      });
      if (typeof host.addEventListener === "function") {
        const onKey = (event: unknown): void => {
          if ((event as KeyboardEvent).key === "Escape") {
            close();
            options.onClose?.();
          }
        };
        resources.track.listen(
          {
            addEventListener(type, listener, listenerOptions) {
              host.addEventListener?.(
                type,
                listener as EventListenerOrEventListenerObject,
                listenerOptions as boolean | AddEventListenerOptions,
              );
            },
            removeEventListener(type, listener, listenerOptions) {
              host.removeEventListener?.(
                type,
                listener as EventListenerOrEventListenerObject,
                listenerOptions as boolean | EventListenerOptions,
              );
            },
          },
          "keydown",
          onKey,
        );
      }
      return backdrop;
    },
  };
}

export function createPluginCapabilities(options: {
  host?: Record<string, unknown>;
  pluginId: string;
  ownerKey: string;
  resources: TrackedResourceRegistry;
  log: PluginLogger;
}): PluginCapabilityApi {
  const host = (options.host ?? globalThis) as CapabilityHost;
  const state = stateFor(host);
  let http!: HttpApi;
  const bridge = createBridge(host, options.resources, () => http);
  const storage = createStorage(host, bridge, options.resources);
  const components = createComponents(
    host,
    options.ownerKey,
    options.resources,
  );
  const composer = createComposer(host);
  const codex = createCodex(host);
  const flags = createFlags(
    host,
    options.pluginId,
    options.ownerKey,
    options.resources,
  );
  const query = createQuery(host);
  const format = createFormat();
  let capabilities!: PluginCapabilityApi;
  const inject = createInjection(
    host,
    options.pluginId,
    options.ownerKey,
    options.resources,
    () => capabilities,
  );
  const sidebarNav = createSidebarNav(
    host,
    options.ownerKey,
    options.resources,
  );
  const ui = createUi(host, components, options.resources);
  http = createHttp(host, bridge, options.resources);
  capabilities = {
    storage,
    bridge,
    http,
    components,
    format,
    composer,
    codex,
    flags,
    query,
    inject,
    sidebarNav,
    ui,
    waitFor: inject.waitFor,
    mount(zoneId, nodeOrFactory, mountOptions = {}) {
      return inject.mount(zoneId, nodeOrFactory, {
        ...mountOptions,
        pluginId: options.pluginId,
      });
    },
    registerOptions(handlers) {
      if (typeof handlers.render !== "function") return;
      const prior = state.options.get(options.pluginId);
      const registration = {
        active: true,
        handlers,
        containers: prior?.containers ?? new Set<HTMLElement>(),
      };
      state.options.set(options.pluginId, registration);
      for (const container of registration.containers) {
        if (!container.isConnected) {
          registration.containers.delete(container);
          continue;
        }
        const context = {
          pluginId: options.pluginId,
          refresh(): void {
            if (
              container.isConnected &&
              state.options.get(options.pluginId) === registration
            ) {
              handlers.render(container, context);
            }
          },
        };
        handlers.render(container, context);
      }
      trackSubscription(options.resources, () => {
        registration.active = false;
        if (state.options.get(options.pluginId) !== registration) return;
        if (prior?.active) {
          state.options.set(options.pluginId, prior);
          for (const container of prior.containers) {
            if (!container.isConnected) {
              prior.containers.delete(container);
              continue;
            }
            const context = {
              pluginId: options.pluginId,
              refresh(): void {
                if (
                  container.isConnected &&
                  state.options.get(options.pluginId) === prior
                ) {
                  prior.handlers.render(container, context);
                }
              },
            };
            prior.handlers.render(container, context);
          }
        } else {
          state.options.delete(options.pluginId);
          for (const container of registration.containers) {
            container.replaceChildren();
          }
        }
      });
    },
    async migrate(migrations: readonly PluginMigration[]) {
      const ledgerKey = `${MIGRATION_LEDGER_PREFIX}${options.pluginId}`;
      const applied = new Set(
        storage.persisted.get<readonly string[]>(ledgerKey, []),
      );
      for (const migration of migrations) {
        if (
          !migration.id ||
          typeof migration.run !== "function" ||
          applied.has(migration.id)
        ) {
          continue;
        }
        try {
          await migration.run({
            storage,
            bridge,
            pluginId: options.pluginId,
            log: options.log,
            renameKey(oldKey, newKey) {
              const value = storage.persisted.get(oldKey, undefined);
              if (value === undefined) return false;
              if (
                storage.persisted.get(newKey, undefined) === undefined
              ) {
                storage.persisted.set(newKey, value);
              }
              storage.persisted.remove(oldKey);
              return true;
            },
          });
          applied.add(migration.id);
          storage.persisted.set(ledgerKey, [...applied]);
          options.log.info("migration applied", { id: migration.id });
        } catch (error: unknown) {
          options.log.error("migration failed (will retry next load)", {
            id: migration.id,
            error,
          });
        }
      }
    },
  };
  return capabilities;
}
