import { createNodeRuntimeProcess, type RuntimeProcess } from "../runtime/adapters.ts";
import type {
  DeclaredPort,
  HostStatusAdapters,
  ListenerObservation,
  PortInventoryAdapter,
  ProcessInventoryAdapter,
  ProcessObservation,
} from "./status.ts";

export type ReadOnlyCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ReadOnlyCommandRunner = {
  exec(file: string, args: readonly string[], options?: { signal?: AbortSignal }): Promise<ReadOnlyCommandResult>;
};

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseProcessInventory(text: string): ProcessObservation[] {
  const processes: ProcessObservation[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (match === null) continue;
    const pid = parsePositiveInteger(match[1] ?? "");
    const parentPid = parseNonNegativeInteger(match[2] ?? "");
    const command = match[3]?.trim() ?? "";
    const argumentsList = command.split(/\s+/).filter((part) => part.length > 0);
    const executablePath = argumentsList[0] ?? "";
    if (pid === null || parentPid === null || executablePath.length === 0) continue;
    processes.push({
      pid,
      parentPid,
      executablePath,
      arguments: argumentsList,
    });
  }
  return processes.sort((left, right) => left.pid - right.pid);
}

function parseListenerName(name: string): { host: string; port: number; family: ListenerObservation["family"] } | null {
  const normalized = (name.startsWith("TCP ") ? name.slice(4) : name)
    .replace(/\s+\(LISTEN\)$/, "");
  const ipv6 = normalized.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6 !== null) {
    const port = parsePositiveInteger(ipv6[2] ?? "");
    return port === null ? null : { host: ipv6[1] ?? "", port, family: "ipv6" };
  }
  const ipv4 = normalized.match(/^([^:]+):(\d+)$/);
  if (ipv4 === null) return null;
  const port = parsePositiveInteger(ipv4[2] ?? "");
  return port === null ? null : { host: ipv4[1] ?? "", port, family: "ipv4" };
}

/** Parse lsof field output produced by -Fpn. */
export function parseListenerInventory(text: string): ListenerObservation[] {
  const listeners: ListenerObservation[] = [];
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      pid = parsePositiveInteger(line.slice(1));
      continue;
    }
    if (!line.startsWith("n") || pid === null) continue;
    const parsed = parseListenerName(line.slice(1));
    if (parsed === null) continue;
    listeners.push({ pid, processStartedAt: null, ...parsed });
  }
  return listeners.sort((left, right) => left.pid - right.pid);
}

export function createNodeReadOnlyCommandRunner(): ReadOnlyCommandRunner {
  return {
    async exec(file, args, options) {
      const { spawn } = await import("node:child_process");
      return new Promise((resolve, reject) => {
        const child = spawn(file, [...args], {
          stdio: ["ignore", "pipe", "pipe"],
          signal: options?.signal,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => {
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
      });
    },
  };
}

export function createNodeProcessInventoryAdapter(input: {
  commands: ReadOnlyCommandRunner;
  exactProcess: RuntimeProcess;
}): ProcessInventoryAdapter {
  return {
    async list(options) {
      const result = await input.commands.exec("/bin/ps", [
        "-ww",
        "-axo",
        "pid=,ppid=,command=",
      ], { signal: options?.signal });
      if (result.exitCode !== 0) throw new Error(`ps inventory failed: ${result.stderr.trim()}`);
      return parseProcessInventory(result.stdout);
    },
    identify(pid, options) {
      return input.exactProcess.identify(pid, { abortSignal: options?.signal });
    },
  };
}

export function createNodePortInventoryAdapter(commands: ReadOnlyCommandRunner): PortInventoryAdapter {
  return {
    async listenersFor(port: DeclaredPort, options) {
      const result = await commands.exec("/usr/sbin/lsof", [
        "-nP",
        `-iTCP:${port}`,
        "-sTCP:LISTEN",
        "-Fpn",
      ], { signal: options?.signal });
      if (result.exitCode === 1 && result.stdout.trim().length === 0 && result.stderr.trim().length === 0) {
        return [];
      }
      if (result.exitCode !== 0) {
        const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
        throw new Error(`lsof inventory failed: ${diagnostic}`);
      }
      return parseListenerInventory(result.stdout).filter((listener) => listener.port === port);
    },
  };
}

export async function createDefaultHostStatusAdapters(): Promise<HostStatusAdapters> {
  const [exactProcess] = await Promise.all([createNodeRuntimeProcess()]);
  const commands = createNodeReadOnlyCommandRunner();
  return {
    process: createNodeProcessInventoryAdapter({ commands, exactProcess }),
    port: createNodePortInventoryAdapter(commands),
  };
}
