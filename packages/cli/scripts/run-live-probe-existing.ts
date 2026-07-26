/**
 * M1-F05 post-sign-in probe against an already-running keep-alive acceptance
 * process. Does not relaunch Phase 0, does not claim port 9444, and never
 * touches the authoring main. Use only when state/contract identify one live
 * keep-alive owned development process on 127.0.0.1:9444.
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
import { loadPhase0LaunchContract } from "../src/dev/phase0.ts";
import { loadDevInstanceState } from "../src/dev/state.ts";
import { join } from "node:path";

const home = process.env.HOME ?? "";
const explodexHome = join(home, ".explodex");
const root = join(explodexHome, "dev/plugin-dev");
const statePath = join(root, "state.json");
const phase0ContractPath = join(root, "explodex-state/phase0-launch-contract.json");

const adapters = await createDefaultHostAdapters();
const runtimeProcess = await createNodeRuntimeProcess();
const commands = createNodeReadOnlyCommandRunner();
const ports = createNodePortInventoryAdapter(commands);
const inventory = createNodeProcessInventoryAdapter({
  commands,
  exactProcess: runtimeProcess,
});

const state = await loadDevInstanceState({ adapters, statePath });
if (state === null) {
  process.exitCode = 1;
  throw new Error("No development instance state at plugin-dev; cannot probe existing keep-alive");
}
if (state.status !== "ready" || state.pid === null || state.processStartedAt === null) {
  process.exitCode = 1;
  throw new Error(
    `Development state is not ready keep-alive (status=${state.status}, pid=${String(state.pid)})`,
  );
}

const contract = await loadPhase0LaunchContract({ adapters, path: phase0ContractPath });
if (contract === null || contract.status !== "proven") {
  process.exitCode = 1;
  throw new Error("Phase 0 keep-alive contract is missing or not proven");
}
if ((contract.acceptanceAuthority?.mode ?? "stopped") !== "keep-alive") {
  process.exitCode = 1;
  throw new Error("Phase 0 contract is not keep-alive mode; refuse to probe without relaunch authority");
}
if (
  contract.readiness === null ||
  contract.readiness.pid !== state.pid ||
  contract.readiness.processStartedAt !== state.processStartedAt
) {
  process.exitCode = 1;
  throw new Error("Phase 0 readiness identity does not match ready instance state");
}

const alive = await runtimeProcess.isAlive(state.pid, state.processStartedAt);
if (!alive) {
  process.exitCode = 1;
  throw new Error(`Keep-alive acceptance PID ${state.pid} is not alive; do not relaunch without fresh authorization`);
}

const listeners = await ports.listenersFor(9444);
const matching = listeners.filter((entry) => entry.pid === state.pid);
if (matching.length !== 1) {
  process.exitCode = 1;
  throw new Error(
    matching.length === 0
      ? `PID ${state.pid} does not uniquely own 127.0.0.1:9444`
      : `Ambiguous 9444 ownership for PID ${state.pid}`,
  );
}

const before = await inventory.list();
const protectedBefore = before.filter(
  (entry) =>
    entry.executablePath.endsWith("/ChatGPT.app/Contents/MacOS/ChatGPT") &&
    !entry.arguments.some((token) => token.startsWith("--explodex-dev-instance=")),
);
const authoringMain =
  protectedBefore[0] !== undefined
    ? await runtimeProcess.identify(protectedBefore[0].pid)
    : null;

const sdk = await resolveGeneratedSdkRuntimeIdentity();
const started = Date.now();
const probe = await runCompatibilityProbe({
  adapters,
  explodexHome,
  phase0ContractPath,
  sdkRuntime: { version: sdk.version, sha256: sdk.sha256 },
  sdkSource: sdk.source,
  runtimeProcess,
  commands,
  acceptanceProcess: {
    pid: state.pid,
    processStartedAt: state.processStartedAt,
    executablePath: state.executablePath,
    targetId: state.targetId,
    executionContextId: contract.readiness.executionContextId,
    executionContextUniqueId: contract.readiness.executionContextUniqueId,
  },
  authoringMain:
    authoringMain === null
      ? null
      : {
          pid: authoringMain.pid,
          processStartedAt: authoringMain.processStartedAt,
        },
});

const listenersAfter = await ports.listenersFor(9444);
const summary = {
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
  anchorsFailed: probe.probe?.anchors.failed ?? [],
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
  keepAlivePreserved: listenersAfter.some((entry) => entry.pid === state.pid),
  elapsedMs: Date.now() - started,
};

console.log(JSON.stringify({ probe: summary }, null, 2));

// Never stop the keep-alive process from this script. Pending signed-in anchors
// leave residual authority for orchestrator-mediated sign-in and a later re-probe.
if (probe.committed) {
  process.exitCode = 0;
} else if (probe.probe?.status === "pending") {
  process.exitCode = 3;
} else {
  process.exitCode = 2;
}

setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
