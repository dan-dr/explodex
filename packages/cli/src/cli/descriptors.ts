/**
 * Static public CLI descriptor graph (library/cli-surface.md).
 * Help and parsing are derived only from this frozen surface.
 */

export type CommandAvailability = "available";

export type CommandDescriptor = {
  /** Canonical tokens after the group, e.g. ["report"] or ["update", "check"]. */
  path: readonly string[];
  /** Canonical dotted operation, e.g. "host.report". */
  operation: string;
  summary: string;
  availability: CommandAvailability;
  aliases?: readonly string[];
  arguments?: readonly ArgumentDescriptor[];
  options?: readonly OptionDescriptor[];
  recovery?: string;
};

export type ArgumentDescriptor = {
  name: string;
  description: string;
  required: boolean;
  variadic?: boolean;
};

export type OptionDescriptor = {
  long: string;
  short?: string;
  description: string;
  valueName?: string;
  repeatable?: boolean;
  required?: boolean;
  choices?: readonly string[];
  defaultValue?: string;
};

export type GroupDescriptor = {
  name: string;
  description: string;
  commands: readonly CommandDescriptor[];
};

export const ROOT_DESCRIPTION =
  "Explodex manages trusted plugins for the installed read-only\n/Applications/ChatGPT.app with bounded one-shot operations.";

export const ROOT_SAFETY =
  "Explodex runs no daemon and never automatically restarts, reloads,\nnavigates, closes, or stops an existing authoring main.";

export const GLOBAL_OPTIONS: readonly OptionDescriptor[] = [
  { long: "help", short: "h", description: "Show help for the selected path and exit." },
  { long: "version", short: "V", description: "Print the CLI version and exit." },
  { long: "json", description: "Emit one schemaVersion-1 JSON envelope on stdout." },
  {
    long: "home",
    description: "Override the Explodex home directory.",
    valueName: "path",
    defaultValue: "$HOME/.explodex",
  },
  {
    long: "dev-root",
    description: "Override the isolated development root.",
    valueName: "path",
    defaultValue: "<home>/dev/plugin-dev",
  },
  {
    long: "timeout",
    description: "Application-level bound for the operation (for example 60s).",
    valueName: "duration",
  },
  { long: "no-color", description: "Disable ANSI color even on a TTY." },
];

export const GROUPS: readonly GroupDescriptor[] = [
  {
    name: "host",
    description: "Read-only ChatGPT.app identity and host evidence.",
    commands: [
      {
        path: ["report"],
        operation: "host.report",
        summary: "Read-only canonical host identity and separate compatibility summary.",
        availability: "available",
        aliases: ["inspect"],
      },
    ],
  },
  {
    name: "compatibility",
    description: "Exact compatibility key status.",
    commands: [
      {
        path: ["status"],
        operation: "compatibility.status",
        summary: "Read-only exact compatibility key and status.",
        availability: "available",
        aliases: ["report"],
      },
    ],
  },
  {
    name: "main",
    description: "Authoring-main classification and final apply.",
    commands: [
      {
        path: ["status"],
        operation: "main.status",
        summary: "Read-only main classification and separate 9333 obstruction.",
        availability: "available",
      },
      {
        path: ["apply"],
        operation: "main.apply",
        summary: "Final hot-safe apply after exact dev validation and fresh main authorization.",
        availability: "available",
        arguments: [
          { name: "artifact", description: "Path to a validated plugin artifact.", required: true },
        ],
      },
    ],
  },
  {
    name: "plugin",
    description: "Plugin authoring, artifacts, lifecycle, and registry operations.",
    commands: [
      {
        path: ["create"],
        operation: "plugin.create",
        summary: "Create a safe generated-only plugin workspace.",
        availability: "available",
        arguments: [
          { name: "directory", description: "Target directory for the new workspace.", required: true },
        ],
      },
      {
        path: ["validate"],
        operation: "plugin.validate",
        summary: "Validate a plugin workspace source contract.",
        availability: "available",
        arguments: [
          { name: "workspace", description: "Plugin workspace path (default: cwd).", required: false },
        ],
      },
      {
        path: ["build"],
        operation: "plugin.build",
        summary: "Build browser-safe plugin artifacts into dist/.",
        availability: "available",
        arguments: [
          { name: "workspace", description: "Plugin workspace path (default: cwd).", required: false },
        ],
      },
      {
        path: ["package"],
        operation: "plugin.package",
        summary: "Package a validated plugin artifact archive.",
        availability: "available",
        arguments: [
          { name: "workspace", description: "Plugin workspace path (default: cwd).", required: false },
        ],
        options: [
          {
            long: "output",
            description: "Directory for the packaged archive.",
            valueName: "directory",
          },
        ],
      },
      {
        path: ["artifact", "validate"],
        operation: "plugin.artifact.validate",
        summary: "Validate a standalone packaged plugin artifact.",
        availability: "available",
        arguments: [
          { name: "path", description: "Path to the packaged artifact.", required: true },
        ],
      },
      {
        path: ["install"],
        operation: "plugin.install",
        summary: "Atomically install a prebuilt plugin archive disabled and pending review.",
        availability: "available",
        aliases: ["add"],
        arguments: [
          {
            name: "archive",
            description: "Local prebuilt .tar.gz or .tgz plugin archive.",
            required: false,
          },
        ],
        options: [
          {
            long: "registry",
            description: "Install an exact plugin ID from the configured registry.",
            valueName: "id",
          },
          {
            long: "github-url",
            description: "Install from one canonical immutable GitHub release URL.",
            valueName: "url",
          },
          {
            long: "archive-sha256",
            description: "Expected lowercase SHA-256 of exact archive bytes.",
            valueName: "hex",
          },
          {
            long: "payload-sha256",
            description: "Optional expected lowercase canonical payload SHA-256.",
            valueName: "hex",
          },
          {
            long: "target",
            description: "Review target role; unavailable targets leave the install disabled and pending.",
            valueName: "role",
            choices: ["none", "main", "development"],
            defaultValue: "none",
          },
        ],
      },
      {
        path: ["status"],
        operation: "plugin.status",
        summary: "Show installed, pending, and enabled plugin state.",
        availability: "available",
        arguments: [
          { name: "id", description: "Optional exact plugin ID.", required: false },
        ],
      },
      {
        path: ["refresh"],
        operation: "plugin.refresh",
        summary: "Discover installed plugins and present pending review when required.",
        availability: "available",
        options: [
          {
            long: "target",
            description: "Review target role; unavailable targets never force a renderer.",
            valueName: "role",
            choices: ["main", "development"],
            defaultValue: "main",
          },
        ],
      },
      {
        path: ["review"],
        operation: "plugin.review",
        summary: "Present metadata-only review for pending plugins.",
        availability: "available",
        arguments: [
          { name: "id", description: "Optional exact plugin ID.", required: false },
        ],
        options: [
          {
            long: "artifact-version",
            description: "Exact opaque artifact version when one ID has multiple identities.",
            valueName: "opaque-version",
          },
          {
            long: "payload-sha256",
            description: "Exact lowercase payload SHA-256.",
            valueName: "hex",
          },
          {
            long: "target",
            description: "Review target role (main or development).",
            valueName: "role",
            choices: ["main", "development"],
            defaultValue: "main",
          },
        ],
      },
      {
        path: ["update", "check"],
        operation: "plugin.update.check",
        summary: "Check for available plugin updates without applying them.",
        availability: "available",
      },
      {
        path: ["update", "apply"],
        operation: "plugin.update.apply",
        summary: "Apply selected plugin updates after review.",
        availability: "available",
        options: [
          {
            long: "target",
            description: "Review/application target role.",
            valueName: "role",
            choices: ["main", "development"],
            defaultValue: "main",
          },
        ],
      },
      {
        path: ["disable"],
        operation: "plugin.disable",
        summary: "Disable an installed plugin without removing its bytes.",
        availability: "available",
        arguments: [
          { name: "id", description: "Exact plugin ID.", required: true },
        ],
        options: [
          {
            long: "target",
            description: "Optional live teardown target role.",
            valueName: "role",
            choices: ["none", "main", "development"],
            defaultValue: "none",
          },
        ],
      },
      {
        path: ["remove"],
        operation: "plugin.remove",
        summary: "Remove an installed plugin identity.",
        availability: "available",
        arguments: [
          { name: "id", description: "Exact plugin ID.", required: true },
        ],
        options: [
          {
            long: "artifact-version",
            description: "Exact opaque artifact version when multiple identities exist.",
            valueName: "opaque-version",
          },
          {
            long: "payload-sha256",
            description: "Exact lowercase payload SHA-256.",
            valueName: "hex",
          },
          {
            long: "target",
            description: "Optional live teardown target role.",
            valueName: "role",
            choices: ["none", "main", "development"],
            defaultValue: "none",
          },
        ],
      },
      {
        path: ["develop"],
        operation: "plugin.develop",
        summary: "Foreground plugin build/watch against the exact owned development instance.",
        availability: "available",
        arguments: [
          {
            name: "workspace",
            description: "Plugin workspace path (default: cwd).",
            required: false,
          },
        ],
        options: [
          {
            long: "sdk-source",
            description: "Explicit canonical local SDK source workspace.",
            valueName: "path",
          },
        ],
      },
    ],
  },
  {
    name: "dev",
    description: "One persistent isolated development instance on 127.0.0.1:9444.",
    commands: [
      { path: ["status"], operation: "dev.status", summary: "Check health, ownership, crash state, and the next safe action.", availability: "available" },
      { path: ["start"], operation: "dev.start", summary: "Start the stopped development instance once.", availability: "available" },
      { path: ["ensure"], operation: "dev.ensure", summary: "Reuse, safely recover if confirmed dead, or start the development instance once.", availability: "available" },
      { path: ["recover"], operation: "dev.recover", summary: "Explicitly recover a failed or interrupted development record.", availability: "available" },
      {
        path: ["inject"],
        operation: "dev.inject",
        summary: "Inject an artifact into the owned development instance.",
        availability: "available",
        arguments: [
          { name: "artifact", description: "Path to a validated plugin artifact.", required: true },
        ],
      },
      { path: ["restart"], operation: "dev.restart", summary: "Restart only the exact owned development process once.", availability: "available" },
      { path: ["stop"], operation: "dev.stop", summary: "Stop only the exact owned development process.", availability: "available" },
      { path: ["focus"], operation: "dev.focus", summary: "Focus the owned development instance when exact process-specific activation is supported.", availability: "available" },
    ],
  },
];

export type ResolvedCommand = {
  group: GroupDescriptor;
  command: CommandDescriptor;
  /** Tokens matched including alias expansion. */
  matchedTokens: string[];
  /** Remaining argv after the command path. */
  rest: string[];
};

export function findGroup(name: string): GroupDescriptor | undefined {
  return GROUPS.find((group) => group.name === name);
}

export function resolveCommand(tokens: readonly string[]): ResolvedCommand | null {
  if (tokens.length === 0) return null;
  const group = findGroup(tokens[0]!);
  if (group === undefined) return null;

  // Prefer longest matching command path.
  const candidates = [...group.commands].sort((a, b) => b.path.length - a.path.length);
  for (const command of candidates) {
    const needed = command.path.length;
    if (tokens.length - 1 < needed) continue;
    const slice = tokens.slice(1, 1 + needed);
    if (pathsEqual(slice, command.path)) {
      return {
        group,
        command,
        matchedTokens: [group.name, ...command.path],
        rest: tokens.slice(1 + needed).map(String),
      };
    }
    // Alias for the first path segment only when command path is length 1.
    if (
      command.path.length === 1 &&
      command.aliases !== undefined &&
      command.aliases.includes(slice[0]!)
    ) {
      return {
        group,
        command,
        matchedTokens: [group.name, command.path[0]!],
        rest: tokens.slice(2).map(String),
      };
    }
  }
  return null;
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function publicPathFor(command: CommandDescriptor, groupName: string): string {
  return [groupName, ...command.path].join(" ");
}
