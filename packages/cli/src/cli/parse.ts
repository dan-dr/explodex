import { DEFAULT_ONE_SHOT_TIMEOUT_MS, parseDuration } from "./duration.ts";
import {
  GROUPS,
  resolveCommand,
  type ResolvedCommand,
} from "./descriptors.ts";
import { usageFailure } from "./errors.ts";
import type { RenderedCliResult } from "../output/envelope.ts";

export type GlobalOptions = {
  help: boolean;
  version: boolean;
  json: boolean;
  home: string | null;
  devRoot: string | null;
  timeoutMs: number;
  timeoutRaw: string | null;
  noColor: boolean;
};

export type ParseSuccess = {
  kind: "success";
  globals: GlobalOptions;
  /** Positionals before `--` that form the command path + args (excluding globals). */
  tokens: string[];
  /** Tokens after `--`. */
  endOfOptions: string[];
  resolved: ResolvedCommand | null;
  /** True when argv is only help/version/globals with no command. */
  rootOnly: boolean;
};

export type ParseResult = ParseSuccess | { kind: "failure"; rendered: RenderedCliResult };

const GLOBAL_LONG = new Set([
  "help",
  "version",
  "json",
  "home",
  "dev-root",
  "timeout",
  "no-color",
]);

/**
 * Scan argv for global options accepted anywhere before the first `--`,
 * then resolve the canonical command path.
 *
 * Precedence: --help > --version > command parsing/execution.
 */
export function parseArgv(argv: readonly string[]): ParseResult {
  const globals: GlobalOptions = {
    help: false,
    version: false,
    json: false,
    home: null,
    devRoot: null,
    timeoutMs: DEFAULT_ONE_SHOT_TIMEOUT_MS,
    timeoutRaw: null,
    noColor: false,
  };

  const tokens: string[] = [];
  const endOfOptions: string[] = [];
  let seenEnd = false;
  let jsonSeen = false;

  // First pass: detect --json anywhere before `--` so usage failures can stay machine-clean.
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--json") jsonSeen = true;
  }
  globals.json = jsonSeen;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (seenEnd) {
      endOfOptions.push(arg);
      i += 1;
      continue;
    }
    if (arg === "--") {
      seenEnd = true;
      i += 1;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      globals.help = true;
      i += 1;
      continue;
    }
    if (arg === "-V" || arg === "--version") {
      globals.version = true;
      i += 1;
      continue;
    }
    if (arg === "--json") {
      globals.json = true;
      i += 1;
      continue;
    }
    if (arg === "--no-color") {
      globals.noColor = true;
      i += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);

      if (!GLOBAL_LONG.has(name)) {
        // Command-local options stay in tokens for later command parsers.
        tokens.push(arg);
        i += 1;
        continue;
      }

      if (name === "help") {
        if (inline !== undefined) {
          return {
            kind: "failure",
            rendered: usageFailure({
              code: "usage.invalid-value",
              message: "Boolean option --help does not accept a value.",
              details: { option: "--help" },
            }),
          };
        }
        globals.help = true;
        i += 1;
        continue;
      }
      if (name === "version") {
        if (inline !== undefined) {
          return {
            kind: "failure",
            rendered: usageFailure({
              code: "usage.invalid-value",
              message: "Boolean option --version does not accept a value.",
              details: { option: "--version" },
            }),
          };
        }
        globals.version = true;
        i += 1;
        continue;
      }
      if (name === "json" || name === "no-color") {
        if (inline !== undefined) {
          return {
            kind: "failure",
            rendered: usageFailure({
              code: "usage.invalid-value",
              message: `Boolean option --${name} does not accept a value.`,
              details: { option: `--${name}` },
            }),
          };
        }
        if (name === "json") globals.json = true;
        else globals.noColor = true;
        i += 1;
        continue;
      }

      // Value-taking globals: --home, --dev-root, --timeout
      // Consume the next token even when it starts with '-' so invalid values
      // (for example --timeout -1s) surface as invalid-value, not missing-argument.
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined) {
          return {
            kind: "failure",
            rendered: usageFailure({
              code: "usage.missing-argument",
              message: `Option --${name} requires a value.`,
              details: { option: `--${name}` },
            }),
          };
        }
        value = next;
        i += 2;
      } else {
        i += 1;
      }

      if (name === "home") {
        if (globals.home !== null && globals.home !== value) {
          return {
            kind: "failure",
            rendered: usageFailure({
              code: "usage.conflicting-options",
              message: "Conflicting --home values.",
              details: { option: "--home" },
            }),
          };
        }
        globals.home = value;
        continue;
      }
      if (name === "dev-root") {
        if (globals.devRoot !== null && globals.devRoot !== value) {
          return {
            kind: "failure",
            rendered: usageFailure({
              code: "usage.conflicting-options",
              message: "Conflicting --dev-root values.",
              details: { option: "--dev-root" },
            }),
          };
        }
        globals.devRoot = value;
        continue;
      }
      if (name === "timeout") {
        const parsed = parseDuration(value);
        if (!parsed.ok) {
          return {
            kind: "failure",
            rendered: usageFailure({
              code: "usage.invalid-value",
              message: parsed.message,
              details: { option: "--timeout", value },
            }),
          };
        }
        if (globals.timeoutRaw !== null && globals.timeoutRaw !== value) {
          const previous = parseDuration(globals.timeoutRaw);
          if (!previous.ok || previous.milliseconds !== parsed.milliseconds) {
            return {
              kind: "failure",
              rendered: usageFailure({
                code: "usage.conflicting-options",
                message: "Conflicting --timeout values.",
                details: { option: "--timeout" },
              }),
            };
          }
        }
        globals.timeoutRaw = value;
        globals.timeoutMs = parsed.milliseconds;
        continue;
      }
    }

    // Short options cannot be bundled; unknown short is command-local or error later.
    if (arg.startsWith("-") && arg !== "-" && !arg.startsWith("--")) {
      tokens.push(arg);
      i += 1;
      continue;
    }

    tokens.push(arg);
    i += 1;
  }

  // help subcommand: explodex help [group [command ...]]
  if (tokens[0] === "help") {
    globals.help = true;
    tokens.shift();
  }

  const rootOnly = tokens.length === 0;
  if (rootOnly) {
    return {
      kind: "success",
      globals,
      tokens,
      endOfOptions,
      resolved: null,
      rootOnly: true,
    };
  }

  // Longest valid help prefix: if help is set, tolerate incomplete paths.
  if (globals.help) {
    const group = GROUPS.find((g) => g.name === tokens[0]);
    if (group === undefined) {
      // Unknown first token with --help → still show root help? Contract:
      // "--help shows help for the longest valid prefix and ignores later operands."
      // No valid prefix → usage error for unknown command.
      return {
        kind: "failure",
        rendered: usageFailure({
          code: "usage.unknown-command",
          message: `Unknown command '${tokens[0]}'.`,
          details: { command: tokens[0] },
        }),
      };
    }
    const resolved = resolveCommand(tokens);
    return {
      kind: "success",
      globals,
      tokens,
      endOfOptions,
      resolved,
      rootOnly: false,
    };
  }

  if (globals.version && !globals.help) {
    // --version ignores command operands when help is absent.
    return {
      kind: "success",
      globals,
      tokens,
      endOfOptions,
      resolved: null,
      rootOnly: true,
    };
  }

  const groupName = tokens[0]!;
  const group = GROUPS.find((g) => g.name === groupName);
  if (group === undefined) {
    return {
      kind: "failure",
      rendered: usageFailure({
        code: "usage.unknown-command",
        message: `Unknown command '${groupName}'.`,
        details: { command: groupName },
      }),
    };
  }

  const resolved = resolveCommand(tokens);
  if (resolved === null) {
    return {
      kind: "failure",
      rendered: usageFailure({
        code: "usage.unknown-command",
        message: `Unknown command '${tokens.join(" ")}'.`,
        usageLine: `Usage: explodex ${groupName} <command>`,
        helpPath: groupName,
        details: { command: tokens.join(" ") },
      }),
    };
  }

  return {
    kind: "success",
    globals,
    tokens,
    endOfOptions,
    resolved,
    rootOnly: false,
  };
}
