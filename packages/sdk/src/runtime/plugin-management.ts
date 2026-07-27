export type PluginManagementIdentity = {
  version: string;
  payloadSha256: string;
};

export type PluginManagementApplication = {
  status:
    | "unknown"
    | "not-applicable"
    | "applied"
    | "apply-pending"
    | "boundary-required"
    | "blocked"
    | "failed"
    | "not-attempted";
  lifecycle: "dynamic" | "renderer-start" | "app-start" | null;
  boundary: "none" | "renderer" | "app";
  observedIdentity: PluginManagementIdentity | null;
  message: string;
};

export type PluginManagementRecord = {
  id: string;
  displayName: string;
  description: string;
  installed: PluginManagementIdentity[];
  enabled: PluginManagementIdentity | null;
  pendingReview: PluginManagementIdentity[];
  application: PluginManagementApplication;
};

export type PluginManagementRequest = {
  schemaVersion: 1;
  target: "main" | "development";
  plugins: PluginManagementRecord[];
};

export type PluginManagementControl = {
  action: "enable" | "review" | "refresh" | "update" | "disable" | "remove";
  command: string;
  handoff: "exact-public-command";
  authorityMutation: "none";
  successClaim: "none";
};

export type PluginManagementModel = {
  ok: true;
  hasResidentListener: false;
  guidance:
    "Run the exact bounded command shown for each action. This page has no resident Explodex listener and never reports success by itself.";
  plugins: Array<{
    id: string;
    displayName: string;
    description: string;
    installed: PluginManagementIdentity[];
    pendingReview: PluginManagementIdentity[];
    persistedIntent:
      | { status: "disabled"; identity: null }
      | { status: "enabled"; identity: PluginManagementIdentity };
    application: PluginManagementApplication;
    controls: PluginManagementControl[];
  }>;
};

export type PluginManagementFailure = {
  ok: false;
  message: string;
};

export type PluginManagementRenderHandle = {
  close(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function parseIdentity(value: unknown): PluginManagementIdentity | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["version", "payloadSha256"]) ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    value.version.trim() !== value.version ||
    /[\u0000-\u001f\u007f/\\]/u.test(value.version) ||
    typeof value.payloadSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.payloadSha256)
  ) {
    return null;
  }
  return {
    version: value.version,
    payloadSha256: value.payloadSha256,
  };
}

function parseApplication(value: unknown): PluginManagementApplication | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "status",
      "lifecycle",
      "boundary",
      "observedIdentity",
      "message",
    ]) ||
    (value.status !== "unknown" &&
      value.status !== "not-applicable" &&
      value.status !== "applied" &&
      value.status !== "apply-pending" &&
      value.status !== "boundary-required" &&
      value.status !== "blocked" &&
      value.status !== "failed" &&
      value.status !== "not-attempted") ||
    (value.lifecycle !== null &&
      value.lifecycle !== "dynamic" &&
      value.lifecycle !== "renderer-start" &&
      value.lifecycle !== "app-start") ||
    (value.boundary !== "none" &&
      value.boundary !== "renderer" &&
      value.boundary !== "app") ||
    typeof value.message !== "string"
  ) {
    return null;
  }
  const observedIdentity = value.observedIdentity === null
    ? null
    : parseIdentity(value.observedIdentity);
  if (value.observedIdentity !== null && observedIdentity === null) return null;
  if (
    (value.status === "unknown" && observedIdentity !== null) ||
    (value.status === "boundary-required" && value.boundary === "none") ||
    (value.lifecycle === "dynamic" && value.boundary !== "none")
  ) {
    return null;
  }
  return {
    status: value.status,
    lifecycle: value.lifecycle,
    boundary: value.boundary,
    observedIdentity,
    message: value.message,
  };
}

function parseIdentityList(value: unknown): PluginManagementIdentity[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: PluginManagementIdentity[] = [];
  const keys = new Set<string>();
  for (const candidate of value) {
    const identity = parseIdentity(candidate);
    if (identity === null) return null;
    const key = identityKey(identity);
    if (keys.has(key)) return null;
    keys.add(key);
    parsed.push(identity);
  }
  return parsed;
}

function parseRecord(value: unknown): PluginManagementRecord | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "id",
      "displayName",
      "description",
      "installed",
      "enabled",
      "pendingReview",
      "application",
    ]) ||
    typeof value.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) ||
    typeof value.displayName !== "string" ||
    value.displayName.length === 0 ||
    typeof value.description !== "string"
  ) {
    return null;
  }
  const installed = parseIdentityList(value.installed);
  const pendingReview = parseIdentityList(value.pendingReview);
  const enabled = value.enabled === null ? null : parseIdentity(value.enabled);
  const application = parseApplication(value.application);
  if (
    installed === null ||
    pendingReview === null ||
    (value.enabled !== null && enabled === null) ||
    application === null
  ) {
    return null;
  }
  const installedKeys = new Set(installed.map(identityKey));
  if (
    (enabled !== null && !installedKeys.has(identityKey(enabled))) ||
    pendingReview.some((identity) => !installedKeys.has(identityKey(identity)))
  ) {
    return null;
  }
  return {
    id: value.id,
    displayName: value.displayName,
    description: value.description,
    installed,
    enabled,
    pendingReview,
    application,
  };
}

function identityKey(value: PluginManagementIdentity): string {
  return `${value.version}\0${value.payloadSha256}`;
}

function shellArgument(value: string): string {
  if (/^[a-zA-Z0-9._:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function identityCommand(
  prefix: string,
  id: string,
  identity: PluginManagementIdentity,
  target: PluginManagementRequest["target"],
): string {
  return [
    prefix,
    shellArgument(id),
    "--artifact-version",
    shellArgument(identity.version),
    "--payload-sha256",
    identity.payloadSha256,
    "--target",
    target,
  ].join(" ");
}

function control(
  action: PluginManagementControl["action"],
  command: string,
): PluginManagementControl {
  return {
    action,
    command,
    handoff: "exact-public-command",
    authorityMutation: "none",
    successClaim: "none",
  };
}

export function buildPluginManagementModel(
  value: unknown,
): PluginManagementModel | PluginManagementFailure {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "target", "plugins"]) ||
    value.schemaVersion !== 1 ||
    (value.target !== "main" && value.target !== "development") ||
    !Array.isArray(value.plugins)
  ) {
    return {
      ok: false,
      message: "Plugin management metadata was malformed.",
    };
  }
  const target = value.target;
  const records: PluginManagementRecord[] = [];
  const ids = new Set<string>();
  for (const candidate of value.plugins) {
    const parsed = parseRecord(candidate);
    if (parsed === null || ids.has(parsed.id)) {
      return {
        ok: false,
        message: "Plugin management metadata was malformed.",
      };
    }
    ids.add(parsed.id);
    records.push(parsed);
  }
  return {
    ok: true,
    hasResidentListener: false,
    guidance:
      "Run the exact bounded command shown for each action. This page has no resident Explodex listener and never reports success by itself.",
    plugins: records.map((record) => {
      const pendingOrFirst =
        record.pendingReview[0] ?? record.installed[0] ?? null;
      const enabledOrFirst = record.enabled ?? record.installed[0] ?? null;
      const controls: PluginManagementControl[] = [];
      if (pendingOrFirst !== null) {
        controls.push(control(
          "enable",
          identityCommand(
            "explodex plugin review",
            record.id,
            pendingOrFirst,
            target,
          ),
        ));
      }
      if (pendingOrFirst !== null) {
        controls.push(control(
          "review",
          identityCommand(
            "explodex plugin review",
            record.id,
            pendingOrFirst,
            target,
          ),
        ));
      }
      controls.push(
        control(
          "refresh",
          `explodex plugin refresh --target ${target}`,
        ),
        control("update", "explodex plugin update check"),
        control(
          "disable",
          `explodex plugin disable ${shellArgument(record.id)} --target ${target}`,
        ),
      );
      if (enabledOrFirst !== null) {
        controls.push(control(
          "remove",
          identityCommand(
            "explodex plugin remove",
            record.id,
            enabledOrFirst,
            target,
          ),
        ));
      }
      return {
        id: record.id,
        displayName: record.displayName,
        description: record.description,
        installed: record.installed.map((identity) => ({ ...identity })),
        pendingReview: record.pendingReview.map((identity) => ({
          ...identity,
        })),
        persistedIntent: record.enabled === null
          ? { status: "disabled" as const, identity: null }
          : {
              status: "enabled" as const,
              identity: { ...record.enabled },
            },
        application: {
          ...record.application,
          observedIdentity: record.application.observedIdentity === null
            ? null
            : { ...record.application.observedIdentity },
        },
        controls,
      };
    }),
  };
}

function managementButton(
  document: Document,
  control: PluginManagementControl,
  command: HTMLElement,
  status: HTMLElement,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = control.action;
  button.dataset.explodexManagementAction = control.action;
  button.style.border = "1px solid rgba(255,255,255,.18)";
  button.style.borderRadius = "8px";
  button.style.padding = "7px 10px";
  button.style.background = "rgba(255,255,255,.08)";
  button.style.color = "inherit";
  button.addEventListener("click", () => {
    command.textContent = control.command;
    status.textContent =
      "Run the exact command shown. This page has not sent a request or changed plugin authority.";
  });
  return button;
}

export function renderPluginManagementDom(
  document: Document,
  model: PluginManagementModel,
): PluginManagementRenderHandle {
  document.querySelector("[data-explodex-plugin-management]")?.remove();
  const root = document.createElement("section");
  root.dataset.explodexPluginManagement = "true";
  root.style.padding = "20px";
  root.style.color = "inherit";

  const title = document.createElement("h2");
  title.textContent = "Explodex plugins";
  title.style.margin = "0 0 8px";
  root.append(title);

  const guidance = document.createElement("p");
  guidance.dataset.explodexManagementGuidance = "true";
  guidance.textContent = model.guidance;
  root.append(guidance);

  const command = document.createElement("code");
  command.dataset.explodexManagementCommand = "true";
  command.textContent = "Select an action to show its exact bounded command.";
  command.style.display = "block";
  command.style.padding = "10px";
  command.style.borderRadius = "8px";
  command.style.background = "rgba(255,255,255,.08)";
  root.append(command);

  const status = document.createElement("p");
  status.dataset.explodexManagementStatus = "idle";
  status.textContent =
    "Idle. No Explodex operation is listening, and no mutation success is claimed.";
  root.append(status);

  for (const plugin of model.plugins) {
    const card = document.createElement("article");
    card.dataset.explodexManagementPlugin = plugin.id;
    card.style.marginTop = "14px";
    card.style.padding = "14px";
    card.style.border = "1px solid rgba(255,255,255,.12)";
    card.style.borderRadius = "10px";

    const heading = document.createElement("h3");
    heading.textContent = plugin.displayName;
    heading.style.margin = "0";
    card.append(heading);

    const description = document.createElement("p");
    description.textContent = plugin.description;
    card.append(description);

    const intent = document.createElement("p");
    intent.dataset.explodexManagementIntent = plugin.persistedIntent.status;
    intent.textContent = plugin.persistedIntent.status === "enabled"
      ? `Persisted intent: enabled ${plugin.persistedIntent.identity.version} ${plugin.persistedIntent.identity.payloadSha256}`
      : "Persisted intent: disabled";
    card.append(intent);

    const application = document.createElement("p");
    application.dataset.explodexManagementApplication =
      plugin.application.status;
    application.textContent =
      `Last observed application: ${plugin.application.status}. ${plugin.application.message}`;
    card.append(application);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "8px";
    for (const control of plugin.controls) {
      actions.append(
        managementButton(document, control, command, status),
      );
    }
    card.append(actions);
    root.append(card);
  }

  document.body.append(root);
  return {
    close() {
      root.remove();
    },
  };
}
