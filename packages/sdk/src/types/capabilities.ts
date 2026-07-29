/// <reference lib="dom" />

/**
 * Compatibility-shaped public capabilities used by first-party plugins.
 * Renderer-private bridge, fiber, AppServer, query-provider, and Statsig
 * implementation objects remain internal to the runtime.
 */

import type { PluginLogger } from "./runtime-api.ts";

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

export type MountStrategy = "append" | "prepend" | "after-input" | "fixed";

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

export type ButtonSize =
  | "default"
  | "large"
  | "medium"
  | "icon"
  | "iconSm"
  | "composer"
  | "composerSm"
  | "toolbar";

export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | (string & {});

export type PopoverSide = "right" | "left" | "bottom";

export type BridgeMessage = {
  type: string;
  [key: string]: unknown;
};

export type BridgeApi = {
  isAvailable(): boolean;
  send<T = unknown>(
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<T | null | undefined>;
  rpc<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T | null>;
  navigate(
    path: string,
    state?: Record<string, unknown>,
  ): Promise<unknown | null | undefined>;
  on(type: string, handler: (message: BridgeMessage) => void): () => void;
};

export type HttpResponse<T = unknown> = {
  status: number;
  headers: Record<string, string>;
  body: T | null;
};

export type HttpRequestOptions = {
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
};

export type HttpApi = {
  isAvailable(): boolean;
  request<T = unknown>(
    method: string,
    url: string,
    options?: HttpRequestOptions,
  ): Promise<HttpResponse<T>>;
  get<T = unknown>(
    url: string,
    options?: HttpRequestOptions,
  ): Promise<T | null>;
  post<T = unknown>(
    url: string,
    body?: unknown,
    options?: HttpRequestOptions,
  ): Promise<T | null>;
};

export type PersistedStorage = {
  get<T = unknown>(key: string, fallback?: T): T;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  keys(): string[];
  subscribe<T = unknown>(
    key: string,
    callback: (value: T) => void,
  ): () => void;
};

export type SettingsStorage = {
  get<T = unknown>(key: string, fallback?: T): Promise<T>;
  set(key: string, value: unknown): Promise<void>;
};

export type GlobalStateStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
};

export type StorageApi = {
  readonly persisted: PersistedStorage;
  readonly settings: SettingsStorage;
  readonly globalState: GlobalStateStorage;
};

export type ButtonOptions = {
  label?: string;
  children?: string;
  color?: ButtonColor;
  size?: ButtonSize;
  uniform?: boolean;
  loading?: boolean;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  className?: string;
  onClick?: (event: MouseEvent) => void;
  icon?: string | Node;
  [key: string]: unknown;
};

export type PanelOptions = {
  title?: string;
  children?: Node | (() => Node) | string;
  className?: string;
};

export type FieldRowOptions = {
  label?: string;
  control?: Node;
  hint?: string;
};

export type CheckboxFieldOptions = {
  label?: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
};

export type RadioFieldOptions = {
  label?: string;
  name?: string;
  value?: string;
  checked?: boolean;
  onChange?: (value: string | undefined) => void;
};

export type NumberFieldOptions = {
  label?: string;
  value?: number;
  min?: number;
  max?: number;
  onChange?: (value: number) => void;
};

export type TextFieldOptions = {
  label?: string;
  value?: string;
  placeholder?: string;
  monospace?: boolean;
  onChange?: (value: string) => void;
};

export type SelectFieldOption = {
  value: string;
  label?: string;
};

export type SelectFieldOptions = {
  label?: string;
  value?: string;
  options?: readonly SelectFieldOption[];
  onChange?: (value: string) => void;
};

export type SectionOptions = {
  title?: string;
  hint?: string;
  children?: Node | readonly Node[] | (() => Node);
};

export type SectionResult = {
  el: HTMLDivElement;
  body: HTMLDivElement;
};

export type SortableListItem = {
  id: string;
  label?: string;
};

export type SortableListOptions = {
  label?: string;
  items?: readonly SortableListItem[];
  onReorder?: (ids: string[]) => void;
  renderLabel?: (item: SortableListItem) => string;
};

export type ComponentsApi = {
  button(options?: ButtonOptions): HTMLButtonElement;
  panel(options?: PanelOptions): HTMLDivElement;
  statusToast(message: string, options?: { duration?: number }): void;
  metaText(text?: string): HTMLDivElement;
  fieldRow(options?: FieldRowOptions): HTMLDivElement;
  checkboxField(options?: CheckboxFieldOptions): HTMLLabelElement;
  radioField(options?: RadioFieldOptions): HTMLLabelElement;
  numberField(options?: NumberFieldOptions): HTMLDivElement;
  textField(options?: TextFieldOptions): HTMLDivElement;
  selectField(options?: SelectFieldOptions): HTMLDivElement;
  section(options?: SectionOptions): SectionResult;
  sortableList(options?: SortableListOptions): HTMLDivElement;
  fieldStack(children?: readonly Node[]): HTMLDivElement;
};

export type FormatDurationOptions = {
  past?: string;
  ceilMinutes?: boolean;
  includeMinuteRemainder?: boolean;
  dayThresholdHours?: number;
};

export type FormatApi = {
  template(
    template: string,
    context: unknown,
    options?: { fallback?: string },
  ): string;
  countdown(
    unixSeconds: number | null | undefined,
    options?: FormatDurationOptions & { fallback?: string },
  ): string;
  datetimeCountdown(
    unixSeconds: number | null | undefined,
    options?: FormatDurationOptions & {
      fallback?: string;
      pastLabel?: string;
      separator?: string;
    },
  ): string;
};

export type ComposerApi = {
  getInput(): HTMLElement | null;
  focus(): boolean;
  getText(): string;
  insertText(text: string): boolean;
  setText(text: string): boolean;
};

export type ThreadConversation = {
  id: string;
  latestThreadSettings?: {
    model?: string;
    effort?: string;
    [key: string]: unknown;
  };
  latestCollaborationMode?: {
    settings?: {
      model?: string;
      reasoning_effort?: string;
    };
  };
  latestModel?: string;
  latestReasoningEffort?: string;
  [key: string]: unknown;
};

export type CodexApi = {
  getThreadConversation(conversationId: string): ThreadConversation | null;
  getThreadModel(conversationId: string): string | null;
  getThreadEffort(conversationId: string): string | null;
  applyThreadSettingsForNextTurn(
    conversationId: string,
    settings?: {
      model?: string;
      effort?: ReasoningEffort;
    },
  ): Promise<boolean>;
};

export type QueryRecord = {
  readonly queryKey: readonly unknown[];
  readonly state?: {
    readonly data?: unknown;
    readonly dataUpdatedAt?: number;
  };
};

export type QueryClientApi = {
  getQueryCache(): {
    getAll(): readonly QueryRecord[];
  };
  getQueryData<T = unknown>(queryKey: readonly unknown[]): T | undefined;
  setQueryData<T = unknown>(
    queryKey: readonly unknown[],
    value: T | ((current: T | undefined) => T | undefined),
  ): unknown;
  invalidateQueries(options: {
    queryKey: readonly unknown[];
  }): Promise<unknown>;
};

export type FlagsPropagateOptions = {
  hostId?: string;
  queryKeys?: readonly (readonly unknown[])[];
  statsigGates?: Record<string, boolean | null>;
  skipStandardInvalidation?: boolean;
  pluginId?: string;
};

export type FlagsApi = {
  getQueryClient(): QueryClientApi | null;
  readStatsigGate(gateId: string): boolean | null;
  setStatsigGateOverride(
    gateId: string,
    value: boolean | null,
    options?: { pluginId?: string; notify?: boolean },
  ): boolean;
  clearStatsigGateOverrides(options?: { pluginId?: string }): void;
  notifyStatsigValuesUpdated(): void;
  invalidateQueries(
    queryKeys: readonly (readonly unknown[])[],
  ): Promise<void>;
  propagate(options?: FlagsPropagateOptions): Promise<void>;
};

export type QueryApi = {
  testId(id: string): Element | null;
  portal(name: string): Element | null;
  one(selector: string): Element | null;
  all(selector: string): Element[];
};

export type MountContext = {
  api: PluginCapabilityApi;
  mountPoint: HTMLDivElement;
  zoneId: ZoneId;
  pluginId: string;
};

export type MountOptions = {
  pluginId?: string;
  position?: MountStrategy;
  replace?: boolean;
};

export type ObserveInfo = {
  zoneId: ZoneId;
  previousAnchor: Element | null;
};

export type InjectApi = {
  mount(
    zoneId: ZoneId,
    nodeOrFactory: Node | ((context: MountContext) => Node),
    options?: MountOptions,
  ): boolean;
  waitFor(
    zoneId: ZoneId,
    callback: (anchor: Element, info: ObserveInfo) => void,
  ): () => void;
  observeZone(
    zoneId: ZoneId,
    callback: (anchor: Element, info: ObserveInfo) => void,
    options?: { once?: boolean; includeMutations?: boolean },
  ): () => void;
  observe(
    zoneId: ZoneId,
    callback: (anchor: Element, info: ObserveInfo) => void,
    options?: { once?: boolean; includeMutations?: boolean },
  ): () => void;
};

export type SidebarNavApi = {
  find(
    labels: readonly string[],
    options?: { exact?: boolean; fromEnd?: boolean },
  ): Element | null;
  insertAfter(
    referenceLabels: readonly string[],
    elementOrFactory:
      | Node
      | ((context: { mount: HTMLDivElement }) => Node),
    key?: string,
  ): boolean;
  insertBefore(
    referenceLabels: string | readonly string[],
    elementOrFactory:
      | Node
      | ((context: { mount: HTMLDivElement }) => Node),
    key?: string,
  ): boolean;
  remove(key: string): void;
};

export type AnchorRect = {
  left?: number;
  top?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  right?: number;
  bottom?: number;
};

export type NavItemOptions = {
  label?: string;
  icon?: string;
  subtitle?: string;
  compact?: boolean;
  active?: boolean;
  onClick?: (event: MouseEvent) => void;
  className?: string;
};

export type PopoverOptions = {
  anchor?: Element;
  anchorRect?: AnchorRect;
  title?: string;
  content?: Node | (() => Node) | string;
  width?: number;
  side?: PopoverSide;
  onClose?: () => void;
};

export type RepositionPopoverOptions = {
  anchor?: Element;
  anchorRect?: AnchorRect;
  width?: number;
  side?: PopoverSide;
};

export type UiApi = {
  navItem(options?: NavItemOptions): HTMLButtonElement;
  closePopover(): void;
  repositionPopover(options?: RepositionPopoverOptions): boolean;
  popover(options?: PopoverOptions): HTMLDivElement;
};

export type PluginOptionsRenderContext = {
  pluginId: string;
  refresh(): void;
};

export type PluginOptionsHandlers = {
  render(
    container: HTMLElement,
    context: PluginOptionsRenderContext,
  ): void;
};

export type MigrationContext = {
  storage: StorageApi;
  bridge: BridgeApi;
  pluginId: string;
  log: PluginLogger;
  renameKey(oldKey: string, newKey: string): boolean;
};

export type PluginMigration = {
  id: string;
  run(context: MigrationContext): void | Promise<void>;
};

export type PluginCapabilityApi = {
  readonly storage: StorageApi;
  readonly bridge: BridgeApi;
  readonly http: HttpApi;
  readonly components: ComponentsApi;
  readonly format: FormatApi;
  readonly composer: ComposerApi;
  readonly codex: CodexApi;
  readonly flags: FlagsApi;
  readonly query: QueryApi;
  readonly inject: InjectApi;
  readonly sidebarNav: SidebarNavApi;
  readonly ui: UiApi;
  readonly waitFor: InjectApi["waitFor"];
  mount(
    zoneId: ZoneId,
    nodeOrFactory: Node | ((context: MountContext) => Node),
    options?: Omit<MountOptions, "pluginId">,
  ): boolean;
  registerOptions(handlers: PluginOptionsHandlers): void;
  migrate(migrations: readonly PluginMigration[]): Promise<void>;
};
