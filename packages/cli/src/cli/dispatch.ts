import { publicPathFor } from "./descriptors.ts";
import { usageFailure, renderFailure } from "./errors.ts";
import { renderHelp, renderVersion } from "./help.ts";
import type { ParseSuccess } from "./parse.ts";
import type { RenderedCliResult } from "../output/envelope.ts";
import { runHostReport } from "../commands/host-report.ts";
import { runCompatibilityStatus } from "../commands/compatibility-status.ts";
import { runMainStatus } from "../commands/main-status.ts";
import { runPluginCreate } from "../commands/plugin-create.ts";
import { runPluginValidate } from "../commands/plugin-validate.ts";
import { runPluginBuild } from "../commands/plugin-build.ts";
import { runPluginPackage } from "../commands/plugin-package.ts";
import { runPluginArtifactValidate } from "../commands/plugin-artifact-validate.ts";
import { runPluginInstall } from "../commands/plugin-install.ts";
import { runPluginRefresh } from "../commands/plugin-refresh.ts";
import { runPluginStatus } from "../commands/plugin-status.ts";
import { runPluginUpdateCheck } from "../commands/plugin-update-check.ts";
import { runPluginUpdateApply } from "../commands/plugin-update-apply.ts";
import { runPluginReview } from "../commands/plugin-review.ts";
import { runPluginDisable } from "../commands/plugin-disable.ts";
import { runPluginRemove } from "../commands/plugin-remove.ts";
import { runPluginDevelop } from "../commands/plugin-develop.ts";
import { runDevStatus } from "../commands/dev-status.ts";
import { runDevRecover } from "../commands/dev-recover.ts";
import { runDevLifecycle } from "../commands/dev-lifecycle.ts";
import { runDevInject } from "../commands/dev-inject.ts";
import { runDevFocus } from "../commands/dev-focus.ts";
import type { CliIo } from "../output/write.ts";

/** Operations that parse their own positional arguments. */
const ACCEPTS_POSITIONALS = new Set([
  "plugin.create",
  "plugin.validate",
  "plugin.build",
  "plugin.package",
  "plugin.artifact.validate",
  "plugin.install",
  "plugin.status",
  "plugin.refresh",
  "plugin.review",
  "plugin.update.check",
  "plugin.update.apply",
  "plugin.disable",
  "plugin.remove",
  "plugin.develop",
  "dev.inject",
]);

const IMPLEMENTED_RESERVED_OPERATIONS = new Set([
  "plugin.disable",
  "plugin.remove",
  "dev.status",
  "dev.start",
  "dev.ensure",
  "dev.recover",
  "dev.restart",
  "dev.stop",
  "dev.inject",
  "dev.focus",
  "plugin.update.apply",
  "plugin.develop",
]);

export async function dispatch(options: {
  parsed: ParseSuccess;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const { parsed, env, io, signal } = options;

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

  if (
    command.availability === "reserved" &&
    !IMPLEMENTED_RESERVED_OPERATIONS.has(command.operation)
  ) {
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

  // Available commands without positional arguments reject leftovers.
  // Commands that accept arguments parse rest themselves.
  if (!ACCEPTS_POSITIONALS.has(command.operation)) {
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
  }

  switch (command.operation) {
    case "host.report":
      return runHostReport({ globals: parsed.globals, env });
    case "compatibility.status":
      return runCompatibilityStatus({ globals: parsed.globals, env });
    case "main.status":
      return runMainStatus();
    case "plugin.create":
      return runPluginCreate({
        globals: parsed.globals,
        env,
        rest,
        endOfOptions,
      });
    case "plugin.validate":
      return runPluginValidate({
        globals: parsed.globals,
        env,
        rest,
        endOfOptions,
      });
    case "plugin.build":
      return runPluginBuild({
        globals: parsed.globals,
        env,
        rest,
        endOfOptions,
      });
    case "plugin.package":
      return runPluginPackage({
        globals: parsed.globals,
        env,
        rest,
        endOfOptions,
      });
    case "plugin.artifact.validate":
      return runPluginArtifactValidate({
        globals: parsed.globals,
        env,
        rest,
        endOfOptions,
      });
    case "plugin.install":
      return runPluginInstall({
        globals: parsed.globals,
        env,
        io,
        rest,
        endOfOptions,
        signal,
      });
    case "plugin.status":
      return runPluginStatus({
        globals: parsed.globals,
        env,
        rest,
        endOfOptions,
      });
    case "plugin.refresh":
      return runPluginRefresh({
        globals: parsed.globals,
        env,
        io,
        rest,
        endOfOptions,
        signal,
      });
    case "plugin.review":
      return runPluginReview({
        globals: parsed.globals,
        env,
        io,
        rest,
        endOfOptions,
        signal,
      });
    case "plugin.update.check":
      return runPluginUpdateCheck({
        globals: parsed.globals,
        env,
        rest,
        endOfOptions,
        signal,
      });
    case "plugin.update.apply":
      return runPluginUpdateApply({
        globals: parsed.globals,
        env,
        io,
        rest,
        endOfOptions,
        signal,
      });
    case "plugin.disable":
      return runPluginDisable({
        globals: parsed.globals,
        env,
        rest,
        endOfOptions,
        signal,
      });
    case "plugin.remove":
      return runPluginRemove({
        globals: parsed.globals,
        env,
        rest,
        endOfOptions,
        signal,
      });
    case "plugin.develop":
      return runPluginDevelop({
        globals: parsed.globals,
        env,
        io,
        rest,
        endOfOptions,
        signal,
      });
    case "dev.status":
      return runDevStatus({
        globals: parsed.globals,
        env,
        signal,
      });
    case "dev.recover":
      return runDevRecover({
        globals: parsed.globals,
        env,
        signal,
      });
    case "dev.start":
      return runDevLifecycle({
        kind: "start",
        globals: parsed.globals,
        env,
        signal,
      });
    case "dev.ensure":
      return runDevLifecycle({
        kind: "ensure",
        globals: parsed.globals,
        env,
        signal,
      });
    case "dev.restart":
      return runDevLifecycle({
        kind: "restart",
        globals: parsed.globals,
        env,
        signal,
      });
    case "dev.stop":
      return runDevLifecycle({
        kind: "stop",
        globals: parsed.globals,
        env,
        signal,
      });
    case "dev.inject":
      return runDevInject({
        globals: parsed.globals,
        env,
        rest,
        endOfOptions,
        signal,
      });
    case "dev.focus":
      return runDevFocus({
        globals: parsed.globals,
        env,
        signal,
      });
    default:
      return renderFailure({
        operation: command.operation,
        code: "operation.internal",
        message: `No handler registered for operation '${command.operation}'.`,
      });
  }
}
