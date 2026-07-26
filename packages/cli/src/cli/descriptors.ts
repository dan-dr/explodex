/**
 * Static public CLI descriptor graph (library/cli-surface.md).
 * Help and parsing are derived only from this frozen surface.
 */

export type CommandAvailability = "available" | "reserved";

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
    description: "Override the Explodex home directory (default: $HOME/.explodex).",
    valueName: "path",
  },
  {
    long: "dev-root",
    description: "Override the isolated development root (default: <home>/dev/plugin-dev).",
    valueName: "path",
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
      {
        path: ["extract"],
        operation: "host.extract",
        summary: "Copy only requested allowlisted host evidence to the private inspection cache.",
        availability: "reserved",
        arguments: [
          {
            name: "path",
            description: "Allowlisted host evidence path (repeatable via --path).",
            required: true,
            variadic: true,
          },
        ],
        options: [
          {
            long: "path",
            description: "Allowlisted host evidence path.",
            valueName: "path",
            repeatable: true,
          },
        ],
      },
    ],
  },
  {
    name: "compatibility",
    description: "Exact compatibility key status and isolated proof.",
    commands: [
      {
        path: ["status"],
        operation: "compatibility.status",
        summary: "Read-only exact compatibility key and status.",
        availability: "available",
        aliases: ["report"],
      },
      {
        path: ["probe"],
        operation: "compatibility.probe",
        summary: "Complete isolated-development proof on 9444; persist only one complete result.",
        availability: "reserved",
      },
    ],
  },
  {
    name: "main",
    description: "Authoring-main classification, launch, attach, and final apply.",
    commands: [
      {
        path: ["status"],
        operation: "main.status",
        summary: "Read-only main classification and separate 9333 obstruction.",
        availability: "available",
      },
      {
        path: ["launch"],
        operation: "main.launch",
        summary: "Strict explicit launch only from no-main, free 9333, and current proof.",
        availability: "reserved",
      },
      {
        path: ["attach"],
        operation: "main.attach",
        summary: "Bounded operation against a manually supplied exact 9333 main.",
        availability: "reserved",
      },
      {
        path: ["apply"],
        operation: "main.apply",
        summary: "Final hot-safe apply after exact dev validation and fresh main authorization.",
        availability: "reserved",
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
        summary: "Install a plugin archive or registry identity as disabled.",
        availability: "reserved",
        aliases: ["add"],
      },
      {
        path: ["status"],
        operation: "plugin.status",
        summary: "Show installed, pending, and enabled plugin state.",
        availability: "reserved",
      },
      {
        path: ["refresh"],
        operation: "plugin.refresh",
        summary: "Discover installed plugins and present pending review when required.",
        availability: "reserved",
      },
      {
        path: ["review"],
        operation: "plugin.review",
        summary: "Present metadata-only review for pending plugins.",
        availability: "reserved",
      },
      {
        path: ["update", "check"],
        operation: "plugin.update.check",
        summary: "Check for available plugin updates without applying them.",
        availability: "reserved",
      },
      {
        path: ["update", "apply"],
        operation: "plugin.update.apply",
        summary: "Apply selected plugin updates after review.",
        availability: "reserved",
      },
      {
        path: ["disable"],
        operation: "plugin.disable",
        summary: "Disable an installed plugin without removing its bytes.",
        availability: "reserved",
      },
      {
        path: ["remove"],
        operation: "plugin.remove",
        summary: "Remove an installed plugin identity.",
        availability: "reserved",
      },
      {
        path: ["onboard"],
        operation: "plugin.onboard",
        summary: "First-run registry onboarding for disabled installation choices.",
        availability: "reserved",
      },
      {
        path: ["develop"],
        operation: "plugin.develop",
        summary: "Foreground plugin build/watch against the exact owned development instance.",
        availability: "reserved",
      },
    ],
  },
  {
    name: "dev",
    description: "Exact owned isolated development instance on 9444.",
    commands: [
      { path: ["status"], operation: "dev.status", summary: "Read-only development ownership status.", availability: "reserved" },
      { path: ["start"], operation: "dev.start", summary: "Start the exact owned development instance.", availability: "reserved" },
      { path: ["ensure"], operation: "dev.ensure", summary: "Ensure the exact owned development instance is ready.", availability: "reserved" },
      { path: ["recover"], operation: "dev.recover", summary: "Recover from uncertain development ownership.", availability: "reserved" },
      { path: ["inject"], operation: "dev.inject", summary: "Inject an artifact into the owned development instance.", availability: "reserved" },
      { path: ["restart"], operation: "dev.restart", summary: "Restart only the exact owned development process.", availability: "reserved" },
      { path: ["stop"], operation: "dev.stop", summary: "Stop only the exact owned development process.", availability: "reserved" },
      { path: ["focus"], operation: "dev.focus", summary: "Focus the owned development instance.", availability: "reserved" },
    ],
  },
  {
    name: "legacy",
    description: "Legacy doctor and exact itemized cleanup.",
    commands: [
      { path: ["doctor"], operation: "legacy.doctor", summary: "Report legacy install state.", availability: "reserved" },
      { path: ["cleanup"], operation: "legacy.cleanup", summary: "Remove exact itemized legacy items.", availability: "reserved" },
    ],
  },
  {
    name: "skill",
    description: "Install or update the matching plugin-builder skill.",
    commands: [
      { path: ["install"], operation: "skill.install", summary: "Install the matching plugin-builder skill.", availability: "reserved" },
      { path: ["update"], operation: "skill.update", summary: "Update the installed plugin-builder skill.", availability: "reserved" },
    ],
  },
  {
    name: "release",
    description: "Release candidate, rehearsal, publication, and verification.",
    commands: [
      { path: ["candidate"], operation: "release.candidate", summary: "Create a release candidate.", availability: "reserved" },
      { path: ["rehearse"], operation: "release.rehearse", summary: "Rehearse publication without public mutation.", availability: "reserved" },
      { path: ["publish"], operation: "release.publish", summary: "Publish an exact authorized candidate.", availability: "reserved" },
      { path: ["verify"], operation: "release.verify", summary: "Verify a published candidate.", availability: "reserved" },
      { path: ["status"], operation: "release.status", summary: "Show candidate-ready versus release-complete status.", availability: "reserved" },
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
