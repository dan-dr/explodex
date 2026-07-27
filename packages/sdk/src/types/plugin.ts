/**
 * Public plugin definition and API contracts used by definePlugin.
 * Runtime host application of setup is owned by the lifecycle host.
 */

import type { ExplodexRuntimeApi } from "./runtime-api.ts";

/** Duck-typed mount node for runtime-tracked DOM cleanup. */
export type TrackedMountNode = {
  remove?(): void;
  parentNode?: { removeChild(child: unknown): void } | null;
};

/** Listener callback accepted by tracked event targets (DOM-free typing). */
export type TrackedEventListener = ((event: unknown) => void) | { handleEvent(event: unknown): void };

/** Duck-typed event target for runtime-tracked listeners. */
export type TrackedEventTarget = {
  addEventListener(
    type: string,
    listener: TrackedEventListener | null,
    options?: boolean | Record<string, unknown>,
  ): void;
  removeEventListener(
    type: string,
    listener: TrackedEventListener | null,
    options?: boolean | Record<string, unknown>,
  ): void;
};

/** Duck-typed observer for runtime-tracked disconnect. */
export type TrackedObserver = {
  disconnect(): void;
};

/**
 * Runtime-tracked resource helpers available during setup.
 * Arbitrary untracked third-party effects are not claimed preventable.
 */
export type PluginTrackedResources = {
  mount(node: TrackedMountNode): void;
  listen(
    target: TrackedEventTarget,
    type: string,
    listener: TrackedEventListener | null,
    options?: boolean | Record<string, unknown>,
  ): void;
  timeout(handler: (...args: unknown[]) => void, ms: number, ...args: unknown[]): number;
  interval(handler: (...args: unknown[]) => void, ms: number, ...args: unknown[]): number;
  observe(observer: TrackedObserver): void;
  subscription(unsubscribe: () => void): void;
};

/** Revocable handle for one manifest-declared plugin asset. */
export type PluginAssetHandle = {
  readonly path: string;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
};

/** Browser-safe plugin-scoped access to exact validated asset bytes. */
export type PluginAssets = {
  open(path: string): Promise<PluginAssetHandle>;
};

/** API object passed to setup after the runtime accepts a definition. */
export type PluginApi = ExplodexRuntimeApi & {
  readonly pluginId: string;
  /** Monotonic load generation for this application. */
  readonly generation: number;
  /** Opaque generation token; late work must not resurrect a different generation. */
  readonly token: string;
  /** Register resources for guaranteed teardown disposal. */
  readonly track: PluginTrackedResources;
  /** Open only assets declared by this plugin's accepted manifest. */
  readonly assets: PluginAssets;
};

export type PluginTeardown = () => void | Promise<void>;

export type PluginSetupResult = void | PluginTeardown | Promise<void | PluginTeardown>;

export type PluginSetup = (api: PluginApi) => PluginSetupResult;

/**
 * Declarative plugin definition. Evaluation registers this inertly;
 * setup runs only after exact acceptance.
 */
export type PluginDefinition = {
  setup: PluginSetup;
};

/**
 * Marker type returned by definePlugin for build tooling.
 * Runtime registration is private to the generated plugin IIFE.
 */
export type DefinedPlugin = PluginDefinition & {
  readonly __explodexDefinedPlugin: true;
};
