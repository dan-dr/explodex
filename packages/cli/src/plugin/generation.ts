/**
 * Build generation binding: package rejects stale source or edited dist.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  compareBytewise,
  GENERATION_FILE,
  listInstallableFiles,
  sha256Hex,
} from "./dist-files.ts";
import type { ChecksumsManifest } from "./checksums.ts";
import {
  computePayloadSha256,
  readChecksums,
  verifyDistAgainstChecksums,
} from "./checksums.ts";
import { resolveSdkRuntimeIdentityForCli } from "../host/sdk-runtime-identity.ts";
import type { NormalizedSourceReport } from "./types.ts";
import { validatePluginSource } from "./validate.ts";

export type GenerationRecord = {
  schemaVersion: 1;
  generationId: string;
  pluginId: string;
  version: string;
  mapMode: "required";
  sdkInput?: {
    kind: "publishable" | "local-source";
    version: string;
    runtimeSha256: string;
    declarationsSha256?: string;
  };
  /** Sorted input path → sha256 of tracked source/config bytes. */
  inputDigests: Record<string, string>;
  /** Sorted installable path → sha256 (mirrors checksums, excludes private generation file). */
  outputDigests: Record<string, string>;
  payloadSha256: string;
};

export type GenerationVerifySuccess = {
  ok: true;
  generation: GenerationRecord;
  payloadSha256: string;
};

export type GenerationVerifyFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type GenerationVerifyResult = GenerationVerifySuccess | GenerationVerifyFailure;

function validSdkInput(
  value: GenerationRecord["sdkInput"],
): value is NonNullable<GenerationRecord["sdkInput"]> {
  return value !== undefined &&
    (value.kind === "publishable" || value.kind === "local-source") &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
    /^[a-f0-9]{64}$/u.test(value.runtimeSha256) &&
    (
      value.declarationsSha256 === undefined ||
      /^[a-f0-9]{64}$/u.test(value.declarationsSha256)
    ) &&
    (
      value.kind !== "local-source" ||
      value.declarationsSha256 !== undefined
    );
}

async function digestFile(absolute: string): Promise<string> {
  const bytes = await readFile(absolute);
  return sha256Hex(bytes);
}

/**
 * Collect deterministic digests for every source input that may change the
 * installable payload. Package-relative paths use posix separators.
 */
export async function collectInputDigests(options: {
  workspacePath: string;
  report: NormalizedSourceReport;
  sdkInput?: GenerationRecord["sdkInput"];
}): Promise<Record<string, string>> {
  const workspacePath = resolve(options.workspacePath);
  const digests: Record<string, string> = {};

  const fixed = [
    "package.json",
    "explodex.config.ts",
    "tsconfig.json",
    options.report.entry,
  ] as const;

  for (const relative of fixed) {
    digests[relative] = await digestFile(join(workspacePath, relative));
  }

  // All declared assets (relative to workspace root as assets/<declared>).
  for (const asset of options.report.assets) {
    const installable = asset.startsWith("assets/") ? asset : `assets/${asset}`;
    // report.assets is declared form relative to assets root.
    const declared = asset.startsWith("assets/") ? asset.slice("assets/".length) : asset;
    digests[`assets/${declared}`] = await digestFile(join(workspacePath, "assets", declared));
    void installable;
  }

  // Include a stable serialization of normalized report fields that affect output.
  const authority = {
    id: options.report.id,
    version: options.report.version,
    displayName: options.report.displayName,
    description: options.report.description,
    lifecycle: options.report.lifecycle,
    sdkRange: options.report.sdkRange,
    entry: options.report.entry,
    assets: [...options.report.assets].sort(compareBytewise),
    mapMode: "required",
  };
  digests["__explodex__/authority.json"] = sha256Hex(`${JSON.stringify(authority)}\n`);
  if (options.sdkInput !== undefined) {
    digests["__explodex__/sdk-input.json"] = sha256Hex(
      `${JSON.stringify(options.sdkInput)}\n`,
    );
  }

  const ordered: Record<string, string> = {};
  for (const key of Object.keys(digests).sort(compareBytewise)) {
    ordered[key] = digests[key]!;
  }
  return ordered;
}

export function computeGenerationId(inputDigests: Record<string, string>): string {
  const parts: string[] = ["explodex-generation-v1"];
  for (const key of Object.keys(inputDigests).sort(compareBytewise)) {
    parts.push(`${key}=${inputDigests[key]}`);
  }
  return sha256Hex(parts.join("\n") + "\n");
}

export function buildGenerationRecord(options: {
  report: NormalizedSourceReport;
  inputDigests: Record<string, string>;
  checksums: ChecksumsManifest;
  sdkInput?: GenerationRecord["sdkInput"];
  /** Optional actual staged digests (preferred; includes checksums.json bytes). */
  outputDigests?: Record<string, string>;
}): GenerationRecord {
  const outputDigests: Record<string, string> = { ...(options.outputDigests ?? {}) };
  if (Object.keys(outputDigests).length === 0) {
    for (const path of Object.keys(options.checksums.files).sort(compareBytewise)) {
      outputDigests[path] = options.checksums.files[path]!.sha256;
    }
  }
  const orderedOutputs: Record<string, string> = {};
  for (const key of Object.keys(outputDigests).sort(compareBytewise)) {
    orderedOutputs[key] = outputDigests[key]!;
  }

  const generationId = computeGenerationId(options.inputDigests);
  return {
    schemaVersion: 1,
    generationId,
    pluginId: options.report.id,
    version: options.report.version,
    mapMode: "required",
    ...(options.sdkInput === undefined ? {} : { sdkInput: options.sdkInput }),
    inputDigests: options.inputDigests,
    outputDigests: orderedOutputs,
    payloadSha256: computePayloadSha256(options.checksums),
  };
}

export async function writeGenerationRecord(
  stagingDir: string,
  record: GenerationRecord,
): Promise<void> {
  // Stable serialization for fingerprinting, not part of payloadSha256.
  const ordered = {
    schemaVersion: 1,
    generationId: record.generationId,
    pluginId: record.pluginId,
    version: record.version,
    mapMode: record.mapMode,
    ...(record.sdkInput === undefined ? {} : { sdkInput: record.sdkInput }),
    inputDigests: Object.fromEntries(
      Object.keys(record.inputDigests)
        .sort(compareBytewise)
        .map((key) => [key, record.inputDigests[key]]),
    ),
    outputDigests: Object.fromEntries(
      Object.keys(record.outputDigests)
        .sort(compareBytewise)
        .map((key) => [key, record.outputDigests[key]]),
    ),
    payloadSha256: record.payloadSha256,
  };
  await writeFile(join(stagingDir, GENERATION_FILE), `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

export async function readGenerationRecord(
  distPath: string,
): Promise<GenerationRecord | null> {
  try {
    const raw = JSON.parse(await readFile(join(distPath, GENERATION_FILE), "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as GenerationRecord;
    if (value.schemaVersion !== 1) return null;
    if (typeof value.generationId !== "string") return null;
    if (typeof value.payloadSha256 !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Verify dist/ is the complete successful generation for current source inputs
 * and that installable outputs have not been edited.
 */
export async function verifyDistGeneration(options: {
  workspacePath: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<GenerationVerifyResult> {
  const workspacePath = resolve(options.workspacePath);
  const distPath = join(workspacePath, "dist");

  const generation = await readGenerationRecord(distPath);
  if (generation === null) {
    return {
      ok: false,
      code: "plugin.package.stale",
      message: "dist/ is missing a build generation record; rebuild before packaging.",
    };
  }
  if (!validSdkInput(generation.sdkInput)) {
    return {
      ok: false,
      code: "plugin.package.stale",
      message:
        "dist/ build generation is missing a valid SDK input identity; rebuild before packaging.",
    };
  }
  if (generation.sdkInput.kind === "publishable") {
    const currentSdkRuntime = await resolveSdkRuntimeIdentityForCli();
    if (
      generation.sdkInput.version !== currentSdkRuntime.version ||
      generation.sdkInput.runtimeSha256 !== currentSdkRuntime.sha256
    ) {
      return {
        ok: false,
        code: "plugin.package.stale",
        message:
          "dist/ was not built against the exact current publishable SDK runtime; rebuild before packaging.",
      };
    }
  }

  let checksums: ChecksumsManifest;
  try {
    checksums = await readChecksums(distPath);
  } catch (error: unknown) {
    return {
      ok: false,
      code: "plugin.package.stale",
      message:
        error instanceof Error
          ? `dist/checksums.json is unreadable: ${error.message}`
          : "dist/checksums.json is unreadable",
    };
  }

  const verified = await verifyDistAgainstChecksums(distPath, checksums);
  if (!verified.ok) {
    return {
      ok: false,
      code: "plugin.package.stale",
      message: `Generated dist was edited after build: ${verified.message}`,
      details: { path: verified.path },
    };
  }

  // Also ensure generation outputDigests agree with current installable digests.
  const installable = await listInstallableFiles(distPath);
  for (const relative of installable) {
    const bytes = await readFile(join(distPath, relative));
    const digest = sha256Hex(bytes);
    const expected = generation.outputDigests[relative];
    if (expected === undefined || expected !== digest) {
      return {
        ok: false,
        code: "plugin.package.stale",
        message: `Generated dist file does not match build generation: ${relative}`,
        details: { path: relative },
      };
    }
  }
  for (const relative of Object.keys(generation.outputDigests)) {
    if (!installable.includes(relative)) {
      return {
        ok: false,
        code: "plugin.package.stale",
        message: `Build generation lists missing installable file: ${relative}`,
        details: { path: relative },
      };
    }
  }

  const source = await validatePluginSource({
    workspacePath,
    timeoutMs: options.timeoutMs,
    env: options.env,
  });
  if (!source.ok) {
    return {
      ok: false,
      code: source.code,
      message: source.message,
      details: source.details,
    };
  }

  const inputDigests = await collectInputDigests({
    workspacePath,
    report: source.report,
    sdkInput: generation.sdkInput,
  });
  const expectedGenerationId = computeGenerationId(inputDigests);
  if (expectedGenerationId !== generation.generationId) {
    return {
      ok: false,
      code: "plugin.package.stale",
      message:
        "dist/ is stale relative to current package/config/source/assets; rebuild before packaging.",
      details: {
        expectedGenerationId,
        actualGenerationId: generation.generationId,
      },
    };
  }

  // Authority fields must still match the stored generation.
  if (
    source.report.id !== generation.pluginId ||
    source.report.version !== generation.version
  ) {
    return {
      ok: false,
      code: "plugin.package.stale",
      message: "dist/ generation identity does not match current source identity.",
      details: {
        sourceId: source.report.id,
        generationId: generation.pluginId,
        sourceVersion: source.report.version,
        generationVersion: generation.version,
      },
    };
  }

  const payloadSha256 = computePayloadSha256(checksums);
  if (payloadSha256 !== generation.payloadSha256) {
    return {
      ok: false,
      code: "plugin.package.stale",
      message: "dist/ payload identity does not match the build generation record.",
      details: {
        expected: generation.payloadSha256,
        actual: payloadSha256,
      },
    };
  }

  return {
    ok: true,
    generation,
    payloadSha256,
  };
}
