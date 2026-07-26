import { publicPathFor } from "./descriptors.ts";
import { usageFailure, renderFailure } from "./errors.ts";
import { renderHelp, renderVersion } from "./help.ts";
import type { ParseSuccess } from "./parse.ts";
import type { RenderedCliResult } from "../output/envelope.ts";
import { runHostReport } from "../commands/host-report.ts";
import { runCompatibilityStatus } from "../commands/compatibility-status.ts";
import { runMainStatus } from "../commands/main-status.ts";

export async function dispatch(options: {
  parsed: ParseSuccess;
  env: NodeJS.ProcessEnv;
}): Promise<RenderedCliResult> {
  const { parsed, env } = options;

  // --help > --version > command execution
  if (parsed.globals.help) {
    return renderHelp({
      resolved: parsed.resolved,
      tokens: parsed.tokens,
    });
  }

  if (parsed.globals.version || (parsed.rootOnly && parsed.tokens.length === 0 && !parsed.globals.help)) {
    // Bare `explodex` without subcommand: show help, not version.
    if (parsed.rootOnly && !parsed.globals.version) {
      return renderHelp({ resolved: null, tokens: [] });
    }
    return renderVersion();
  }

  if (parsed.resolved === null) {
    return usageFailure({
      code: "usage.unknown-command",
      message: "A command is required.",
    });
  }

  const { command, group, rest, endOfOptions } = {
    command: parsed.resolved.command,
    group: parsed.resolved.group,
    rest: parsed.resolved.rest,
    endOfOptions: parsed.endOfOptions,
  };

  if (command.availability === "reserved") {
    const path = publicPathFor(command, group.name);
    return renderFailure({
      operation: command.operation,
      code: "usage.command-unavailable",
      message: `Command '${path}' is reserved and not available in this release.`,
      details: { command: path, operation: command.operation },
      humanStderr: [
        `Command '${path}' is reserved and not available in this release.`,
        `error.code: usage.command-unavailable`,
        `Run 'explodex help ${path}' for details.`,
      ].join("\n") + "\n",
    });
  }

  // Available commands reject unexpected leftover options for the M2 surface.
  const leftovers = [...rest, ...endOfOptions];
  if (leftovers.length > 0) {
    const path = publicPathFor(command, group.name);
    return usageFailure({
      operation: "cli.parse",
      code: "usage.unknown-option",
      message: `Unexpected argument or option '${leftovers[0]}'.`,
      usageLine: `Usage: explodex ${path}`,
      helpPath: path,
      details: { argument: leftovers[0] },
    });
  }

  switch (command.operation) {
    case "host.report":
      return runHostReport({ globals: parsed.globals, env });
    case "compatibility.status":
      return runCompatibilityStatus({ globals: parsed.globals, env });
    case "main.status":
      return runMainStatus();
    default:
      return renderFailure({
        operation: command.operation,
        code: "operation.internal",
        message: `No handler registered for operation '${command.operation}'.`,
      });
  }
}
