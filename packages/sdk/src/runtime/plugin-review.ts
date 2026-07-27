export const REVIEW_SECURITY_WARNING =
  "Enabled plugins are trusted unsandboxed renderer code that can read or modify UI and authenticated renderer state. Confirmation and checksums do not provide sandboxing or publisher authentication.";

export type ReviewArtifact = {
  id: string;
  displayName: string;
  description: string;
  version: string;
  payloadSha256: string;
  sdkRange: string;
  sourceLabel: string;
};

export type PluginReviewRequest = {
  schemaVersion: 1;
  operationId: string;
  nonce: string;
  callbackName: string;
  expiresAtMs: number;
  warning?: string;
  artifacts: ReviewArtifact[];
};

export type ReviewSelectionTuple = {
  id: string;
  version: string;
  payloadSha256: string;
};

export type ReviewSubmission = {
  schemaVersion: 1;
  nonce: string;
  selected: ReviewSelectionTuple[];
};

export type ReviewOutcome =
  | { status: "submitted"; payload: ReviewSubmission }
  | { status: "cancelled"; reason: string }
  | { status: "expired"; reason: string }
  | { status: "rejected"; reason: string };

export type ReviewRenderArtifact = ReviewArtifact & {
  selected: boolean;
};

export type ReviewRenderModel = {
  operationId: string;
  warning: string;
  artifacts: ReviewRenderArtifact[];
  onToggle(
    id: string,
    version: string,
    payloadSha256: string,
    selected: boolean,
  ): void;
  onSubmit(): void;
  onCancel(): void;
  onFocus(): void;
  onNavigate(): void;
};

export type ReviewRenderHandle = {
  close(reason: string): void;
};

export type PluginReviewHost = {
  callbacks: Record<string, unknown>;
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type PluginReviewController = {
  open(request: PluginReviewRequest): Promise<ReviewOutcome>;
  cancel(reason?: string): void;
  destroy(): void;
};

type ActiveReview = {
  request: PluginReviewRequest;
  selected: Set<string>;
  timer: unknown;
  handle: ReviewRenderHandle;
  settle(outcome: ReviewOutcome): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function tupleKey(value: ReviewSelectionTuple): string {
  return `${value.id}\0${value.version}\0${value.payloadSha256}`;
}

function parseArtifact(value: unknown): ReviewArtifact | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "id",
      "displayName",
      "description",
      "version",
      "payloadSha256",
      "sdkRange",
      "sourceLabel",
    ]) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.displayName !== "string" ||
    value.displayName.length === 0 ||
    typeof value.description !== "string" ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    typeof value.payloadSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.payloadSha256) ||
    typeof value.sdkRange !== "string" ||
    value.sdkRange.length === 0 ||
    typeof value.sourceLabel !== "string" ||
    value.sourceLabel.length === 0
  ) {
    return null;
  }
  return {
    id: value.id,
    displayName: value.displayName,
    description: value.description,
    version: value.version,
    payloadSha256: value.payloadSha256,
    sdkRange: value.sdkRange,
    sourceLabel: value.sourceLabel,
  };
}

function parseRequest(value: unknown): PluginReviewRequest | null {
  const keysWithoutWarning = [
    "schemaVersion",
    "operationId",
    "nonce",
    "callbackName",
    "expiresAtMs",
    "artifacts",
  ] as const;
  if (
    !isRecord(value) ||
    (!exactKeys(value, keysWithoutWarning) &&
      !exactKeys(value, [...keysWithoutWarning, "warning"])) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    value.operationId.length === 0 ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0 ||
    typeof value.callbackName !== "string" ||
    !/^__explodexReview_[A-Za-z0-9_]+$/.test(value.callbackName) ||
    typeof value.expiresAtMs !== "number" ||
    !Number.isFinite(value.expiresAtMs) ||
    (value.warning !== undefined && value.warning !== REVIEW_SECURITY_WARNING) ||
    !Array.isArray(value.artifacts)
  ) {
    return null;
  }
  const artifacts: ReviewArtifact[] = [];
  const tuples = new Set<string>();
  for (const candidate of value.artifacts) {
    const artifact = parseArtifact(candidate);
    if (artifact === null) return null;
    const key = tupleKey(artifact);
    if (tuples.has(key)) continue;
    tuples.add(key);
    artifacts.push(artifact);
  }
  return {
    schemaVersion: 1,
    operationId: value.operationId,
    nonce: value.nonce,
    callbackName: value.callbackName,
    expiresAtMs: value.expiresAtMs,
    warning: REVIEW_SECURITY_WARNING,
    artifacts,
  };
}

function submission(
  request: PluginReviewRequest,
  selected: Set<string>,
): ReviewSubmission {
  return {
    schemaVersion: 1,
    nonce: request.nonce,
    selected: request.artifacts.flatMap((artifact) =>
      selected.has(tupleKey(artifact))
        ? [{
            id: artifact.id,
            version: artifact.version,
            payloadSha256: artifact.payloadSha256,
          }]
        : []
    ),
  };
}

export function createPluginReviewController(options: {
  host: PluginReviewHost;
  render(model: ReviewRenderModel): ReviewRenderHandle;
}): PluginReviewController {
  let active: ActiveReview | null = null;
  let destroyed = false;

  const finish = (outcome: ReviewOutcome, reason: string): void => {
    const current = active;
    if (current === null) return;
    active = null;
    options.host.clearTimeout(current.timer);
    delete options.host.callbacks[current.request.callbackName];
    current.handle.close(reason);
    current.settle(outcome);
  };

  return {
    open(value) {
      if (destroyed) {
        return Promise.resolve({
          status: "rejected",
          reason: "runtime-destroyed",
        });
      }
      if (active !== null) {
        return Promise.resolve({
          status: "rejected",
          reason: "review-already-active",
        });
      }
      const request = parseRequest(value);
      if (request === null) {
        return Promise.resolve({
          status: "rejected",
          reason: "invalid-review-request",
        });
      }
      if (options.host.now() >= request.expiresAtMs) {
        return Promise.resolve({
          status: "expired",
          reason: "expired-before-render",
        });
      }
      if (Object.prototype.hasOwnProperty.call(
        options.host.callbacks,
        request.callbackName,
      )) {
        return Promise.resolve({
          status: "rejected",
          reason: "callback-name-collision",
        });
      }
      return new Promise<ReviewOutcome>((resolve) => {
        const selected = new Set<string>();
        let settled = false;
        const settle = (outcome: ReviewOutcome): void => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        const model: ReviewRenderModel = {
          operationId: request.operationId,
          warning: REVIEW_SECURITY_WARNING,
          artifacts: request.artifacts.map((artifact) => ({
            ...artifact,
            selected: false,
          })),
          onToggle(id, version, payloadSha256, isSelected) {
            const key = tupleKey({ id, version, payloadSha256 });
            if (!request.artifacts.some((artifact) => tupleKey(artifact) === key)) {
              return;
            }
            if (isSelected) selected.add(key);
            else selected.delete(key);
          },
          onSubmit() {
            const callback = options.host.callbacks[request.callbackName];
            if (typeof callback === "function") {
              callback(submission(request, selected));
            }
          },
          onCancel() {
            finish({
              status: "cancelled",
              reason: "cancelled",
            }, "cancelled");
          },
          // Focus and in-renderer navigation are intentionally passive.
          onFocus() {},
          onNavigate() {},
        };
        const handle = options.render(model);
        options.host.callbacks[request.callbackName] = (payload: unknown) => {
          finish({
            status: "submitted",
            payload: payload as ReviewSubmission,
          }, "submitted");
        };
        const delayMs = Math.max(1, request.expiresAtMs - options.host.now());
        const timer = options.host.setTimeout(() => {
          finish({
            status: "expired",
            reason: "expired",
          }, "expired");
        }, delayMs);
        active = {
          request,
          selected,
          timer,
          handle,
          settle,
        };
      });
    },
    cancel(reason = "cancelled") {
      finish({ status: "cancelled", reason }, reason);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      finish({
        status: "cancelled",
        reason: "runtime-destroyed",
      }, "runtime-destroyed");
    },
  };
}

function button(document: Document, label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.style.border = "1px solid rgba(255,255,255,.18)";
  element.style.borderRadius = "8px";
  element.style.padding = "8px 12px";
  element.style.background = "rgba(255,255,255,.08)";
  element.style.color = "inherit";
  element.style.cursor = "pointer";
  return element;
}

export function formatReviewIdentityText(
  artifact: ReviewArtifact,
): string {
  return [
    artifact.id,
    artifact.version,
    artifact.payloadSha256,
    artifact.sdkRange,
    artifact.sourceLabel,
  ].join(" · ");
}

export function renderPluginReviewDom(
  document: Document,
  model: ReviewRenderModel,
): ReviewRenderHandle {
  const overlay = document.createElement("div");
  overlay.dataset.explodexPluginReview = model.operationId;
  overlay.setAttribute("role", "presentation");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "2147483647";
  overlay.style.display = "grid";
  overlay.style.placeItems = "center";
  overlay.style.padding = "24px";
  overlay.style.background = "rgba(0,0,0,.56)";

  const dialog = document.createElement("section");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `explodex-review-title-${model.operationId}`);
  dialog.style.width = "min(620px, 100%)";
  dialog.style.maxHeight = "min(760px, calc(100vh - 48px))";
  dialog.style.overflow = "auto";
  dialog.style.padding = "22px";
  dialog.style.border = "1px solid rgba(255,255,255,.14)";
  dialog.style.borderRadius = "14px";
  dialog.style.background = "rgb(30,30,32)";
  dialog.style.color = "rgb(245,245,245)";
  dialog.style.boxShadow = "0 24px 80px rgba(0,0,0,.48)";

  const title = document.createElement("h2");
  title.id = `explodex-review-title-${model.operationId}`;
  title.textContent = "New plugins detected";
  title.style.margin = "0 0 10px";
  title.style.fontSize = "20px";
  dialog.append(title);

  const warning = document.createElement("p");
  warning.dataset.explodexReviewWarning = "true";
  warning.textContent = model.warning;
  warning.style.margin = "0 0 18px";
  warning.style.padding = "12px";
  warning.style.borderRadius = "10px";
  warning.style.background = "rgba(255,186,73,.12)";
  warning.style.color = "rgb(255,222,170)";
  dialog.append(warning);

  const list = document.createElement("div");
  list.style.display = "grid";
  list.style.gap = "10px";
  for (const artifact of model.artifacts) {
    const row = document.createElement("label");
    row.dataset.explodexReviewIdentity =
      `${artifact.id}\0${artifact.version}\0${artifact.payloadSha256}`;
    row.style.display = "grid";
    row.style.gridTemplateColumns = "auto 1fr";
    row.style.gap = "10px";
    row.style.alignItems = "start";
    row.style.padding = "12px";
    row.style.border = "1px solid rgba(255,255,255,.12)";
    row.style.borderRadius = "10px";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = false;
    input.dataset.explodexReviewControl = "true";
    input.addEventListener("change", () => {
      model.onToggle(
        artifact.id,
        artifact.version,
        artifact.payloadSha256,
        input.checked,
      );
    });

    const details = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = artifact.displayName;
    const description = document.createElement("span");
    description.textContent = artifact.description;
    description.style.display = "block";
    description.style.marginTop = "3px";
    const identity = document.createElement("small");
    identity.textContent = formatReviewIdentityText(artifact);
    identity.style.display = "block";
    identity.style.marginTop = "6px";
    identity.style.opacity = ".72";
    details.append(name, description, identity);
    row.append(input, details);
    list.append(row);
  }
  dialog.append(list);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "8px";
  actions.style.marginTop = "18px";
  const cancel = button(document, "Cancel");
  cancel.dataset.explodexReviewCancel = "true";
  cancel.addEventListener("click", model.onCancel);
  const submit = button(document, "Enable Selected");
  submit.dataset.explodexReviewSubmit = "true";
  submit.addEventListener("click", model.onSubmit);
  actions.append(cancel, submit);
  dialog.append(actions);
  overlay.append(dialog);
  document.body.append(overlay);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") model.onCancel();
  };
  document.addEventListener("keydown", onKeyDown);
  cancel.focus();

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
    },
  };
}
