import type { CliJsonEnvelope, RenderedCliResult } from "./envelope.ts";
import { serializeEnvelope } from "./envelope.ts";

export type CliIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  stderrIsTty: boolean;
};

export function createProcessIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    stdinIsTty: Boolean(process.stdin.isTTY),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    stderrIsTty: Boolean(process.stderr.isTTY),
  };
}

/**
 * Write one complete machine-clean envelope to stdout (JSON mode)
 * or human primary/diagnostic streams otherwise.
 */
export function writeCliResult(
  io: CliIo,
  rendered: RenderedCliResult,
  options: { json: boolean },
): void {
  if (rendered.outputMode === "already-written") return;
  if (options.json) {
    io.stdout.write(serializeEnvelope(rendered.envelope));
    if (rendered.humanStderr.length > 0) {
      io.stderr.write(ensureTrailingNewline(rendered.humanStderr));
    }
    return;
  }
  if (rendered.humanStdout.length > 0) {
    io.stdout.write(ensureTrailingNewline(rendered.humanStdout));
  }
  if (rendered.humanStderr.length > 0) {
    io.stderr.write(ensureTrailingNewline(rendered.humanStderr));
  }
}

export function writeJsonEnvelope(io: CliIo, envelope: CliJsonEnvelope): void {
  io.stdout.write(serializeEnvelope(envelope));
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
