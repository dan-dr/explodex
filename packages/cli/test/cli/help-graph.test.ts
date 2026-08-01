import { describe, expect, test } from "bun:test";
import {
  GROUPS,
  publicPathFor,
  type CommandDescriptor,
} from "../../src/cli/descriptors.ts";
import { captureCli } from "../helpers/run-cli.ts";

type FrozenShape = {
  arguments?: string[];
  options?: string[];
};

const FROZEN_COMMAND_SHAPES: Record<string, FrozenShape> = {
  "host report": {},
  "compatibility status": {},
  "main status": {},
  "main apply": { arguments: ["artifact"] },
  "plugin create": { arguments: ["directory"] },
  "plugin validate": { arguments: ["workspace?"] },
  "plugin build": { arguments: ["workspace?"] },
  "plugin package": {
    arguments: ["workspace?"],
    options: ["output"],
  },
  "plugin artifact validate": { arguments: ["path"] },
  "plugin install": {
    arguments: ["archive?"],
    options: [
      "registry",
      "github-url",
      "archive-sha256",
      "payload-sha256",
      "target",
    ],
  },
  "plugin status": { arguments: ["id?"] },
  "plugin refresh": { options: ["target"] },
  "plugin review": {
    arguments: ["id?"],
    options: ["artifact-version", "payload-sha256", "target"],
  },
  "plugin update check": {},
  "plugin update apply": { options: ["target"] },
  "plugin disable": { arguments: ["id"], options: ["target"] },
  "plugin remove": {
    arguments: ["id"],
    options: ["artifact-version", "payload-sha256", "target"],
  },
  "plugin develop": {
    arguments: ["workspace?"],
    options: ["sdk-source"],
  },
  "dev status": {},
  "dev prove": {},
  "dev start": {},
  "dev ensure": {},
  "dev recover": {},
  "dev inject": { arguments: ["artifact"] },
  "dev restart": {},
  "dev stop": {},
  "dev focus": {},
};

function argumentShape(command: CommandDescriptor): string[] {
  return (command.arguments ?? []).map((argument) =>
    `${argument.name}${argument.required ? "" : "?"}${argument.variadic ? "..." : ""}`
  );
}

function optionShape(command: CommandDescriptor): string[] {
  return (command.options ?? []).map((option) =>
    `${option.long}${option.repeatable ? "..." : ""}`
  );
}

describe("frozen CLI descriptor and help graph", () => {
  test("publishes every implemented lifecycle command as available", () => {
    const availabilityByOperation = new Map(
      GROUPS.flatMap((group) =>
        group.commands.map((command) => [command.operation, command.availability] as const),
      ),
    );

    expect(
      [
        "main.apply",
        "plugin.disable",
        "plugin.remove",
        "plugin.develop",
        "plugin.update.apply",
        "dev.inject",
        "dev.focus",
      ].map((operation) => [operation, availabilityByOperation.get(operation)]),
    ).toEqual([
      ["main.apply", "available"],
      ["plugin.disable", "available"],
      ["plugin.remove", "available"],
      ["plugin.develop", "available"],
      ["plugin.update.apply", "available"],
      ["dev.inject", "available"],
      ["dev.focus", "available"],
    ]);

    expect(
      GROUPS.flatMap((group) => group.commands).every(
        (command) => command.availability === "available",
      ),
    ).toBe(true);
  });

  test("carries every frozen command operand and option", () => {
    const actual: Record<string, FrozenShape> = {};
    for (const group of GROUPS) {
      for (const command of group.commands) {
        const path = publicPathFor(command, group.name);
        actual[path] = {
          ...(command.arguments === undefined
            ? {}
            : { arguments: argumentShape(command) }),
          ...(command.options === undefined ? {} : { options: optionShape(command) }),
        };
      }
    }
    expect(actual).toEqual(FROZEN_COMMAND_SHAPES);
  });

  test("snapshots root, every group, and every command help form", async () => {
    const rootForms = [
      await captureCli(["--help"]),
      await captureCli(["help"]),
    ];
    for (const captured of rootForms) {
      expect(captured.exitCode).toBe(0);
      expect(captured.stdout).toMatchSnapshot();
    }

    for (const group of GROUPS) {
      const groupForms = [
        await captureCli(["help", group.name]),
        await captureCli([group.name, "--help"]),
      ];
      for (const captured of groupForms) {
        expect(captured.exitCode).toBe(0);
        expect(captured.stdout).toMatchSnapshot();
      }

      for (const command of group.commands) {
        const path = [group.name, ...command.path];
        const commandForms = [
          await captureCli(["help", ...path]),
          await captureCli([...path, "--help"]),
        ];
        for (const captured of commandForms) {
          expect(captured.exitCode).toBe(0);
          expect(captured.stdout).toMatchSnapshot();
        }
        for (const alias of command.aliases ?? []) {
          const aliasForms = [
            await captureCli(["help", group.name, alias]),
            await captureCli([group.name, alias, "--help"]),
          ];
          for (const captured of aliasForms) {
            expect(captured.exitCode).toBe(0);
            expect(captured.stdout).toMatchSnapshot();
          }
        }
      }
    }
  });

  test("renders required, repeatable, enum, and default option semantics", async () => {
    const root = await captureCli(["--help"]);
    expect(root.stdout).toContain(
      "Override the Explodex home directory. (default: $HOME/.explodex)",
    );

    const refresh = await captureCli(["plugin", "refresh", "--help"]);
    expect(refresh.stdout).toContain(
      "Review target role; unavailable targets never force a renderer. (values: main|development; default: main)",
    );

    const install = await captureCli(["plugin", "install", "--help"]);
    expect(install.stdout).toContain(
      "Review target role; unavailable targets leave the install disabled and pending. (values: none|main|development; default: none)",
    );

  });

  test("help and version use the frozen precedence and longest valid prefix", async () => {
    const root = await captureCli(["--help", "unknown", "suffix"]);
    expect(root.exitCode).toBe(0);
    expect(root.stdout).toContain("Global options");

    const group = await captureCli(["plugin", "unknown", "suffix", "--help"]);
    expect(group.exitCode).toBe(0);
    expect(group.stdout).toContain("Commands");
    expect(group.stdout).toContain("plugin");

    const command = await captureCli([
      "plugin",
      "artifact",
      "validate",
      "later-invalid",
      "--help",
    ]);
    expect(command.exitCode).toBe(0);
    expect(command.stdout).toContain("explodex plugin artifact validate <path>");

    const version = await captureCli(["host", "not-a-command", "--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toMatch(/^explodex \S+\n$/);

    const helpWins = await captureCli([
      "host",
      "report",
      "later-invalid",
      "--version",
      "--help",
    ]);
    expect(helpWins.exitCode).toBe(0);
    expect(helpWins.stdout).toContain("explodex host report");
  });
});
