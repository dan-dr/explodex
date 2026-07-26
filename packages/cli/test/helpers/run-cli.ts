import { Readable, Writable } from "node:stream";
import { runCli } from "../../src/cli/entry.ts";
import type { RenderedCliResult } from "../../src/output/envelope.ts";
import { serializeEnvelope } from "../../src/output/envelope.ts";
import type { CliIo } from "../../src/output/write.ts";

export type CapturedCli = {
  rendered: RenderedCliResult;
  stdout: string;
  stderr: string;
  exitCode: number;
};

class MemoryWritable extends Writable {
  chunks: Buffer[] = [];
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    callback();
  }
  toStringUtf8(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export async function captureCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = { ...process.env, HOME: "/tmp/explodex-cli-test-home" },
): Promise<CapturedCli> {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();
  const stdin = Readable.from([]);
  const io: CliIo = {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
    stdin: stdin as unknown as NodeJS.ReadableStream,
    stdoutIsTty: false,
    stderrIsTty: false,
  };

  const rendered = await runCli({
    argv,
    env,
    io,
    returnResult: true,
  });

  return {
    rendered,
    stdout: stdout.toStringUtf8(),
    stderr: stderr.toStringUtf8(),
    exitCode: rendered.exitCode,
  };
}

export function parseStdoutJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  // Exactly one JSON value (plus optional trailing whitespace already trimmed).
  return JSON.parse(trimmed) as unknown;
}

export function assertSingleJsonValue(stdout: string): unknown {
  const trimmed = stdout.replace(/\s+$/, "");
  // No leading whitespace pollution required by contract beyond trailing WS.
  if (trimmed.includes("\n") && !trimmed.endsWith("}")) {
    // multi-line pretty print is forbidden; compact single line + LF only
  }
  const lines = trimmed.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new Error(`Expected exactly one JSON line on stdout, got ${lines.length}: ${JSON.stringify(stdout)}`);
  }
  return JSON.parse(lines[0]!) as unknown;
}

export { serializeEnvelope };
