import type { ProcessObservation } from "../host/status.ts";
import type { ListenerObservation } from "../host/status.ts";

export type OwnedListenerAuthority = {
  ok: boolean;
  rootListener: ListenerObservation | null;
  companionPids: number[];
  foreignPids: number[];
};

function belongsToRoot(process: ProcessObservation, roots: readonly string[]) {
  return roots.some((root) =>
    process.executablePath === root ||
    process.executablePath.startsWith(`${root}/`) ||
    process.arguments.some((token) =>
      token === root || token.startsWith(`${root}/`)
    )
  );
}

export function classifyOwnedListenerAuthority(options: {
  rootPid: number;
  rootProcessStartedAt: string;
  listeners: readonly ListenerObservation[];
  processes: readonly ProcessObservation[];
  privateRoots: readonly string[];
}): OwnedListenerAuthority {
  const rootListeners = options.listeners.filter((listener) =>
    listener.pid === options.rootPid &&
    listener.processStartedAt === options.rootProcessStartedAt
  );
  const byPid = new Map(
    options.processes.map((process) => [process.pid, process]),
  );
  const isDescendant = (pid: number): boolean => {
    const visited = new Set<number>();
    let current = byPid.get(pid);
    while (current !== undefined && !visited.has(current.pid)) {
      if (current.parentPid === options.rootPid) return true;
      visited.add(current.pid);
      current = byPid.get(current.parentPid);
    }
    return false;
  };
  const companionPids: number[] = [];
  const foreignPids: number[] = [];
  for (const pid of new Set(
    options.listeners
      .filter((listener) => listener.pid !== options.rootPid)
      .map((listener) => listener.pid),
  )) {
    const process = byPid.get(pid);
    if (
      process !== undefined &&
      isDescendant(pid) &&
      belongsToRoot(process, options.privateRoots)
    ) {
      companionPids.push(pid);
    } else {
      foreignPids.push(pid);
    }
  }
  companionPids.sort((left, right) => left - right);
  foreignPids.sort((left, right) => left - right);
  return {
    ok: rootListeners.length === 1 && foreignPids.length === 0,
    rootListener: rootListeners.length === 1 ? rootListeners[0]! : null,
    companionPids,
    foreignPids,
  };
}
