import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import { runMainApplyOperation } from "../host/main-apply.ts";
import {
  createSystemMainApplyAdapters,
} from "../host/main-apply-system.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import type { CliIo } from "../output/write.ts";
import type { MainApplyCheckpoint } from "../host/main-apply.ts";

const OPERATION = "main.apply";

export async function authorizeMainApplyCheckpoint(options: {
  json: boolean;
  checkpoint: MainApplyCheckpoint;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  writeStderr(text: string): void;
  ask(question: string, signal?: AbortSignal): Promise<string>;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (
    options.json ||
    !options.stdinIsTty ||
    !options.stdoutIsTty
  ) {
    return false;
  }
  const checkpoint = options.checkpoint;
  options.writeStderr([
    "Fresh authoring-main checkpoint required.",
    `operationId: ${checkpoint.operationId}`,
    `expiresAt: ${checkpoint.expiresAt}`,
    `main: ${checkpoint.target.pid}@${checkpoint.target.processStartedAt}`,
    `target: ${checkpoint.target.targetId}`,
    `context: ${checkpoint.target.executionContextUniqueId}`,
    `build: ${checkpoint.host.appBuild}`,
    `compatibilityKeyHash: ${checkpoint.compatibilityKeyHash}`,
    `sdkRuntime: ${checkpoint.sdkRuntimeIdentity.version} ${checkpoint.sdkRuntimeIdentity.sha256}`,
    `artifact: ${checkpoint.artifact.id}@${checkpoint.artifact.version} ${checkpoint.artifact.payloadSha256}`,
    "This permits one hot-safe dynamic apply only. It does not permit SDK replacement, reload, restart, navigation, close, or stop.",
    "",
  ].join("\n"));
  try {
    const answer = await options.ask(
      `Type the exact operation ID '${checkpoint.operationId}' to authorize: `,
      options.signal,
    );
    return answer === checkpoint.operationId;
  } catch {
    return false;
  }
}

export async function runMainApply(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const tokens = [...options.rest, ...options.endOfOptions];
  if (tokens.length === 0) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.missing-argument",
      message: "A staged, exact dev-validated artifact path is required.",
      usageLine: "Usage: explodex main apply <artifact>",
      helpPath: "main apply",
    });
  }
  if (tokens.length > 1) {
    return usageFailure({
      operation: OPERATION,
      code: tokens[1]!.startsWith("-")
        ? "usage.unknown-option"
        : "usage.invalid-value",
      message: `Unexpected argument or option '${tokens[1]}'.`,
      usageLine: "Usage: explodex main apply <artifact>",
      helpPath: "main apply",
    });
  }
  const osHome = options.env.HOME;
  if (osHome === undefined || osHome.length === 0) {
    return renderFailure({
      operation: OPERATION,
      code: "config.invalid-environment",
      message: "HOME is required to resolve exact main staging authority.",
    });
  }
  let explodexHome: string;
  try {
    explodexHome = resolveExplodexHome({
      osHome,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    });
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "config.invalid-environment",
      message: error instanceof Error
        ? error.message
        : "Unable to resolve Explodex home.",
    });
  }
  const operationId = `main-apply-${randomUUID()}`;
  const authorize = async (
    checkpoint: Parameters<
      ReturnType<typeof createSystemMainApplyAdapters>["authorize"]
    >[0],
  ): Promise<boolean> => {
    return authorizeMainApplyCheckpoint({
      json: options.globals.json,
      checkpoint,
      stdinIsTty: options.io.stdinIsTty,
      stdoutIsTty: options.io.stdoutIsTty,
      writeStderr(text) {
        options.io.stderr.write(text);
      },
      async ask(question, signal) {
        const prompt = createInterface({
          input: options.io.stdin,
          output: options.io.stderr,
          terminal: true,
        });
        try {
          return await prompt.question(question, { signal });
        } finally {
          prompt.close();
        }
      },
      signal: options.signal,
    });
  };
  const result = await runMainApplyOperation({
    artifactPath: resolve(options.env.PWD ?? process.cwd(), tokens[0]!),
    operationId,
    timeoutMs: options.globals.timeoutMs,
    signal: options.signal,
    adapters: createSystemMainApplyAdapters({
      osHome,
      explodexHome,
      timeoutMs: options.globals.timeoutMs,
      authorize,
    }),
  });
  if (!result.ok) {
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: {
        operationId: result.operationId,
        stagedIdentity: result.stagedIdentity,
        sourceDelivered: result.sourceDelivered,
        ...(result.checkpoint === undefined
          ? {}
          : { checkpoint: result.checkpoint }),
        ...(result.details === undefined
          ? {}
          : { cause: result.details }),
      },
      exitCode: exitCodeForError(result.code),
      humanStderr: [
        result.message,
        `error.code: ${result.code}`,
        ...(result.details?.recoveryGuidance === undefined
          ? []
          : [`recovery: ${String(result.details.recoveryGuidance)}`]),
        "",
      ].join("\n"),
    });
  }
  return {
    envelope: successEnvelope(OPERATION, result),
    exitCode: 0,
    humanStdout: [
      `Applied ${result.appliedIdentity.id}@${result.appliedIdentity.version} once to the authorized main.`,
      `payloadSha256: ${result.appliedIdentity.payloadSha256}`,
      `target: ${result.target.targetId} context=${result.target.executionContextId}`,
      `baseline preserved: ${result.baselinePreserved}`,
      "authorization consumed: true",
      "main lifecycle and SDK runtime unchanged",
      "",
    ].join("\n"),
    humanStderr: "",
  };
}
