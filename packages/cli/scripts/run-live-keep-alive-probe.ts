/**
 * M1-F05 authorized one-shot keep-alive Phase 0 + atomic compatibility probe.
 *
 * Reuses already-collected comparative matrix evidence (no full matrix replay),
 * launches one keep-alive acceptance process on 127.0.0.1:9444, then runs the
 * complete exact-current-canonical-host compatibility probe against that same
 * acceptance PID/start/port/target/context.
 */
import { createDefaultHostAdapters } from "../src/host/adapters.ts";
import {
  createNodePortInventoryAdapter,
  createNodeProcessInventoryAdapter,
  createNodeReadOnlyCommandRunner,
} from "../src/host/process-adapters.ts";
import { runCompatibilityProbe } from "../src/host/probe-operation.ts";
import { resolveGeneratedSdkRuntimeIdentity } from "../src/host/sdk-runtime-identity.ts";
import { createNodeRuntimeProcess } from "../src/runtime/adapters.ts";
import { runPhase0LaunchIsolation } from "../src/dev/phase0-operation.ts";
import { loadPhase0LaunchContract } from "../src/dev/phase0.ts";
import type { Phase0ComparativeExperiment } from "../src/dev/types.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function loadPreservedExperiments(): Promise<Phase0ComparativeExperiment[]> {
  const path = join(
    process.env.HOME ?? "",
    ".explodex/dev/plugin-dev/explodex-state/phase0-launch-contract.json",
  );
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    comparativeExperiments?: Phase0ComparativeExperiment[];
  };
  if (!Array.isArray(raw.comparativeExperiments) || raw.comparativeExperiments.length === 0) {
    throw new Error("No preserved comparative experiments available for bounded keep-alive");
  }
  return raw.comparativeExperiments;
}

const adapters = await createDefaultHostAdapters();
const runtimeProcess = await createNodeRuntimeProcess();
const commands = createNodeReadOnlyCommandRunner();
const inventory = createNodeProcessInventoryAdapter({
  commands,
  exactProcess: runtimeProcess,
});
const ports = createNodePortInventoryAdapter(commands);

const before = await inventory.list();
const protectedBefore = before.filter(
  (entry) =>
    entry.executablePath.endsWith("/ChatGPT.app/Contents/MacOS/ChatGPT") &&
    !entry.arguments.some((token) => token.startsWith("--explodex-dev-instance=")),
);
const protectedIdentities: Array<{ pid: number; processStartedAt: string }> = [];
for (const entry of protectedBefore) {
  const id = await runtimeProcess.identify(entry.pid);
  if (id !== null) {
    protectedIdentities.push({
      pid: id.pid,
      processStartedAt: id.processStartedAt,
    });
  }
}

const experiments = await loadPreservedExperiments();
const started = Date.now();

const phase0 = await runPhase0LaunchIsolation({
  adapters,
  runtimeProcess,
  commands,
  keepProcessAlive: true,
  providedComparativeExperiments: experiments,
  readinessTimeoutMs: 60_000,
  stopTimeoutMs: 15_000,
  pollMs: 250,
  lockWaitMs: 5_000,
});

const phase0ElapsedMs = Date.now() - started;
const phase0Summary = {
  ok: phase0.ok,
  status: phase0.contract.status,
  allowsCompatibilityProbe: phase0.allowsCompatibilityProbe,
  mode: phase0.contract.acceptanceAuthority?.mode ?? null,
  readinessPid: phase0.contract.readiness?.pid ?? null,
  readinessStart: phase0.contract.readiness?.processStartedAt ?? null,
  targetId: phase0.contract.readiness?.targetId ?? null,
  protectedMainSurvived: phase0.protectedMainSurvived,
  elapsedMs: phase0ElapsedMs,
  error: phase0.ok ? null : phase0.error,
};

console.log(JSON.stringify({ phase0: phase0Summary }, null, 2));

if (!phase0.ok || phase0.contract.status !== "proven" || phase0.process === null) {
  process.exitCode = 1;
  throw new Error(
    `Keep-alive Phase 0 did not prove: ${phase0.ok ? phase0.contract.reason : phase0.error.message}`,
  );
}

const sdk = await resolveGeneratedSdkRuntimeIdentity();
const explodexHome = join(process.env.HOME ?? "", ".explodex");
const phase0ContractPath = join(
  process.env.HOME ?? "",
  ".explodex/dev/plugin-dev/explodex-state/phase0-launch-contract.json",
);

// Confirm contract reloads through strict semantic validation.
const reloaded = await loadPhase0LaunchContract({
  adapters,
  path: phase0ContractPath,
});
if (reloaded === null || reloaded.status !== "proven") {
  process.exitCode = 1;
  throw new Error("Keep-alive Phase 0 contract failed strict reload validation");
}

const probeStarted = Date.now();
const probe = await runCompatibilityProbe({
  adapters,
  explodexHome,
  phase0ContractPath,
  sdkRuntime: { version: sdk.version, sha256: sdk.sha256 },
  sdkSource: sdk.source,
  runtimeProcess,
  commands,
  acceptanceProcess: {
    pid: phase0.process.pid,
    processStartedAt: phase0.process.processStartedAt,
    executablePath: phase0.process.executablePath,
    targetId: phase0.process.targetId,
    executionContextId: phase0.process.executionContextId,
    executionContextUniqueId: phase0.process.executionContextUniqueId,
  },
  authoringMain: protectedIdentities[0] ?? null,
});
const probeElapsedMs = Date.now() - probeStarted;

const listenersAfter = await ports.listenersFor(9444);
const probeSummary = {
  ok: probe.ok,
  committed: probe.committed,
  status: probe.probe?.status ?? null,
  reason: probe.probe?.reason ?? (probe.ok ? null : probe.error.message),
  allowsCompatibilityCommit: probe.probe?.allowsCompatibilityCommit ?? false,
  correlationOk: probe.probe?.correlation.ok ?? false,
  isolationComplete: probe.probe?.isolation.complete ?? false,
  endpointComplete: probe.probe?.endpoint.complete ?? false,
  bridgeComplete: probe.probe?.bridge.complete ?? false,
  sdkComplete: probe.probe?.sdkBootstrap.complete ?? false,
  anchorsComplete: probe.probe?.anchors.complete ?? false,
  anchorsPending: probe.probe?.anchors.pendingUnreachable ?? [],
  safetyComplete: probe.probe?.safety.complete ?? false,
  identity: probe.probe
    ? {
        pid: probe.probe.identity.pid,
        processStartedAt: probe.probe.identity.processStartedAt,
        targetId: probe.probe.identity.targetId,
        appVersion: probe.probe.identity.frozenHost.appVersion,
        appBuild: probe.probe.identity.frozenHost.appBuild,
        sdkVersion: probe.probe.identity.sdkRuntime.version,
      }
    : null,
  port9444After: listenersAfter.map((entry) => entry.pid),
  elapsedMs: probeElapsedMs,
};

console.log(JSON.stringify({ probe: probeSummary }, null, 2));

// Detach from residual keep-alive ownership so the CLI process can exit.
// Exact PID stop is intentional only when the probe did not need the process kept
// for orchestrator inspection; keep residual on pending signed-in results.
const pendingSignedIn =
  probe.probe?.status === "pending" ||
  (probe.probe?.anchors.pendingUnreachable.length ?? 0) > 0;
if (!pendingSignedIn && phase0.process !== null) {
  try {
    await runtimeProcess.signalExact(
      {
        pid: phase0.process.pid,
        processStartedAt: phase0.process.processStartedAt,
      },
      "SIGTERM",
    );
  } catch {
    // Best-effort; residual ownership remains non-authorizing for later ops.
  }
}

if (probe.committed) {
  process.exitCode = 0;
} else if (probe.probe?.status === "pending") {
  // Explicit pending is a truthful incomplete proof, not a crash.
  process.exitCode = 3;
} else {
  process.exitCode = 2;
}

// Force exit: keep-alive ChatGPT children must not pin the event loop.
setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
