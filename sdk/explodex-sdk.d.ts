/**
 * Explodex SDK type definitions.
 *
 * The SDK is injected into the Codex Electron renderer and exposed as the
 * global `window.Explodex`. Plugins receive a {@link PluginAPI} (a superset of
 * {@link ExplodexAPI}) in their `register` setup callback.
 *
 * @see ./explodex-sdk.js
 * @see ../docs/sdk-api.md
 */

export {};

declare global {
  interface Window {
    /** The Explodex SDK runtime, present after injection. */
    Explodex?: ExplodexAPI;
    /** Plugin catalog injected by the app bundle / CDP injector. */
    __EXPLODEX_PLUGIN_CATALOG__?: PluginCatalogEntry[];
    /** Runtime paths injected by the app bundle (user plugins dir, relaunch script). */
    __EXPLODEX_PATHS__?: ExplodexPaths;
    /** Captured in-renderer AppServer router send function (set by SDK on load). */
    __explodexAppServerSend?: AppServerSend;
    /** Legacy alias for {@link Window.__explodexAppServerSend}. */
    __bcAppServerSend?: AppServerSend;
    /** Codex Electron bridge (theme, IPC, build flavor). */
    electronBridge?: ElectronBridge;
  }

  /** Always available in the renderer once the SDK is injected. */
  const Explodex: ExplodexAPI;
}

/** In-renderer AppServer `sendRequest` wrapper captured at runtime. */
export type AppServerSend = (type: string, payload?: Record<string, unknown>) => Promise<unknown>;

/** Subset of Codex's renderer `electronBridge` used by the SDK. */
export interface ElectronBridge {
  sendMessageFromView?(message: { type: string } & Record<string, unknown>): Promise<unknown>;
  getSystemThemeVariant?(): string;
  subscribeToSystemThemeVariant?(callback: (variant: string) => void): () => void;
  getBuildFlavor?(): string;
  usesOwlAppShell?(): boolean;
}

// ─── Core enums / unions ──────────────────────────────────────────────────

/** Built-in DOM zone identifiers plugins can mount into. */
export type ZoneId =
  | "aboveComposer"
  | "aboveComposerQueue"
  | "mcpAppPortal"
  | "threadFooter"
  | "browserSidebarBanner"
  | "homeAmbient"
  | "sidebar"
  | "composerActions"
  | "statusOverlay";

/** Where a mounted node is placed relative to its zone anchor. */
export type MountStrategy = "append" | "prepend" | "after-input" | "fixed";

/** Button color tokens (mirror Codex design tokens). */
export type ButtonColor =
  | "primary"
  | "secondary"
  | "outline"
  | "outlineActive"
  | "ghost"
  | "ghostActive"
  | "ghostMuted"
  | "ghostTertiary"
  | "danger";

/** Button size tokens. */
export type ButtonSize =
  | "default"
  | "large"
  | "medium"
  | "icon"
  | "iconSm"
  | "composer"
  | "composerSm"
  | "toolbar";

/** Log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Reasoning effort levels understood by Codex. */
export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | (string & {});

/** Popover placement relative to its anchor. */
export type PopoverSide = "right" | "left" | "bottom";

// ─── Zones ────────────────────────────────────────────────────────────────

export interface ZoneDefinition {
  id: ZoneId;
  description: string;
  /** CSS selectors tried in order to resolve the zone anchor. */
  selectors: string[];
  mount: MountStrategy;
  priority: number;
}

// ─── Logging ──────────────────────────────────────────────────────────────

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  detail: unknown;
}

export interface PluginLogger {
  debug(message: string, detail?: unknown): LogEntry;
  info(message: string, detail?: unknown): LogEntry;
  warn(message: string, detail?: unknown): LogEntry;
  error(message: string, detail?: unknown): LogEntry;
}

export interface LogAPI extends PluginLogger {
  /** Create a scoped logger for a plugin id. */
  plugin(pluginId: string): PluginLogger;
  /** Snapshot of recent log entries (capped buffer). */
  entries(): LogEntry[];
  /** Subscribe to new log entries; returns an unsubscribe function. */
  subscribe(fn: (entry: LogEntry) => void): () => void;
  /** Clear the in-memory log buffer. */
  clear(): void;
}

// ─── Bridge ───────────────────────────────────────────────────────────────

/**
 * Low-level access to Codex's in-renderer AppServer router and Electron bridge.
 *
 * Prefer {@link CodexAPI} helpers for turn/thread settings; the IPC-only path
 * does not always update the renderer atoms the composer reads at submit time.
 */
export interface BridgeAPI {
  /** Whether any send path (AppServer router or electronBridge) is available. */
  isAvailable(): boolean;
  /**
   * Send a view message by `type`.
   * - AppServer path: resolves with the router response, or `null` on error.
   * - electronBridge-only path: returns `undefined` (fire-and-forget).
   */
  send<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T | null | undefined>;
  /** Call an AppServer RPC method (falls back to the authenticated HTTP proxy). */
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T | null>;
  /** Navigate the renderer to a route path. */
  navigate(path: string): Promise<unknown>;
  /** Current system theme variant (e.g. `"dark"`). */
  theme(): string;
  /** Subscribe to theme changes; returns an unsubscribe function. */
  onThemeChange(callback: (variant: string) => void): () => void;
  /** Listen for `window` messages of a given `type`; returns an unsubscribe function. */
  on(type: string, handler: (data: { type: string } & Record<string, unknown>) => void): () => void;
  /** Codex build flavor string. */
  buildFlavor(): string;
  /** Whether Codex is running the Owl app shell. */
  usesOwlShell(): boolean;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T | null;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

/** Authenticated proxy to the Codex backend, routed through the Electron bridge. */
export interface HttpAPI {
  isAvailable(): boolean;
  request<T = unknown>(method: string, url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>>;
  get<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T | null>;
  post<T = unknown>(url: string, body?: unknown, options?: HttpRequestOptions): Promise<T | null>;
}

// ─── Storage ──────────────────────────────────────────────────────────────

/** Synchronous localStorage-backed store namespaced under Codex's persisted-atom prefix. */
export interface PersistedStorage {
  get<T = unknown>(key: string, fallback?: T): T;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  /** All persisted keys (without the internal prefix). */
  keys(): string[];
  /** Subscribe to cross-window changes for a key; returns an unsubscribe function. */
  subscribe<T = unknown>(key: string, callback: (value: T) => void): () => void;
}

/** Async Codex settings store (via AppServer RPC). */
export interface SettingsStorage {
  get<T = unknown>(key: string, fallback?: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
}

/** Async Codex global-state store (via AppServer RPC), kept in sync with React Query cache. */
export interface GlobalStateStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface StorageAPI {
  persisted: PersistedStorage;
  settings: SettingsStorage;
  globalState: GlobalStateStorage;
}

// ─── Components ───────────────────────────────────────────────────────────

export interface ButtonOptions {
  label?: string;
  children?: string;
  color?: ButtonColor;
  size?: ButtonSize;
  /** Force a square (icon) button. */
  uniform?: boolean;
  loading?: boolean;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  className?: string;
  onClick?: (event: MouseEvent) => void;
  /** Emoji/text string or an element node to use as the icon. */
  icon?: string | Node;
  [key: string]: unknown;
}

export interface SidebarItemOptions {
  label?: string;
  icon?: string;
  onClick?: (event: MouseEvent) => void;
  active?: boolean;
}

export interface PillOptions {
  label?: string;
  position?: "bottom-right" | "top-right";
}

export interface BadgeOptions {
  label?: string;
  count?: number | string;
}

export interface PanelOptions {
  title?: string;
  children?: Node | (() => Node) | string;
  className?: string;
}

export interface StatusToastOptions {
  duration?: number;
}

/** Styled DOM builders that mirror Codex's look and feel. */
export interface ComponentsAPI {
  button(options?: ButtonOptions): HTMLButtonElement;
  sidebarItem(options?: SidebarItemOptions): HTMLButtonElement;
  pill(options?: PillOptions): HTMLDivElement;
  badge(options?: BadgeOptions): HTMLSpanElement;
  panel(options?: PanelOptions): HTMLDivElement;
  /** Show a transient status toast in a fixed overlay. */
  statusToast(message: string, options?: StatusToastOptions): void;
}

// ─── Composer ─────────────────────────────────────────────────────────────

/** Read/write helpers for the active composer input (ProseMirror or textarea). */
export interface ComposerAPI {
  /** The current composer input element, or null if not mounted. */
  getInput(): HTMLElement | null;
  /** Focus the composer; returns false if no input is present. */
  focus(): boolean;
  /** Current composer text. */
  getText(): string;
  /** Insert text at the caret; returns false if blocked (dialog/terminal) or no input. */
  insertText(text: string): boolean;
}

// ─── Codex internals ──────────────────────────────────────────────────────

export interface ThreadConversation {
  id: string;
  latestThreadSettings?: { model?: string; effort?: string; [key: string]: unknown };
  latestCollaborationMode?: { settings?: { model?: string; reasoning_effort?: string } };
  latestModel?: string;
  latestReasoningEffort?: string;
  [key: string]: unknown;
}

export interface ThreadSettingsForNextTurn {
  model?: string;
  effort?: ReasoningEffort;
}

/** Access to Codex React-fiber state for the active thread. */
export interface CodexAPI {
  /** Root React fiber of the renderer tree, or null. */
  reactFiberRoot(): unknown;
  /** Depth-first walk of the fiber tree; `visit` returns true to stop early. */
  walkFibers(visit: (fiber: any) => boolean | void, max?: number): boolean;
  /** Find the in-renderer conversation-state object for a thread. */
  getThreadConversation(conversationId: string): ThreadConversation | null;
  /** Resolve the thread's current model. */
  getThreadModel(conversationId: string): string | null;
  /** Resolve the thread's current reasoning effort. */
  getThreadEffort(conversationId: string): string | null;
  /**
   * Apply model + reasoning effort for the NEXT turn of an existing thread via
   * the same in-renderer callback the intelligence dropdown uses.
   * Returns true on success.
   */
  applyThreadSettingsForNextTurn(
    conversationId: string,
    settings?: ThreadSettingsForNextTurn,
  ): Promise<boolean>;
}

// ─── Query ────────────────────────────────────────────────────────────────

/** Convenience DOM lookups for known Codex test ids and portals. */
export interface QueryAPI {
  testId(id: string): Element | null;
  /** Resolve a known portal by name, or `[data-<name>]` as a fallback. */
  portal(
    name:
      | "aboveComposer"
      | "aboveComposerQueue"
      | "mcpApp"
      | "threadFooter"
      | "browserBanner"
      | (string & {}),
  ): Element | null;
  one(selector: string): Element | null;
  all(selector: string): Element[];
}

// ─── Injection ────────────────────────────────────────────────────────────

export interface MountContext {
  api: ExplodexAPI;
  mountPoint: HTMLDivElement;
  zoneId: ZoneId;
  pluginId: string;
}

export interface MountOptions {
  pluginId?: string;
  /** Override the zone's default placement strategy. */
  position?: MountStrategy;
  /** Replace existing content in the mount point. */
  replace?: boolean;
}

export interface ObserveOptions {
  once?: boolean;
  includeMutations?: boolean;
}

export interface ObserveInfo {
  zoneId: ZoneId;
  previousAnchor: Element | null;
}

/** Mount/observe nodes within DOM zones. */
export interface InjectAPI {
  /** Mount a node (or factory) into a zone. Returns false if the zone is absent. */
  mount(
    zoneId: ZoneId,
    nodeOrFactory: Node | ((ctx: MountContext) => Node),
    options?: MountOptions,
  ): boolean;
  /** Run `callback` once when the zone anchor first appears; returns a stop function. */
  waitFor(
    zoneId: ZoneId,
    callback: (anchor: Element, info: ObserveInfo) => void,
  ): () => void;
  /** Observe a zone anchor across DOM changes; returns a stop function. */
  observeZone(
    zoneId: ZoneId,
    callback: (anchor: Element, info: ObserveInfo) => void,
    options?: ObserveOptions,
  ): () => void;
  /** Alias of {@link observeZone}. */
  observe(
    zoneId: ZoneId,
    callback: (anchor: Element, info: ObserveInfo) => void,
    options?: ObserveOptions,
  ): () => void;
  /** Remove all mounts created by a plugin. */
  unmount(pluginId: string): void;
}

// ─── Sidebar navigation ───────────────────────────────────────────────────

export interface SidebarNavAPI {
  /** Find a sidebar nav element matching any of the given labels. */
  find(labels: string[], options?: { exact?: boolean; fromEnd?: boolean }): Element | null;
  /** Insert an element after the nav row matching `referenceLabels`. */
  insertAfter(
    referenceLabels: string[],
    elementOrFactory: Node | ((ctx: { mount: HTMLDivElement }) => Node),
    key?: string,
  ): boolean;
  /** Insert an element before a nav row (use `["Settings"]` to target the footer). */
  insertBefore(
    referenceLabels: string | string[],
    elementOrFactory: Node | ((ctx: { mount: HTMLDivElement }) => Node),
    key?: string,
  ): boolean;
  /** Remove a previously inserted nav mount by key. */
  remove(key: string): void;
}

// ─── UI overlays ──────────────────────────────────────────────────────────

export interface NavItemOptions {
  label?: string;
  icon?: string;
  subtitle?: string;
  compact?: boolean;
  active?: boolean;
  onClick?: (event: MouseEvent) => void;
  className?: string;
}

export interface AnchorRect {
  left?: number;
  top?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  right?: number;
  bottom?: number;
}

export interface PopoverOptions {
  anchor?: Element;
  anchorRect?: AnchorRect;
  title?: string;
  content?: Node | (() => Node) | string;
  width?: number;
  side?: PopoverSide;
  onClose?: () => void;
}

export interface RepositionPopoverOptions {
  anchor?: Element;
  anchorRect?: AnchorRect;
  width?: number;
  side?: PopoverSide;
}

export interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

export interface UIAPI {
  /** A sidebar nav button styled to match Codex. */
  navItem(options?: NavItemOptions): HTMLButtonElement;
  /** Close the currently open popover, if any. */
  closePopover(): void;
  /** Reposition the open popover; returns false if none is open. */
  repositionPopover(options?: RepositionPopoverOptions): boolean;
  /** Open a popover anchored to an element or rect. Returns the backdrop element. */
  popover(options?: PopoverOptions): HTMLDivElement;
  /** Open a confirm dialog. Returns the backdrop element. */
  confirm(options?: ConfirmOptions): HTMLDivElement;
}

// ─── Plugins ──────────────────────────────────────────────────────────────

export interface PluginManifest {
  id: string;
  name?: string;
  version?: string;
  entry?: string;
  description?: string;
  documentation?: string;
  /** Can be loaded at runtime without an app restart. Default true. */
  dynamicLoadable?: boolean;
  /** Can be unloaded at runtime without an app restart. Default true. */
  dynamicUnloadable?: boolean;
  /** Built-in (bundled) plugin; cannot be unloaded. Default false. */
  builtin?: boolean;
  [key: string]: unknown;
}

export interface PluginCatalogEntry extends PluginManifest {
  /** Plugin source as a string, executed when the plugin is loaded. */
  source?: string;
}

export interface RegisterResult {
  id: string;
  ok?: boolean;
  error?: unknown;
}

/**
 * The API object passed to a plugin's setup callback. It is the full
 * {@link ExplodexAPI} plus the plugin's own id, a scoped logger, and `mount`
 * pre-bound to the plugin id.
 */
export interface PluginAPI extends ExplodexAPI {
  pluginId: string;
  log: PluginLogger;
  waitFor: InjectAPI["waitFor"];
  /** {@link InjectAPI.mount} with `pluginId` pre-bound. */
  mount(
    zoneId: ZoneId,
    nodeOrFactory: Node | ((ctx: MountContext) => Node),
    options?: Omit<MountOptions, "pluginId">,
  ): boolean;
}

/** Optional teardown returned from a plugin setup callback. */
export type PluginTeardown = () => void;

export interface PluginManagerAPI {
  /** Register and run a plugin. */
  register(
    manifest: PluginManifest,
    setup: (api: PluginAPI) => PluginTeardown | void,
  ): RegisterResult;
  /** Unregister a plugin (runs teardown by default). */
  unregister(id: string, options?: { runTeardown?: boolean }): void;
  /** Declare a plugin in the catalog without running it. */
  declare(manifest: PluginManifest, source?: string): string | null;
  /** Ids of currently loaded plugins. */
  list(): string[];
  /** Ids of all catalog (declared) plugins. */
  listCatalog(): string[];
  /** Resolve a plugin's manifest. */
  get(id: string): PluginManifest | null;
  /** Whether a plugin is enabled (persisted preference). */
  isEnabled(id: string): boolean;
  /** Set the persisted enabled preference (does not load/unload). */
  setEnabled(id: string, enabled: boolean): void;
  /** Enable a plugin (loads it, or prompts to restart if required). */
  enable(id: string): void;
  /** Disable a plugin (unloads it, or prompts to restart if required). */
  disable(id: string): void;
  /** Run a declared plugin's source. Returns true if it registered. */
  load(id: string): boolean;
  /** Unload a plugin. Returns false for built-ins or non-unloadable plugins. */
  unload(id: string): boolean;
  /** Load all enabled plugins from the injected catalog. */
  initFromCatalog(): void;
  /** Relaunch the wrapped Codex app (for restart-required toggles). */
  restartWrapped(options?: { reason?: string }): Promise<boolean>;
}

// ─── Meta ─────────────────────────────────────────────────────────────────

export interface ExplodexMeta {
  codexVersion: string | null;
  /** Zone id → selectors map. */
  selectors: Record<ZoneId, string[]>;
  /** Known Codex renderer route patterns. */
  routes: string[];
  /** Known Codex persisted-atom keys. */
  persistedKeys: Record<string, string>;
  buttonTokens: { colors: ButtonColor[]; sizes: ButtonSize[] };
}

export interface ExplodexPaths {
  userPluginsDir?: string;
  relaunchScript?: string;
  [key: string]: unknown;
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface ExplodexAPI {
  /** SDK version. */
  version: string;
  /** Available zone ids. */
  zones: ZoneId[];
  zoneDefinitions: Record<ZoneId, ZoneDefinition>;
  inject: InjectAPI;
  components: ComponentsAPI;
  storage: StorageAPI;
  bridge: BridgeAPI;
  http: HttpAPI;
  composer: ComposerAPI;
  codex: CodexAPI;
  query: QueryAPI;
  sidebarNav: SidebarNavAPI;
  ui: UIAPI;
  log: LogAPI;
  plugins: PluginManagerAPI;
  meta: ExplodexMeta;
  /** Tear down the runtime and remove all injected DOM. */
  destroy(): void;

  // ── Legacy aliases (v0.0.1-poc compat) ──
  /** @deprecated Use {@link InjectAPI.mount}. */
  mount: InjectAPI["mount"];
  /** @deprecated Use {@link InjectAPI.waitFor}. */
  waitFor: InjectAPI["waitFor"];
  /** @deprecated Use {@link InjectAPI.waitFor}. */
  waitForZone: InjectAPI["waitFor"];
  /** @deprecated Use {@link InjectAPI.observeZone}. */
  observeZone: InjectAPI["observeZone"];
  /** @deprecated Use {@link PluginManagerAPI.register}. */
  registerPlugin: PluginManagerAPI["register"];
  /** @deprecated Use {@link ComposerAPI.insertText}. */
  insertIntoComposer: ComposerAPI["insertText"];
  /** @deprecated Use {@link ComponentsAPI.statusToast}. */
  showStatus: ComponentsAPI["statusToast"];
}
