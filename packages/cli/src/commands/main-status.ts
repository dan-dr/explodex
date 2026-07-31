import { createDefaultHostStatusAdapters } from "../host/process-adapters.ts";
import {
  collectHostStatus,
  formatHostStatusHuman,
  roleEndpoint,
} from "../host/status.ts";
import {
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { EXIT_SUCCESS } from "../cli/exit-codes.ts";

const OPERATION = "main.status";

export async function runMainStatus(options: {
  signal?: AbortSignal;
} = {}): Promise<RenderedCliResult> {
  const adapters = await createDefaultHostStatusAdapters();
  const status = await collectHostStatus({
    adapters,
    role: "main",
    signal: options.signal,
  });

  const endpoint = roleEndpoint("main");
  const result = {
    role: "main" as const,
    endpoint,
    mainState: status.mainState,
    endpointObstruction: status.endpointObstruction,
    processes: status.processes.map((process) => ({
      pid: process.pid,
      processStartedAt: process.processStartedAt,
      executablePath: process.executablePath,
    })),
    selectedTarget: status.selectedTarget,
    diagnostic: status.diagnostic,
    readOnly: true as const,
    activity: status.activity,
  };

  return {
    envelope: successEnvelope(OPERATION, result),
    exitCode: EXIT_SUCCESS,
    humanStdout: formatHostStatusHuman(status),
    humanStderr: "",
  };
}
