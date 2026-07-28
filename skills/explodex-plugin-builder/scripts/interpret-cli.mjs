#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const EVENT_TYPES = new Set([
  "watch-ready",
  "build-started",
  "build-succeeded",
  "build-failed",
  "apply-started",
  "apply-succeeded",
  "apply-failed",
  "target-lost",
  "blocked",
]);
const TERMINAL_REASONS = new Set([
  "completed",
  "interrupted",
  "blocked",
  "preflight-failed",
  "runtime-failed",
]);
const ONE_SHOT_BLOCKER_CODES = new Set([
  "operation.cancelled",
  "compatibility.unproven",
  "compatibility.probe-required",
  "compatibility.drifted",
  "main.authorization-required",
  "main.hot-path-unavailable",
  "main.lifecycle-protected",
  "cdp.target-lost",
  "auth.required",
  "plugin.review.required",
  "plugin.review.unavailable",
  "plugin.review.cancelled",
  "plugin.update.cancelled",
  "dev.ownership-uncertain",
  "dev.recovery-required",
  "release.authorization-required",
]);
const SEMANTIC_CODE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${label} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function exactKeys(value, required, optional, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) fail(`${label}.${key} is required.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not allowed.`);
  }
}

function validateError(value, label) {
  exactKeys(value, ["code", "message"], ["details"], label);
  if (!SEMANTIC_CODE.test(nonEmpty(value.code, `${label}.code`))) {
    fail(`${label}.code must be a stable semantic code.`);
  }
  nonEmpty(value.message, `${label}.message`);
}

function validateWarnings(value) {
  if (!Array.isArray(value)) fail("warnings must be an array.");
  value.forEach((warning, index) => {
    exactKeys(warning, ["code", "message"], [], `warnings[${index}]`);
    if (!SEMANTIC_CODE.test(nonEmpty(warning.code, `warnings[${index}].code`))) {
      fail(`warnings[${index}].code must be a stable semantic code.`);
    }
    nonEmpty(warning.message, `warnings[${index}].message`);
  });
}

function validatePluginIdentity(value, label, exact = true) {
  if (exact) exactKeys(value, ["id", "version", "payloadSha256"], [], label);
  else if (!isRecord(value)) fail(`${label} must be an object.`);
  const id = nonEmpty(value.id, `${label}.id`);
  const version = nonEmpty(value.version, `${label}.version`);
  const payloadSha256 = nonEmpty(
    value.payloadSha256,
    `${label}.payloadSha256`,
  );
  if (!SHA256.test(payloadSha256)) {
    fail(`${label}.payloadSha256 must be one lowercase 64-hex SHA-256.`);
  }
  return { id, version, payloadSha256 };
}

function validateSdkIdentity(value, label, exact = true) {
  if (exact) exactKeys(value, ["version", "sha256"], [], label);
  else if (!isRecord(value)) fail(`${label} must be an object.`);
  const version = nonEmpty(value.version, `${label}.version`);
  const sha256 = nonEmpty(value.sha256, `${label}.sha256`);
  if (!SHA256.test(sha256)) {
    fail(`${label}.sha256 must be one lowercase 64-hex SHA-256.`);
  }
  return { version, sha256 };
}

function validateTarget(value, label) {
  exactKeys(
    value,
    [
      "role",
      "pid",
      "processStartedAt",
      "executablePath",
      "appVersion",
      "appBuild",
      "port",
      "browserIdentity",
      "targetId",
      "targetType",
      "targetUrl",
      "executionContextId",
      "executionContextUniqueId",
      "frameId",
    ],
    [],
    label,
  );
  if (value.role !== "main" && value.role !== "development") {
    fail(`${label}.role must be main or development.`);
  }
  integer(value.pid, `${label}.pid`, 1);
  nonEmpty(value.processStartedAt, `${label}.processStartedAt`);
  nonEmpty(value.executablePath, `${label}.executablePath`);
  nonEmpty(value.appVersion, `${label}.appVersion`);
  nonEmpty(value.appBuild, `${label}.appBuild`);
  if (
    (value.role === "development" && value.port !== 9444) ||
    (value.role === "main" && value.port !== 9333)
  ) {
    fail(`${label}.port does not match its role.`);
  }
  nonEmpty(value.browserIdentity, `${label}.browserIdentity`);
  nonEmpty(value.targetId, `${label}.targetId`);
  if (value.targetType !== "page" || value.targetUrl !== "app://-/index.html") {
    fail(`${label} must identify the exact ChatGPT page target.`);
  }
  integer(value.executionContextId, `${label}.executionContextId`, 1);
  nonEmpty(value.executionContextUniqueId, `${label}.executionContextUniqueId`);
  nonEmpty(value.frameId, `${label}.frameId`);
  return value;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectIdentity(value, output, seen = new Set()) {
  if (!isRecord(value) && !Array.isArray(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectIdentity(entry, output, seen);
    return;
  }
  if (
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    typeof value.payloadSha256 === "string"
  ) {
    output.plugins.push(validatePluginIdentity(value, "identity.plugin", false));
  }
  if (
    typeof value.version === "string" &&
    typeof value.sha256 === "string" &&
    !("payloadSha256" in value)
  ) {
    output.sdkRuntimes.push(validateSdkIdentity(value, "identity.sdk", false));
  }
  if (
    (value.role === "main" || value.role === "development") &&
    "targetId" in value &&
    "executionContextUniqueId" in value &&
    "browserIdentity" in value
  ) {
    validateTarget(value, "identity.target");
    output.targets.push(value);
  }
  if (
    typeof value.pid === "number" &&
    typeof value.processStartedAt === "string"
  ) {
    integer(value.pid, "identity.process.pid", 1);
    nonEmpty(value.processStartedAt, "identity.process.processStartedAt");
    output.processes.push({
      pid: value.pid,
      processStartedAt: value.processStartedAt,
      ...("port" in value ? { port: value.port } : {}),
    });
  }
  for (const entry of Object.values(value)) collectIdentity(entry, output, seen);
}

function deduplicate(values) {
  const unique = new Map();
  for (const value of values) unique.set(JSON.stringify(value), value);
  return [...unique.values()];
}

function identitySummary(value) {
  const output = {
    plugins: [],
    sdkRuntimes: [],
    targets: [],
    processes: [],
  };
  collectIdentity(value, output);
  return {
    plugins: deduplicate(output.plugins),
    sdkRuntimes: deduplicate(output.sdkRuntimes),
    targets: deduplicate(output.targets),
    processes: deduplicate(output.processes),
  };
}

function validateRequiredOneShotIdentity(operation, envelope, identity) {
  if (!envelope.ok) return;
  const requiresPlugin = new Set([
    "plugin.build",
    "plugin.package",
    "plugin.artifact.validate",
    "dev.inject",
    "main.apply",
  ]);
  if (requiresPlugin.has(operation) && identity.plugins.length === 0) {
    fail(`${operation} success requires an exact plugin identity and payload checksum.`);
  }
  if (
    (operation === "dev.inject" || operation === "main.apply") &&
    identity.targets.length === 0
  ) {
    fail(`${operation} success requires an exact process/target/context identity.`);
  }
  if (
    (operation === "dev.start" ||
      operation === "dev.ensure" ||
      operation === "dev.restart") &&
    isRecord(envelope.result) &&
    envelope.result.status === "ready" &&
    identity.processes.length === 0
  ) {
    fail(`${operation} ready success requires an exact PID/start identity.`);
  }
}

function validateOneShot(text, expectedOperation) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    fail("One-shot stdout must contain exactly one complete JSON envelope.");
  }
  exactKeys(
    envelope,
    ["schemaVersion", "ok", "operation", "warnings"],
    ["result", "error"],
    "envelope",
  );
  if (envelope.schemaVersion !== 1) fail("envelope.schemaVersion must be 1.");
  if (typeof envelope.ok !== "boolean") fail("envelope.ok must be boolean.");
  if (nonEmpty(envelope.operation, "envelope.operation") !== expectedOperation) {
    fail(
      `Envelope operation mismatch: expected ${expectedOperation}, received ${envelope.operation}.`,
    );
  }
  validateWarnings(envelope.warnings);
  if (envelope.ok) {
    if (!("result" in envelope) || "error" in envelope) {
      fail("Successful envelopes require result and forbid error.");
    }
  } else {
    if (!("error" in envelope) || "result" in envelope) {
      fail("Failure envelopes require error and forbid result.");
    }
    validateError(envelope.error, "envelope.error");
  }
  const identity = identitySummary(envelope);
  validateRequiredOneShotIdentity(envelope.operation, envelope, identity);
  const blocker = !envelope.ok &&
    ONE_SHOT_BLOCKER_CODES.has(envelope.error.code);
  return {
    valid: true,
    protocol: "one-shot",
    operation: envelope.operation,
    ok: envelope.ok,
    blocker: !blocker
      ? null
      : {
          code: envelope.error.code,
          message: envelope.error.message,
          ...("details" in envelope.error
            ? { details: envelope.error.details }
            : {}),
        },
    identity,
    question: blocker ? blockerQuestion(envelope.error) : null,
  };
}

function validateEvent(record, index, operationId, sequence) {
  exactKeys(
    record,
    ["schemaVersion", "operationId", "sequence", "generation", "type"],
    ["pluginIdentity", "sdkRuntimeIdentity", "target", "details"],
    `records[${index}]`,
  );
  if (record.schemaVersion !== 1) fail(`records[${index}].schemaVersion must be 1.`);
  if (record.operationId !== operationId) fail("Develop operationId changed within the stream.");
  if (integer(record.sequence, `records[${index}].sequence`, 1) !== sequence) {
    fail(`Develop sequence must begin at 1 and increase by exactly one.`);
  }
  integer(record.generation, `records[${index}].generation`);
  if (!EVENT_TYPES.has(record.type)) fail(`records[${index}].type is not documented.`);
  if ("pluginIdentity" in record) {
    validatePluginIdentity(record.pluginIdentity, `records[${index}].pluginIdentity`);
  }
  if ("sdkRuntimeIdentity" in record) {
    validateSdkIdentity(record.sdkRuntimeIdentity, `records[${index}].sdkRuntimeIdentity`);
  }
  if ("target" in record) validateTarget(record.target, `records[${index}].target`);
  if (
    (record.type === "watch-ready" || record.type === "apply-started" ||
      record.type === "apply-succeeded") &&
    !("target" in record)
  ) {
    fail(`${record.type} requires an exact target identity.`);
  }
  if (
    (record.type === "build-succeeded" || record.type === "apply-started" ||
      record.type === "apply-succeeded") &&
    (!("pluginIdentity" in record) || !("sdkRuntimeIdentity" in record))
  ) {
    fail(`${record.type} requires plugin and SDK runtime identities.`);
  }
  if (record.type === "blocked" || record.type === "target-lost") {
    if (!isRecord(record.details) || !SEMANTIC_CODE.test(record.details.code ?? "")) {
      fail(`${record.type} requires details.code with a stable semantic code.`);
    }
  }
}

function validateLastGood(lastGood, lastApply) {
  if (lastGood === null) {
    if (lastApply !== null) fail("terminal.lastGood cannot be null after apply-succeeded.");
    return;
  }
  exactKeys(
    lastGood,
    [
      "generation",
      "pluginIdentity",
      "sdkRuntimeIdentity",
      "target",
      "appliedAt",
    ],
    [],
    "terminal.lastGood",
  );
  integer(lastGood.generation, "terminal.lastGood.generation", 1);
  validatePluginIdentity(lastGood.pluginIdentity, "terminal.lastGood.pluginIdentity");
  validateSdkIdentity(lastGood.sdkRuntimeIdentity, "terminal.lastGood.sdkRuntimeIdentity");
  validateTarget(lastGood.target, "terminal.lastGood.target");
  nonEmpty(lastGood.appliedAt, "terminal.lastGood.appliedAt");
  if (
    lastApply === null ||
    lastGood.generation !== lastApply.generation ||
    !same(lastGood.pluginIdentity, lastApply.pluginIdentity) ||
    !same(lastGood.sdkRuntimeIdentity, lastApply.sdkRuntimeIdentity) ||
    !same(lastGood.target, lastApply.target) ||
    lastGood.appliedAt !== lastApply.details?.appliedAt
  ) {
    fail("terminal.lastGood must exactly match the most recent apply-succeeded event.");
  }
}

function validateDevelop(text, expectedOperationId) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    fail("Develop stdout must be non-empty JSONL with no blank or prose lines.");
  }
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(`records[${index}] is not valid JSON.`);
    }
  });
  const terminal = records.at(-1);
  exactKeys(
    terminal,
    [
      "schemaVersion",
      "operationId",
      "type",
      "ok",
      "reason",
      "lastSequence",
      "lastGood",
    ],
    ["error"],
    "terminal",
  );
  if (terminal.schemaVersion !== 1 || terminal.type !== "terminal") {
    fail("The final record must be the schemaVersion-1 terminal record.");
  }
  const operationId = nonEmpty(terminal.operationId, "terminal.operationId");
  if (expectedOperationId !== null && operationId !== expectedOperationId) {
    fail(
      `Develop operationId mismatch: expected ${expectedOperationId}, received ${operationId}.`,
    );
  }
  if (typeof terminal.ok !== "boolean") fail("terminal.ok must be boolean.");
  if (!TERMINAL_REASONS.has(terminal.reason)) fail("terminal.reason is not documented.");
  if (terminal.ok !== (terminal.reason === "completed")) {
    fail("Only reason completed may have terminal.ok=true.");
  }
  if (terminal.ok && "error" in terminal) fail("Successful terminal forbids error.");
  if (!terminal.ok) {
    if (!("error" in terminal)) fail("Failed terminal requires error.");
    validateError(terminal.error, "terminal.error");
  }
  const events = records.slice(0, -1);
  let lastApply = null;
  let frozenTarget = null;
  let highestGeneration = 0;
  const generationBuilds = new Map();
  events.forEach((record, index) => {
    validateEvent(record, index, operationId, index + 1);
    if ("target" in record) {
      if (frozenTarget === null) frozenTarget = record.target;
      else if (!same(frozenTarget, record.target)) {
        fail("Develop target identity changed within the stream.");
      }
    }
    if (record.generation < highestGeneration) {
      fail("Develop generation identity moved backwards.");
    }
    highestGeneration = Math.max(highestGeneration, record.generation);
    if (record.type === "build-succeeded") {
      generationBuilds.set(record.generation, {
        pluginIdentity: record.pluginIdentity,
        sdkRuntimeIdentity: record.sdkRuntimeIdentity,
      });
    }
    if (record.type === "apply-started" || record.type === "apply-succeeded") {
      const built = generationBuilds.get(record.generation);
      if (
        built === undefined ||
        !same(built.pluginIdentity, record.pluginIdentity) ||
        !same(built.sdkRuntimeIdentity, record.sdkRuntimeIdentity)
      ) {
        fail(`${record.type} identity does not match its generation build.`);
      }
    }
    if (record.type === "apply-succeeded") lastApply = record;
    if (
      (record.type === "blocked" || record.type === "target-lost") &&
      index !== events.length - 1
    ) {
      fail("A blocked or target-lost event must be the final nonterminal record.");
    }
  });
  if (integer(terminal.lastSequence, "terminal.lastSequence") !== events.length) {
    fail("terminal.lastSequence must equal the final event sequence or 0.");
  }
  validateLastGood(terminal.lastGood, lastApply);
  if (
    terminal.lastGood !== null &&
    frozenTarget !== null &&
    !same(terminal.lastGood.target, frozenTarget)
  ) {
    fail("terminal.lastGood target must match the frozen stream target.");
  }
  if (terminal.reason === "blocked") {
    const finalEvent = events.at(-1);
    if (
      finalEvent === undefined ||
      (finalEvent.type !== "blocked" && finalEvent.type !== "target-lost")
    ) {
      fail("A blocked terminal requires one typed final blocker event.");
    }
    if (finalEvent.details.code !== terminal.error.code) {
      fail("Blocker event and terminal error codes must agree exactly.");
    }
  } else if (events.some((record) => record.type === "blocked")) {
    fail("A blocker event requires terminal reason blocked.");
  }
  return {
    valid: true,
    protocol: "develop",
    operation: "plugin.develop",
    operationId,
    ok: terminal.ok,
    eventCount: events.length,
    terminal,
    blocker: terminal.reason === "blocked" ? terminal.error : null,
    identity: identitySummary(records),
    question: terminal.reason === "blocked"
      ? blockerQuestion(terminal.error)
      : null,
  };
}

function findRecord(value, predicate, seen = new Set()) {
  if (!isRecord(value) && !Array.isArray(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (isRecord(value) && predicate(value)) return value;
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    const found = findRecord(entry, predicate, seen);
    if (found !== null) return found;
  }
  return null;
}

function validateAuthBlocker(auth) {
  exactKeys(
    auth,
    [
      "blocker",
      "authMode",
      "projectedAuthAdvertised",
      "role",
      "rootPath",
      "electronUserDataPath",
      "codexHomePath",
      "target",
      "requiredAction",
      "credentialHandling",
      "devRemainsRunning",
      "resume",
    ],
    [],
    "auth",
  );
  if (
    auth.blocker !== "authentication" ||
    auth.authMode !== "interactive" ||
    auth.projectedAuthAdvertised !== false ||
    auth.role !== "development" ||
    auth.devRemainsRunning !== true
  ) fail("auth blocker facts are invalid.");
  nonEmpty(auth.rootPath, "auth.rootPath");
  nonEmpty(auth.electronUserDataPath, "auth.electronUserDataPath");
  nonEmpty(auth.codexHomePath, "auth.codexHomePath");
  nonEmpty(auth.requiredAction, "auth.requiredAction");
  exactKeys(
    auth.target,
    [
      "role",
      "pid",
      "processStartedAt",
      "port",
      "targetId",
      "executionContextId",
      "executionContextUniqueId",
      "appVersion",
      "appBuild",
    ],
    [],
    "auth.target",
  );
  if (auth.target.role !== "development" || auth.target.port !== 9444) {
    fail("auth.target must be the exact development target on port 9444.");
  }
  integer(auth.target.pid, "auth.target.pid", 1);
  integer(auth.target.executionContextId, "auth.target.executionContextId", 1);
  for (const key of [
    "processStartedAt",
    "targetId",
    "executionContextUniqueId",
    "appVersion",
    "appBuild",
  ]) nonEmpty(auth.target[key], `auth.target.${key}`);
  exactKeys(
    auth.credentialHandling,
    ["cliEntryAllowed", "mainStateCopyAllowed", "automaticProjection"],
    [],
    "auth.credentialHandling",
  );
  if (
    auth.credentialHandling.cliEntryAllowed !== false ||
    auth.credentialHandling.mainStateCopyAllowed !== false ||
    auth.credentialHandling.automaticProjection !== false
  ) fail("auth credential handling facts are invalid.");
  exactKeys(
    auth.resume,
    [
      "firstOperation",
      "recoveryOperation",
      "continuationOperation",
      "requiresNewPublicOperation",
      "reusesBlockedOutput",
    ],
    [],
    "auth.resume",
  );
  if (
    auth.resume.firstOperation !== "dev.status" ||
    auth.resume.recoveryOperation !== "dev.recover" ||
    auth.resume.continuationOperation !== "plugin.develop" ||
    auth.resume.requiresNewPublicOperation !== true ||
    auth.resume.reusesBlockedOutput !== false
  ) fail("auth resume facts are invalid.");
  return auth;
}

function blockerQuestion(error) {
  const auth = findRecord(
    error.details,
    (value) =>
      value.blocker === "authentication" &&
      value.authMode === "interactive" &&
      value.role === "development",
  );
  if (error.code === "auth.required" && auth !== null) {
    validateAuthBlocker(auth);
    const target = isRecord(auth.target) ? auth.target : {};
    return {
      code: error.code,
      role: "development",
      target,
      requiredAction: auth.requiredAction,
      continuationOperation:
        auth.resume?.continuationOperation ?? "plugin.develop",
      verificationOperation: auth.resume?.firstOperation ?? "dev.status",
      devRemainsRunning: auth.devRemainsRunning === true,
      mainRemainsRunning: true,
      prompt:
        `Sign in manually in the exact isolated development ChatGPT target ` +
        `PID ${String(target.pid ?? "unknown")} on port 9444, then confirm completion. ` +
        `I will run a new public dev status and plugin develop operation before any mutation.`,
    };
  }
  if (error.code === "auth.required") {
    fail("auth.required requires exact validated interactive auth details.");
  }
  const exactTarget = findRecord(
    error.details,
    (value) =>
      (value.role === "main" || value.role === "development") &&
      "targetId" in value &&
      "executionContextUniqueId" in value &&
      "browserIdentity" in value,
  );
  if (exactTarget !== null) validateTarget(exactTarget, "blocker.target");
  const runningFacts = findRecord(
    error.details,
    (value) =>
      typeof value.devRemainsRunning === "boolean" ||
      typeof value.mainRemainsRunning === "boolean",
  );
  const role = exactTarget?.role ??
    (error.code.startsWith("main.") ? "main" : "development");
  const actions = {
    "cdp.target-lost":
      "Restore the exact development target or use the public development status/recover lifecycle.",
    "dev.ownership-uncertain":
      "Run the public development status operation and recover only if it reports eligibility.",
    "dev.recovery-required":
      "Run the public development recover operation for the recorded exact instance.",
    "main.hot-path-unavailable":
      "Provide a separately authorized debug-enabled main target or continue on development only.",
  };
  return {
    code: error.code,
    role,
    target: exactTarget,
    requiredAction:
      actions[error.code] ??
      "Complete the named manual action without changing unrelated targets.",
    continuationOperation: "plugin.develop",
    verificationOperation: "dev.status",
    devRemainsRunning:
      typeof runningFacts?.devRemainsRunning === "boolean"
        ? runningFacts.devRemainsRunning
        : null,
    mainRemainsRunning:
      typeof runningFacts?.mainRemainsRunning === "boolean"
        ? runningFacts.mainRemainsRunning
        : null,
    prompt:
      `${error.message} Complete the required action, then confirm. ` +
      `I will use a new public status, recover, or explicit operation before resuming.`,
  };
}

function parseArgs(argv) {
  let protocol = null;
  let operation = null;
  let operationId = null;
  let input = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--protocol" && next !== undefined) {
      protocol = next;
      index += 1;
    } else if (token === "--operation" && next !== undefined) {
      operation = next;
      index += 1;
    } else if (token === "--operation-id" && next !== undefined) {
      operationId = next;
      index += 1;
    } else if (token === "--input" && next !== undefined) {
      input = next;
      index += 1;
    } else {
      fail(`Unknown or incomplete option: ${token}`);
    }
  }
  if (protocol !== "one-shot" && protocol !== "develop") {
    fail("--protocol must be one-shot or develop.");
  }
  if (protocol === "one-shot" && operation === null) {
    fail("--operation is required for one-shot validation.");
  }
  return { protocol, operation, operationId, input };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const options = parseArgs(process.argv.slice(2));
  const text = options.input === null
    ? await readStdin()
    : await readFile(options.input, "utf8");
  const trimmed = text.trim();
  if (trimmed.length === 0) fail("Machine output is empty.");
  const result = options.protocol === "one-shot"
    ? validateOneShot(trimmed, options.operation)
    : validateDevelop(text, options.operationId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `skill.protocol-mismatch: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
