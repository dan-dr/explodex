import {
  GLOBAL_OPTIONS,
  GROUPS,
  ROOT_DESCRIPTION,
  ROOT_SAFETY,
  findGroup,
  publicPathFor,
  type CommandDescriptor,
  type GroupDescriptor,
  type OptionDescriptor,
  type ResolvedCommand,
} from "./descriptors.ts";
import { successEnvelope, type RenderedCliResult } from "../output/envelope.ts";
import { EXIT_SUCCESS } from "./exit-codes.ts";
import { readCliPackageVersion } from "./package-version.ts";

export function renderHelp(options: {
  resolved: ResolvedCommand | null;
  tokens: readonly string[];
}): RenderedCliResult {
  const text = buildHelpText(options);
  const path = helpPathLabel(options);
  const result = { path, text };
  return {
    envelope: successEnvelope("help", result),
    exitCode: EXIT_SUCCESS,
    humanStdout: text,
    humanStderr: "",
  };
}

export function renderVersion(): RenderedCliResult {
  const version = readCliPackageVersion();
  const text = `explodex ${version}\n`;
  return {
    envelope: successEnvelope("version", { version, name: "explodex" }),
    exitCode: EXIT_SUCCESS,
    humanStdout: text,
    humanStderr: "",
  };
}

function helpPathLabel(options: {
  resolved: ResolvedCommand | null;
  tokens: readonly string[];
}): string {
  if (options.resolved !== null) {
    return publicPathFor(options.resolved.command, options.resolved.group.name);
  }
  if (options.tokens.length > 0) {
    const group = findGroup(options.tokens[0]!);
    if (group !== undefined) return group.name;
  }
  return "";
}

function buildHelpText(options: {
  resolved: ResolvedCommand | null;
  tokens: readonly string[];
}): string {
  if (options.resolved !== null) {
    return commandHelp(options.resolved.group, options.resolved.command);
  }
  if (options.tokens.length > 0) {
    const group = findGroup(options.tokens[0]!);
    if (group !== undefined) return groupHelp(group);
  }
  return rootHelp();
}

function rootHelp(): string {
  const lines: string[] = [];
  lines.push("Usage");
  lines.push("  explodex [GLOBAL OPTIONS] <GROUP> <COMMAND> [ARGUMENTS] [OPTIONS]");
  lines.push("  explodex help [GROUP [COMMAND ...]]");
  lines.push("");
  lines.push("Description");
  for (const line of ROOT_DESCRIPTION.split("\n")) lines.push(`  ${line}`);
  lines.push("");
  lines.push("  " + ROOT_SAFETY.split("\n").join("\n  "));
  lines.push("");
  lines.push("Groups");
  for (const group of GROUPS) {
    lines.push(`  ${group.name.padEnd(16)}${oneLine(group.description)}`);
  }
  lines.push("");
  lines.push("Global options");
  for (const option of GLOBAL_OPTIONS) {
    lines.push(`  ${formatOption(option)}`);
    lines.push(`      ${formatOptionDescription(option)}`);
  }
  lines.push("");
  lines.push("Environment");
  lines.push("  EXPLODEX_HOME       Default Explodex home ($HOME/.explodex)");
  lines.push("  EXPLODEX_DEV_ROOT   Default development root (<home>/dev/plugin-dev)");
  lines.push("  NO_COLOR            Disable color when present");
  lines.push("  TERM=dumb           Disable color and terminal decoration");
  lines.push("");
  lines.push("Compatibility");
  lines.push("  Host: read-only /Applications/ChatGPT.app only.");
  lines.push("  Ports: main 127.0.0.1:9333, isolated development 127.0.0.1:9444.");
  lines.push("  Inspect compatibility with: explodex compatibility status");
  lines.push("");
  lines.push("Main recovery");
  lines.push("  Explodex never automatically restarts or debug-relaunches an existing authoring main.");
  lines.push("  Provide a manual debug-enabled main on 127.0.0.1:9333, then use");
  lines.push("  explodex main apply <artifact> only after isolated-dev validation.");
  lines.push("");
  lines.push("Examples");
  lines.push("  explodex host report");
  lines.push("  explodex --json compatibility status");
  lines.push("  explodex help plugin");
  lines.push("");
  lines.push("More information");
  lines.push("  explodex help <group>");
  lines.push("  explodex <group> <command> --help");
  lines.push("");
  return lines.join("\n");
}

function groupHelp(group: GroupDescriptor): string {
  const lines: string[] = [];
  lines.push("Usage");
  lines.push(`  explodex ${group.name} <command> [arguments] [options]`);
  lines.push("");
  lines.push("Description");
  lines.push(`  ${group.description}`);
  lines.push("");
  lines.push("Commands");
  for (const command of group.commands) {
    const path = command.path.join(" ");
    lines.push(`  ${path.padEnd(22)}${command.summary}`);
    if (command.aliases !== undefined && command.aliases.length > 0) {
      lines.push(`      Aliases: ${command.aliases.join(", ")}`);
    }
  }
  lines.push("");
  lines.push("Shared options");
  lines.push("  See global options: explodex --help");
  lines.push("");
  lines.push("Examples");
  const firstAvailable = group.commands.find((c) => c.availability === "available");
  if (firstAvailable !== undefined) {
    lines.push(`  explodex ${group.name} ${firstAvailable.path.join(" ")}`);
  } else {
    lines.push(`  explodex help ${group.name}`);
  }
  lines.push("");
  lines.push("More information");
  lines.push(`  explodex help ${group.name} <command>`);
  lines.push(`  explodex ${group.name} <command> --help`);
  lines.push("");
  return lines.join("\n");
}

function commandHelp(group: GroupDescriptor, command: CommandDescriptor): string {
  const path = publicPathFor(command, group.name);
  const lines: string[] = [];
  lines.push("Usage");
  lines.push(`  ${usageSynopsis(group.name, command)}`);
  lines.push("");
  lines.push("Summary");
  lines.push(`  ${command.summary}`);
  if (command.aliases !== undefined && command.aliases.length > 0) {
    lines.push(`  Aliases: ${command.aliases.join(", ")}`);
  }
  lines.push("");
  lines.push("Arguments");
  if (command.arguments !== undefined && command.arguments.length > 0) {
    for (const argument of command.arguments) {
      const req = argument.required ? "required" : "optional";
      lines.push(`  ${argument.name.padEnd(16)}${argument.description} (${req})`);
    }
  } else {
    lines.push("  None.");
  }
  lines.push("");
  lines.push("Options");
  if (command.options !== undefined && command.options.length > 0) {
    for (const option of command.options) {
      lines.push(`  ${formatOption(option)}`);
      lines.push(`      ${formatOptionDescription(option)}`);
    }
  } else {
    lines.push("  No command-local options.");
  }
  lines.push("  Global options are accepted anywhere before --; see explodex --help.");
  lines.push("");
  lines.push("Output");
  lines.push("  Human mode writes the primary result to stdout and diagnostics to stderr.");
  lines.push("  --json writes one schemaVersion-1 envelope to stdout.");
  lines.push("");
  lines.push("Exit status");
  lines.push("  0 success, 1 operational failure, 2 usage error, 3 blocked, 4 busy, 5 timeout, 130 interrupted");
  lines.push("");
  lines.push("Examples");
  const synopsis = usageSynopsis(group.name, command).replace(/^explodex /, "");
  lines.push(`  explodex ${synopsis}`);
  lines.push(`  explodex --json ${synopsis}`);
  lines.push("");
  if (command.recovery !== undefined) {
    lines.push("Recovery");
    lines.push(`  ${command.recovery}`);
    lines.push("");
  } else if (group.name === "host" || group.name === "compatibility" || group.name === "main") {
    lines.push("Recovery");
    lines.push("  Run explodex compatibility status, then validate on the exact owned 9444 development target.");
    lines.push("  Provide a manual debug-enabled main on 127.0.0.1:9333 when final apply is required.");
    lines.push("");
  }
  return lines.join("\n");
}

function usageSynopsis(groupName: string, command: CommandDescriptor): string {
  const parts = ["explodex", groupName, ...command.path];
  if (command.arguments !== undefined) {
    for (const argument of command.arguments) {
      if (argument.required) parts.push(`<${argument.name}>`);
      else parts.push(`[${argument.name}]`);
    }
  }
  if (command.options !== undefined && command.options.length > 0) {
    for (const option of command.options) {
      const spelling = `--${option.long}${option.valueName === undefined ? "" : ` <${option.valueName}>${option.repeatable ? "..." : ""}`}`;
      parts.push(option.required ? spelling : `[${spelling}]`);
    }
  }
  return parts.join(" ");
}

function formatOption(option: OptionDescriptor): string {
  const short = option.short !== undefined ? `-${option.short}, ` : "    ";
  const value = option.valueName !== undefined
    ? ` <${option.valueName}>${option.repeatable ? "..." : ""}`
    : "";
  return `${short}--${option.long}${value}`;
}

function formatOptionDescription(option: OptionDescriptor): string {
  const semantics: string[] = [];
  if (option.required) semantics.push("required");
  if (option.repeatable) semantics.push("repeatable");
  if (option.choices !== undefined) {
    semantics.push(`values: ${option.choices.join("|")}`);
  }
  if (option.defaultValue !== undefined) {
    semantics.push(`default: ${option.defaultValue}`);
  }
  return semantics.length === 0
    ? option.description
    : `${option.description} (${semantics.join("; ")})`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
