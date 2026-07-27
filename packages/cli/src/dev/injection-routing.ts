import type { PluginManifestV1 } from "../plugin/manifest.ts";

export type DevArtifactRouteAction =
  | "dynamic"
  | "renderer-boundary"
  | "app-boundary";

export function routeDevArtifactLifecycle(
  lifecycle: PluginManifestV1["lifecycle"],
): DevArtifactRouteAction {
  if (lifecycle === "renderer-start") return "renderer-boundary";
  if (lifecycle === "app-start") return "app-boundary";
  return "dynamic";
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "dev.inject-failed";
}

export async function executeDevArtifactRoute<T>(options: {
  lifecycle: PluginManifestV1["lifecycle"];
  actions: Record<DevArtifactRouteAction, () => Promise<T>>;
}): Promise<
  | { ok: true; route: DevArtifactRouteAction; value: T }
  | {
      ok: false;
      route: DevArtifactRouteAction;
      code: string;
      message: string;
    }
> {
  const route = routeDevArtifactLifecycle(options.lifecycle);
  try {
    return {
      ok: true,
      route,
      value: await options.actions[route](),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      route,
      code: errorCode(error),
      message: error instanceof Error
        ? error.message
        : "Development artifact routing failed.",
    };
  }
}
