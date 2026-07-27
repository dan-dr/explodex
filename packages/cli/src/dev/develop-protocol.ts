import type { TargetIdentity } from "../cdp/types.ts";
import { sanitizeJsonValue } from "../output/envelope.ts";

export type DevelopEventType =
  | "watch-ready"
  | "build-started"
  | "build-succeeded"
  | "build-failed"
  | "apply-started"
  | "apply-succeeded"
  | "apply-failed"
  | "target-lost"
  | "blocked";

export type DevelopPluginIdentity = {
  id: string;
  version: string;
  payloadSha256: string;
};

export type DevelopSdkRuntimeIdentity = {
  version: string;
  sha256: string;
};

export type DevelopEvent = {
  schemaVersion: 1;
  operationId: string;
  sequence: number;
  generation: number;
  type: DevelopEventType;
  pluginIdentity?: DevelopPluginIdentity;
  sdkRuntimeIdentity?: DevelopSdkRuntimeIdentity;
  target?: TargetIdentity;
  details?: unknown;
};

export type DevelopLastGood = {
  generation: number;
  pluginIdentity: DevelopPluginIdentity;
  sdkRuntimeIdentity: DevelopSdkRuntimeIdentity;
  target: TargetIdentity;
  appliedAt: string;
};

export type DevelopTerminalReason =
  | "completed"
  | "interrupted"
  | "blocked"
  | "preflight-failed"
  | "runtime-failed";

export type DevelopError = {
  code: string;
  message: string;
  details?: unknown;
};

export type DevelopTerminalResult = {
  schemaVersion: 1;
  operationId: string;
  type: "terminal";
  ok: boolean;
  reason: DevelopTerminalReason;
  lastSequence: number;
  lastGood: DevelopLastGood | null;
  error?: DevelopError;
};

type EventInput = Omit<DevelopEvent, "schemaVersion" | "operationId" | "sequence">;

function serializeRecord(record: DevelopEvent | DevelopTerminalResult): string {
  return JSON.stringify(sanitizeJsonValue(record));
}

/**
 * Stateful schemaVersion-1 JSONL writer. It is the sole authority for
 * operation identity, sequence allocation, last-good promotion, and terminal
 * uniqueness.
 */
export class DevelopProtocolWriter {
  readonly operationId: string;
  #sequence = 0;
  #lastGood: DevelopLastGood | null = null;
  #terminal: DevelopTerminalResult | null = null;
  readonly #writeLine: (line: string) => void;

  constructor(options: {
    operationId: string;
    writeLine: (line: string) => void;
  }) {
    if (options.operationId.length === 0) {
      throw new TypeError("Develop operation ID must be non-empty.");
    }
    this.operationId = options.operationId;
    this.#writeLine = options.writeLine;
  }

  get lastSequence(): number {
    return this.#sequence;
  }

  get lastGood(): DevelopLastGood | null {
    return this.#lastGood;
  }

  get terminalResult(): DevelopTerminalResult | null {
    return this.#terminal;
  }

  event(input: EventInput): DevelopEvent {
    this.#assertOpen();
    const event: DevelopEvent = {
      schemaVersion: 1,
      operationId: this.operationId,
      sequence: this.#sequence + 1,
      generation: input.generation,
      type: input.type,
      ...(input.pluginIdentity === undefined
        ? {}
        : { pluginIdentity: input.pluginIdentity }),
      ...(input.sdkRuntimeIdentity === undefined
        ? {}
        : { sdkRuntimeIdentity: input.sdkRuntimeIdentity }),
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.details === undefined ? {} : { details: input.details }),
    };
    this.#sequence = event.sequence;
    this.#writeLine(serializeRecord(event));
    return event;
  }

  applySucceeded(lastGood: DevelopLastGood): DevelopEvent {
    this.#assertOpen();
    const event = this.event({
      generation: lastGood.generation,
      type: "apply-succeeded",
      pluginIdentity: lastGood.pluginIdentity,
      sdkRuntimeIdentity: lastGood.sdkRuntimeIdentity,
      target: lastGood.target,
      details: { appliedAt: lastGood.appliedAt },
    });
    this.#lastGood = Object.freeze({
      ...lastGood,
      pluginIdentity: Object.freeze({ ...lastGood.pluginIdentity }),
      sdkRuntimeIdentity: Object.freeze({ ...lastGood.sdkRuntimeIdentity }),
      target: Object.freeze({ ...lastGood.target }),
    });
    return event;
  }

  terminal(input: {
    ok: boolean;
    reason: DevelopTerminalReason;
    error?: DevelopError;
  }): DevelopTerminalResult {
    this.#assertOpen();
    if (input.ok !== (input.reason === "completed")) {
      throw new TypeError("Only a completed develop terminal may be successful.");
    }
    const terminal: DevelopTerminalResult = {
      schemaVersion: 1,
      operationId: this.operationId,
      type: "terminal",
      ok: input.ok,
      reason: input.reason,
      lastSequence: this.#sequence,
      lastGood: this.#lastGood,
      ...(input.error === undefined ? {} : { error: input.error }),
    };
    this.#terminal = terminal;
    this.#writeLine(serializeRecord(terminal));
    return terminal;
  }

  #assertOpen(): void {
    if (this.#terminal !== null) {
      throw new Error("Develop protocol is terminal; no later output is allowed.");
    }
  }
}
