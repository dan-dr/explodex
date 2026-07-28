import { resolve } from "node:path";
import { createNodeCdpAdapter } from "../cdp/adapters.ts";
import { runExactTargetOperation } from "../cdp/operation.ts";
import { createDefaultHostAdapters } from "../host/adapters.ts";
import { createDefaultHostStatusAdapters } from "../host/process-adapters.ts";
import { createDefaultRuntimeAdapters } from "../runtime/adapters.ts";
import { prepareOwnedDevTarget } from "../dev/injection-operation.ts";
import { validateInstallablePayloadDir } from "./artifact-validate.ts";
import {
  loadPluginsState,
  type PluginStateRecord,
} from "./install-state.ts";

type ManagementIdentity = {
  version: string;
  payloadSha256: string;
};

export type PluginManagementObservation = {
  id: string;
  displayName: string;
  description: string;
  installed: ManagementIdentity[];
  enabled: ManagementIdentity | null;
  pendingReview: ManagementIdentity[];
  application: {
    status:
      | "unknown"
      | "not-applicable"
      | "applied"
      | "apply-pending"
      | "boundary-required"
      | "blocked"
      | "failed"
      | "not-attempted";
    lifecycle: "dynamic" | "renderer-start" | "app-start" | null;
    boundary: "none" | "renderer" | "app";
    observedIdentity: ManagementIdentity | null;
    message: string;
  };
};

export type PluginManagementTargetResult =
  | {
      ok: true;
      target: import("../cdp/types.ts").TargetIdentity;
      plugins: PluginManagementObservation[];
      uiOpened: boolean;
      residualInventory: {
        callbacks: number;
        sessions: number;
        hasResidentControlPlane: boolean;
      };
    }
  | {
      ok: false;
      code: string;
      message: string;
      plugins: PluginManagementObservation[];
      uiOpened: false;
      details?: unknown;
    };

async function lifecycleFor(options: {
  explodexHome: string;
  id: string;
  record: PluginStateRecord;
}): Promise<{
  lifecycle: "dynamic" | "renderer-start" | "app-start" | null;
  displayName: string;
  description: string;
}> {
  const preferred = options.record.enabled ??
    options.record.pendingReview[0] ??
    options.record.installed[0] ??
    null;
  if (preferred === null) {
    return {
      lifecycle: null,
      displayName: options.id,
      description: "",
    };
  }
  const installed = options.record.installed.find((candidate) =>
    candidate.version === preferred.version &&
    candidate.payloadSha256 === preferred.payloadSha256
  );
  if (installed === undefined) {
    return {
      lifecycle: null,
      displayName: options.id,
      description: "",
    };
  }
  const validated = await validateInstallablePayloadDir(
    resolve(options.explodexHome, installed.relativePath),
    {
      source: "directory",
      expectedIdentity: {
        id: options.id,
        version: preferred.version,
        payloadSha256: preferred.payloadSha256,
      },
    },
  );
  if (!validated.ok) {
    return {
      lifecycle: null,
      displayName: options.id,
      description: "",
    };
  }
  return {
    lifecycle: validated.lifecycle,
    displayName: validated.displayName,
    description: validated.description,
  };
}

async function records(options: {
  explodexHome: string;
}): Promise<PluginManagementObservation[]> {
  const loaded = await loadPluginsState({
    explodexHome: options.explodexHome,
  });
  if (loaded.status !== "valid") return [];
  const result: PluginManagementObservation[] = [];
  for (const id of Object.keys(loaded.state.plugins).sort()) {
    const record = loaded.state.plugins[id]!;
    const metadata = await lifecycleFor({
      explodexHome: options.explodexHome,
      id,
      record,
    });
    result.push({
      id,
      displayName: metadata.displayName,
      description: metadata.description,
      installed: record.installed.map(({ version, payloadSha256 }) => ({
        version,
        payloadSha256,
      })),
      enabled: record.enabled === null ? null : { ...record.enabled },
      pendingReview: record.pendingReview.map((identity) => ({ ...identity })),
      application: {
        status: "unknown",
        lifecycle: metadata.lifecycle,
        boundary: "none",
        observedIdentity: null,
        message:
          "No exact renderer application state has been inspected yet.",
      },
    });
  }
  return result;
}

function expression(options: {
  plugins: PluginManagementObservation[];
  commands: Record<string, {
    enable: string | null;
    review: string | null;
    refresh: string;
    update: string;
    disable: string;
    remove: string | null;
  }>;
  openUi: boolean;
}): string {
  return `(async () => {
  const runtime = globalThis.Explodex;
  const status = runtime && runtime["__explodexPluginApplicationStatus"];
  if (typeof status !== "function") {
    return {
      ok: false,
      code: "plugin.management.runtime-unavailable",
      message: "The exact Explodex runtime is not present in this renderer.",
      plugins: ${JSON.stringify(options.plugins)},
      uiOpened: false,
    };
  }
  const plugins = ${JSON.stringify(options.plugins)}.map((plugin) => {
    const live = status(plugin.id);
    const observedIdentity = live && live.identity
      ? {
          version: live.identity.version,
          payloadSha256: live.identity.payloadSha256,
        }
      : null;
    const enabledMatches = plugin.enabled !== null &&
      observedIdentity !== null &&
      plugin.enabled.version === observedIdentity.version &&
      plugin.enabled.payloadSha256 === observedIdentity.payloadSha256;
    let application;
    if (enabledMatches) {
      application = {
        status: "applied",
        lifecycle: live.lifecycle,
        boundary: "none",
        observedIdentity,
        message: "The exact enabled identity is applied in this inspected renderer.",
      };
    } else if (plugin.enabled !== null) {
      const lifecycle = plugin.application.lifecycle;
      application = lifecycle === "renderer-start"
        ? {
            status: "boundary-required",
            lifecycle,
            boundary: "renderer",
            observedIdentity,
            message: "Persisted intent requires an owned development renderer boundary.",
          }
        : lifecycle === "app-start"
          ? {
              status: "boundary-required",
              lifecycle,
              boundary: "app",
              observedIdentity,
              message: "Persisted intent requires an owned development app boundary.",
            }
          : {
              status: "apply-pending",
              lifecycle,
              boundary: "none",
              observedIdentity,
              message: "Persisted dynamic intent is not applied in this inspected renderer.",
            };
    } else if (
      observedIdentity !== null &&
      (live.lifecycle === "renderer-start" || live.lifecycle === "app-start")
    ) {
      application = {
        status: "boundary-required",
        lifecycle: live.lifecycle,
        boundary: live.lifecycle === "renderer-start" ? "renderer" : "app",
        observedIdentity,
        message: "Intent is disabled, but the previously applied effect remains until its owned development boundary.",
      };
    } else if (observedIdentity !== null) {
      application = {
        status: "failed",
        lifecycle: live.lifecycle,
        boundary: "none",
        observedIdentity,
        message: "Disabled dynamic intent is still observed; run the exact disable command again.",
      };
    } else {
      application = {
        status: "not-applicable",
        lifecycle: plugin.application.lifecycle,
        boundary: "none",
        observedIdentity: null,
        message: "No enabled intent or live application is observed.",
      };
    }
    return { ...plugin, application };
  });
  if (!${JSON.stringify(options.openUi)}) {
    return { ok: true, plugins, uiOpened: false };
  }
  if (!runtime.management || typeof runtime.management.open !== "function") {
    return {
      ok: false,
      code: "plugin.management.runtime-unavailable",
      message: "The exact Explodex management surface is unavailable.",
      plugins,
      uiOpened: false,
    };
  }
  const model = runtime.management.open({
    schemaVersion: 1,
    target: "development",
    plugins,
    commands: ${JSON.stringify(options.commands)},
  });
  if (!model || model.ok !== true) {
    return {
      ok: false,
      code: "plugin.management.render-failed",
      message: model && typeof model.message === "string"
        ? model.message
        : "Plugin management UI failed to render.",
      plugins,
      uiOpened: false,
    };
  }
  return { ok: true, plugins, uiOpened: true };
})()`;
}

function shellArgument(value: string): string {
  if (/^[a-zA-Z0-9._:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function exactManagementCommands(options: {
  plugins: readonly PluginManagementObservation[];
  explodexHome: string;
  explicitRoot?: string | null;
}): Record<string, {
  enable: string | null;
  review: string | null;
  refresh: string;
  update: string;
  disable: string;
  remove: string | null;
}> {
  const prefix = [
    "explodex",
    "--home",
    shellArgument(options.explodexHome),
    ...(options.explicitRoot === null || options.explicitRoot === undefined
      ? []
      : ["--dev-root", shellArgument(resolve(options.explicitRoot))]),
  ].join(" ");
  const identityCommand = (
    operation: "review" | "remove",
    id: string,
    identity: ManagementIdentity,
  ) => [
    prefix,
    "plugin",
    operation,
    shellArgument(id),
    "--artifact-version",
    shellArgument(identity.version),
    "--payload-sha256",
    identity.payloadSha256,
    "--target",
    "development",
  ].join(" ");
  return Object.fromEntries(options.plugins.map((plugin) => {
    const pending = plugin.pendingReview[0] ?? plugin.installed[0] ?? null;
    const removable = plugin.enabled ?? plugin.installed[0] ?? null;
    const review = pending === null
      ? null
      : identityCommand("review", plugin.id, pending);
    return [
      plugin.id,
      {
        enable: review,
        review,
        refresh: `${prefix} plugin refresh --target development`,
        update: `${prefix} plugin update check`,
        disable:
          `${prefix} plugin disable ${shellArgument(plugin.id)} --target development`,
        remove: removable === null
          ? null
          : identityCommand("remove", plugin.id, removable),
      },
    ];
  }));
}

function persistedFieldsMatch(
  expected: PluginManagementObservation,
  observed: PluginManagementObservation,
): boolean {
  return expected.id === observed.id &&
    expected.displayName === observed.displayName &&
    expected.description === observed.description &&
    JSON.stringify(expected.installed) === JSON.stringify(observed.installed) &&
    JSON.stringify(expected.enabled) === JSON.stringify(observed.enabled) &&
    JSON.stringify(expected.pendingReview) ===
      JSON.stringify(observed.pendingReview);
}

function trustedApplicationObservation(
  expected: PluginManagementObservation,
  observed: PluginManagementObservation["application"],
): PluginManagementObservation["application"] | null {
  const installed = new Set(
    expected.installed.map((identity) =>
      `${identity.version}\0${identity.payloadSha256}`
    ),
  );
  if (
    observed.observedIdentity !== null &&
    !installed.has(
      `${observed.observedIdentity.version}\0${observed.observedIdentity.payloadSha256}`,
    )
  ) return null;
  const enabledMatches = expected.enabled !== null &&
    observed.observedIdentity !== null &&
    expected.enabled.version === observed.observedIdentity.version &&
    expected.enabled.payloadSha256 ===
      observed.observedIdentity.payloadSha256;
  const lifecycle = expected.application.lifecycle;
  let status: PluginManagementObservation["application"]["status"];
  let boundary: PluginManagementObservation["application"]["boundary"];
  let message: string;
  if (enabledMatches) {
    status = "applied";
    boundary = "none";
    message = "The exact enabled identity is applied in this inspected renderer.";
  } else if (expected.enabled !== null) {
    if (lifecycle === "renderer-start") {
      status = "boundary-required";
      boundary = "renderer";
      message = "Persisted intent requires an owned development renderer boundary.";
    } else if (lifecycle === "app-start") {
      status = "boundary-required";
      boundary = "app";
      message = "Persisted intent requires an owned development app boundary.";
    } else {
      status = "apply-pending";
      boundary = "none";
      message = "Persisted dynamic intent is not applied in this inspected renderer.";
    }
  } else if (observed.observedIdentity !== null) {
    if (lifecycle === "renderer-start" || lifecycle === "app-start") {
      status = "boundary-required";
      boundary = lifecycle === "renderer-start" ? "renderer" : "app";
      message =
        "Intent is disabled, but the previously applied effect remains until its owned development boundary.";
    } else {
      status = "failed";
      boundary = "none";
      message =
        "Disabled dynamic intent is still observed; run the exact disable command again.";
    }
  } else {
    status = "not-applicable";
    boundary = "none";
    message = "No enabled intent or live application is observed.";
  }
  if (
    observed.status !== status ||
    observed.lifecycle !== lifecycle ||
    observed.boundary !== boundary
  ) return null;
  return {
    status,
    lifecycle,
    boundary,
    observedIdentity: observed.observedIdentity,
    message,
  };
}

export function parsePluginManagementResponse(
  value: unknown,
  expectedPlugins: readonly PluginManagementObservation[],
): {
  ok: boolean;
  code?: string;
  message?: string;
  plugins?: PluginManagementObservation[];
  uiOpened?: boolean;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["ok"] !== "boolean" ||
    !Array.isArray(record["plugins"]) ||
    typeof record["uiOpened"] !== "boolean"
  ) {
    return null;
  }
  const plugins = record["plugins"].map(parseManagementPlugin);
  if (plugins.some((plugin) => plugin === null)) return null;
  const parsedPlugins = plugins as PluginManagementObservation[];
  const byId = new Map(parsedPlugins.map((plugin) => [plugin.id, plugin]));
  if (
    parsedPlugins.length !== expectedPlugins.length ||
    byId.size !== expectedPlugins.length ||
    expectedPlugins.some((expected) => {
      const observed = byId.get(expected.id);
      return observed === undefined ||
        !persistedFieldsMatch(expected, observed);
    })
  ) return null;
  const correlated = expectedPlugins.map((expected) => {
    const observed = byId.get(expected.id)!;
    return trustedApplicationObservation(expected, observed.application);
  });
  if (correlated.some((application) => application === null)) return null;
  return {
    ok: record["ok"],
    ...(typeof record["code"] === "string" ? { code: record["code"] } : {}),
    ...(typeof record["message"] === "string"
      ? { message: record["message"] }
      : {}),
    plugins: expectedPlugins.map((expected, index) => ({
      ...expected,
      application: correlated[index]!,
    })),
    uiOpened: record["uiOpened"],
  };
}

function managementIdentity(value: unknown): ManagementIdentity | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) return null;
  const record = value as Record<string, unknown>;
  return typeof record["version"] === "string" &&
      typeof record["payloadSha256"] === "string" &&
      /^[a-f0-9]{64}$/u.test(record["payloadSha256"])
    ? {
        version: record["version"],
        payloadSha256: record["payloadSha256"],
      }
    : null;
}

function parseManagementPlugin(
  value: unknown,
): PluginManagementObservation | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) return null;
  const record = value as Record<string, unknown>;
  const application = record["application"];
  if (
    typeof record["id"] !== "string" ||
    typeof record["displayName"] !== "string" ||
    typeof record["description"] !== "string" ||
    !Array.isArray(record["installed"]) ||
    !Array.isArray(record["pendingReview"]) ||
    typeof application !== "object" ||
    application === null ||
    Array.isArray(application)
  ) return null;
  const installed = record["installed"].map(managementIdentity);
  const pendingReview = record["pendingReview"].map(managementIdentity);
  const enabled = record["enabled"] === null
    ? null
    : managementIdentity(record["enabled"]);
  if (
    installed.some((identity) => identity === null) ||
    pendingReview.some((identity) => identity === null) ||
    (record["enabled"] !== null && enabled === null)
  ) return null;
  const state = application as Record<string, unknown>;
  const statuses = new Set([
    "unknown",
    "not-applicable",
    "applied",
    "apply-pending",
    "boundary-required",
    "blocked",
    "failed",
    "not-attempted",
  ]);
  const lifecycles = new Set([
    null,
    "dynamic",
    "renderer-start",
    "app-start",
  ]);
  const boundaries = new Set(["none", "renderer", "app"]);
  const lifecycle = state["lifecycle"];
  const observedIdentity = state["observedIdentity"] === null
    ? null
    : managementIdentity(state["observedIdentity"]);
  if (
    typeof state["status"] !== "string" ||
    !statuses.has(state["status"]) ||
    !(
      lifecycle === null ||
      (
        typeof lifecycle === "string" &&
        lifecycles.has(lifecycle)
      )
    ) ||
    typeof state["boundary"] !== "string" ||
    !boundaries.has(state["boundary"]) ||
    typeof state["message"] !== "string" ||
    (state["observedIdentity"] !== null && observedIdentity === null)
  ) return null;
  return {
    id: record["id"],
    displayName: record["displayName"],
    description: record["description"],
    installed: installed as ManagementIdentity[],
    enabled,
    pendingReview: pendingReview as ManagementIdentity[],
    application: {
      status: state["status"] as PluginManagementObservation["application"]["status"],
      lifecycle: lifecycle as
        PluginManagementObservation["application"]["lifecycle"],
      boundary: state["boundary"] as
        PluginManagementObservation["application"]["boundary"],
      observedIdentity,
      message: state["message"],
    },
  };
}

export async function inspectPluginManagementOnDevelopmentTarget(options: {
  osHome: string;
  explodexHome: string;
  explicitRoot?: string | null;
  timeoutMs: number;
  openUi: boolean;
  signal?: AbortSignal;
}): Promise<PluginManagementTargetResult> {
  const plugins = await records({ explodexHome: options.explodexHome });
  const hostAdapters = await createDefaultHostAdapters();
  const statusAdapters = await createDefaultHostStatusAdapters();
  const runtime = await createDefaultRuntimeAdapters();
  const cdp = createNodeCdpAdapter();
  const prepared = await prepareOwnedDevTarget({
    operation: "focus",
    osHome: options.osHome,
    explodexHome: options.explodexHome,
    explicitRoot: options.explicitRoot,
    signal: options.signal,
    hostAdapters,
    statusAdapters,
    cdp,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      code: prepared.code,
      message: prepared.message,
      plugins,
      uiOpened: false,
      details: prepared.details,
    };
  }
  const expected = prepared.value;
  const commands = exactManagementCommands({
    plugins,
    explodexHome: options.explodexHome,
    explicitRoot: options.explicitRoot,
  });
  const operation = await runExactTargetOperation({
    runtime,
    operation: options.openUi
      ? "plugin.management.open"
      : "plugin.management.inspect",
    role: "development",
    homeIdentity: options.explodexHome,
    host: expected.host,
    process: expected.process,
    endpoint: { host: "127.0.0.1", port: 9444 },
    cdp,
    signal: options.signal,
    revalidate: async () => {
      const current = await prepareOwnedDevTarget({
        operation: "focus",
        osHome: options.osHome,
        explodexHome: options.explodexHome,
        explicitRoot: options.explicitRoot,
        signal: options.signal,
        hostAdapters,
        statusAdapters,
        cdp,
      });
      if (!current.ok) {
        throw Object.assign(new Error(current.message), {
          code: "process_identity_drift" as const,
          details: current.details,
        });
      }
      return {
        host: current.value.host,
        process: current.value.process,
        listener: current.value.listener,
      };
    },
    evaluate: {
      expression: expression({
        plugins,
        commands,
        openUi: options.openUi,
      }),
    },
    stageBounds: {
      cdpEvaluationMs: options.timeoutMs,
    },
  });
  if (!operation.ok) {
    return {
      ok: false,
      code: operation.error.code,
      message: operation.error.message,
      plugins,
      uiOpened: false,
      details: {
        stage: operation.error.stage,
        residualInventory: operation.residualInventory,
      },
    };
  }
  const parsed = parsePluginManagementResponse(
    operation.result.evaluation.value,
    plugins,
  );
  if (parsed === null || parsed.plugins === undefined) {
    return {
      ok: false,
      code: "plugin.management.invalid-response",
      message: "Renderer returned malformed plugin management status.",
      plugins,
      uiOpened: false,
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code ?? "plugin.management.unavailable",
      message: parsed.message ?? "Plugin management target is unavailable.",
      plugins: parsed.plugins,
      uiOpened: false,
    };
  }
  return {
    ok: true,
    target: operation.result.target,
    plugins: parsed.plugins,
    uiOpened: parsed.uiOpened === true,
    residualInventory: operation.residualInventory,
  };
}
