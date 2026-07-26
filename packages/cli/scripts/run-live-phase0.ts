/**
 * Authorized live stopped Phase 0 acceptance runner for M1-F04R2.
 * Uses only isolated 127.0.0.1:9444 against the current frozen ChatGPT.app identity.
 */
import { createDefaultHostAdapters } from "../src/host/adapters.ts";
import {
  createNodePortInventoryAdapter,
  createNodeProcessInventoryAdapter,
  createNodeReadOnlyCommandRunner,
} from "../src/host/process-adapters.ts";
import { createNodeRuntimeProcess } from "../src/runtime/adapters.ts";
import { runPhase0LaunchIsolation } from "../src/dev/phase0-operation.ts";
import { loadPhase0LaunchContract } from "../src/dev/phase0.ts";
import { loadDevInstanceState } from "../src/dev/state.ts";
import { stat } from "node:fs/promises";

const mainBefore = 60014;
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
const mainIdentity = await runtimeProcess.identify(mainBefore);
console.log(
  JSON.stringify({
    protectedMainsBefore: protectedBefore.map((entry) => entry.pid),
    mainIdentity,
  }),
);

const started = Date.now();
const result = await runPhase0LaunchIsolation({
  adapters,
  runtimeProcess,
  commands,
  keepProcessAlive: false,
  // Live ChatGPT readiness typically settles within a few seconds once 9444 is up.
  // Keep a finite margin without multiplying to multi-hour comparative matrices.
  readinessTimeoutMs: 45_000,
  stopTimeoutMs: 15_000,
  pollMs: 250,
  lockWaitMs: 5_000,
});
const elapsedMs = Date.now() - started;

const summary = {
  ok: result.ok,
  status: result.contract.status,
  schemaVersion: result.contract.schemaVersion,
  allowsLifecycleMutation: result.allowsLifecycleMutation,
  provenAt: result.contract.provenAt,
  retainedKnobs: result.contract.retainedKnobs,
  experimentCount: result.contract.comparativeExperiments.length,
  experiments: result.contract.comparativeExperiments.map((experiment) => ({
    knob: experiment.knob,
    experimentId: experiment.experimentId,
    conclusion: experiment.conclusion,
    treatmentPid: experiment.treatment.pid,
    controlPid: experiment.control?.pid ?? null,
    treatmentRoot: experiment.treatment.privateRoot,
    controlRoot: experiment.control?.privateRoot ?? null,
  })),
  isolation: result.contract.isolation,
  readiness: result.contract.readiness,
  ownershipPositive: result.contract.ownership?.positive ?? null,
  ownershipNegatives:
    result.contract.ownership?.negatives.map((negative) => ({
      role: negative.role,
      code: negative.code,
    })) ?? [],
  descriptor: result.contract.sanitizedLaunchDescriptor,
  frozenHost: result.frozenHost,
  protectedMainSurvived: result.protectedMainSurvived,
  process: result.process,
  error: result.ok ? null : result.error,
  elapsedMs,
};
console.log(JSON.stringify(summary, null, 2));

const listeners = await ports.listenersFor(9444);
const mainAlive =
  mainIdentity === null
    ? false
    : await runtimeProcess.isAlive(mainBefore, mainIdentity.processStartedAt);
const residual = (await inventory.list()).filter((entry) =>
  entry.arguments.some((token) => token.startsWith("--explodex-dev-instance=")),
);
console.log(
  JSON.stringify({
    port9444After: listeners,
    mainSurvived: mainAlive,
    residualDevPids: residual.map((entry) => entry.pid),
  }),
);

if (result.layout) {
  const state = await loadDevInstanceState({
    adapters,
    statePath: result.layout.statePath,
  });
  const contract = await loadPhase0LaunchContract({
    adapters,
    path: result.layout.phase0ContractPath,
  });
  const stateStat = await stat(result.layout.statePath);
  console.log(
    JSON.stringify({
      state: {
        status: state?.status ?? null,
        pid: state?.pid ?? null,
        processStartedAt: state?.processStartedAt ?? null,
        targetId: state?.targetId ?? null,
        startedAt: state?.startedAt ?? null,
        mode: (stateStat.mode & 0o777).toString(8),
      },
      loadedContract: {
        status: contract?.status ?? null,
        schemaVersion: contract?.schemaVersion ?? null,
        provenAt: contract?.provenAt ?? null,
        readinessPid: contract?.readiness?.pid ?? null,
        hasRendererEvaluation: contract?.readiness?.rendererEvaluation != null,
        isolation: contract?.isolation ?? null,
      },
    }),
  );
}

process.exit(result.ok ? 0 : 1);
