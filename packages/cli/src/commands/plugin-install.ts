import { resolve } from "node:path";
import { EXIT_SUCCESS } from "../cli/exit-codes.ts";
import type { GlobalOptions } from "../cli/parse.ts";
import { renderFailure, usageFailure } from "../cli/errors.ts";
import {
  exitCodeForError,
  successEnvelope,
  type RenderedCliResult,
} from "../output/envelope.ts";
import { resolveExplodexHome } from "../home/paths.ts";
import {
  installLocalPluginArchive,
  installRemotePluginArchive,
  type PluginInstallResult,
} from "../plugin/install.ts";
import type { ArtifactSource } from "../plugin/install-state.ts";
import {
  fetchPluginArchive,
  parseCanonicalGitHubArtifactUrl,
  RegistryClientError,
  resolveRegistryPlugin,
} from "../plugin/registry-client.ts";
import { performPendingPluginReview } from "./plugin-review.ts";
import type { CliIo } from "../output/write.ts";
import { openPostOperationManagement } from "./post-operation-management.ts";

const OPERATION = "plugin.install";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const USAGE = "Usage: explodex plugin install [<archive> | --registry <id> | --github-url <url> --archive-sha256 <hex>] [--target <role>]";

type ParsedInstallOptions = {
  target: string | null;
  registry: string | null;
  githubUrl: string | null;
  archiveSha256: string | null;
  payloadSha256: string | null;
  rest: string[];
  missingOption: string | null;
  duplicateOption: string | null;
};

function takeInstallOptions(tokens: readonly string[]): ParsedInstallOptions {
  const rest: string[] = [];
  const values: Record<"target" | "registry" | "githubUrl" | "archiveSha256" | "payloadSha256", string | null> = {
    target: null,
    registry: null,
    githubUrl: null,
    archiveSha256: null,
    payloadSha256: null,
  };
  const definitions = [
    ["--target", "target"],
    ["--registry", "registry"],
    ["--github-url", "githubUrl"],
    ["--archive-sha256", "archiveSha256"],
    ["--payload-sha256", "payloadSha256"],
  ] as const;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const definition = definitions.find(([flag]) => token === flag || token.startsWith(`${flag}=`));
    if (definition !== undefined) {
      const [flag, key] = definition;
      if (values[key] !== null) {
        return { ...values, rest, missingOption: null, duplicateOption: flag };
      }
      if (token.startsWith(`${flag}=`)) {
        const value = token.slice(flag.length + 1);
        if (value.length === 0) {
          return { ...values, rest, missingOption: flag, duplicateOption: null };
        }
        values[key] = value;
        continue;
      }
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("-")) {
        return { ...values, rest, missingOption: flag, duplicateOption: null };
      }
      values[key] = next;
      index += 1;
      continue;
    }
    rest.push(token);
  }
  return { ...values, rest, missingOption: null, duplicateOption: null };
}

export async function runPluginInstall(options: {
  globals: GlobalOptions;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  rest: readonly string[];
  endOfOptions: readonly string[];
  signal?: AbortSignal;
}): Promise<RenderedCliResult> {
  const parsed = takeInstallOptions([...options.rest, ...options.endOfOptions]);
  if (parsed.missingOption !== null) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.missing-argument",
      message: `Option ${parsed.missingOption} requires a value.`,
      usageLine: USAGE,
      helpPath: "plugin install",
      details: { option: parsed.missingOption },
    });
  }
  if (parsed.duplicateOption !== null) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Option ${parsed.duplicateOption} may be supplied only once.`,
      usageLine: USAGE,
      helpPath: "plugin install",
      details: { option: parsed.duplicateOption },
    });
  }
  const target = parsed.target ?? "none";
  if (target !== "none" && target !== "main" && target !== "development") {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Invalid --target value '${target}'.`,
      usageLine: USAGE,
      helpPath: "plugin install",
      details: { option: "--target", value: target },
    });
  }
  const unexpected = parsed.rest.filter((token) => token.startsWith("-"));
  if (unexpected.length > 0) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.unknown-option",
      message: `Unexpected option '${unexpected[0]}'.`,
      usageLine: USAGE,
      helpPath: "plugin install",
      details: { option: unexpected[0] },
    });
  }
  if (parsed.rest.length > 1) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: `Unexpected extra argument '${parsed.rest[1]}'.`,
      usageLine: USAGE,
      helpPath: "plugin install",
    });
  }
  const selectors = [
    parsed.rest.length === 1 ? "archive" : null,
    parsed.registry === null ? null : "--registry",
    parsed.githubUrl === null ? null : "--github-url",
  ].filter((value): value is string => value !== null);
  if (selectors.length > 1) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.conflicting-options",
      message: "Choose exactly one plugin source: local archive, --registry, or --github-url.",
      usageLine: USAGE,
      helpPath: "plugin install",
      details: { sources: selectors },
    });
  }
  if (selectors.length === 0) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.missing-argument",
      message: "A local archive, --registry ID, or --github-url is required.",
      usageLine: USAGE,
      helpPath: "plugin install",
    });
  }
  if (parsed.githubUrl !== null && parsed.archiveSha256 === null) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.missing-argument",
      message: "Direct GitHub installation requires --archive-sha256.",
      usageLine: USAGE,
      helpPath: "plugin install",
      details: { option: "--archive-sha256" },
    });
  }
  if (parsed.archiveSha256 !== null && !SHA256_PATTERN.test(parsed.archiveSha256)) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: "Option --archive-sha256 must be 64 lowercase hexadecimal characters.",
      usageLine: USAGE,
      helpPath: "plugin install",
      details: { option: "--archive-sha256" },
    });
  }
  if (parsed.payloadSha256 !== null && !SHA256_PATTERN.test(parsed.payloadSha256)) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.invalid-value",
      message: "Option --payload-sha256 must be 64 lowercase hexadecimal characters.",
      usageLine: USAGE,
      helpPath: "plugin install",
      details: { option: "--payload-sha256" },
    });
  }
  if (parsed.githubUrl === null &&
    (parsed.archiveSha256 !== null || parsed.payloadSha256 !== null)) {
    return usageFailure({
      operation: OPERATION,
      code: "usage.conflicting-options",
      message: "Digest options apply only to --github-url installation.",
      usageLine: USAGE,
      helpPath: "plugin install",
      details: { source: selectors[0] },
    });
  }

  const cwd = options.env.PWD ?? process.cwd();
  let explodexHome: string;
  try {
    explodexHome = resolveExplodexHome({
      osHome: options.env.HOME,
      explodexHome: options.globals.home ?? options.env.EXPLODEX_HOME,
    });
  } catch (error: unknown) {
    return renderFailure({
      operation: OPERATION,
      code: "plugin.install.home-invalid",
      message: error instanceof Error ? error.message : "Unable to resolve Explodex home.",
    });
  }
  let result: PluginInstallResult;
  let transportTrust: "computed-local-archive-not-publisher-authenticated" |
    "verified-publisher-declared-archive-sha256";
  try {
    if (parsed.rest.length === 1) {
      result = await installLocalPluginArchive({
        archivePath: resolve(cwd, parsed.rest[0]!),
        explodexHome,
        signal: options.signal,
      });
      transportTrust = "computed-local-archive-not-publisher-authenticated";
    } else if (parsed.registry !== null) {
      const resolved = await resolveRegistryPlugin({
        id: parsed.registry,
        registryUrl: options.env.EXPLODEX_PLUGIN_REGISTRY_URL,
        signal: options.signal,
      });
      const archiveBytes = await fetchPluginArchive({
        artifactUrl: resolved.entry.artifactUrl,
        signal: options.signal,
      });
      const source: Extract<ArtifactSource, { kind: "registry" }> = {
        kind: "registry",
        registryUrl: resolved.registryUrl,
        repositoryUrl: resolved.repositoryUrl,
        artifactUrl: resolved.entry.artifactUrl,
      };
      result = await installRemotePluginArchive({
        archiveBytes,
        expectedArchiveSha256: resolved.entry.archiveSha256,
        expectedIdentity: {
          id: parsed.registry,
          version: resolved.entry.version,
          payloadSha256: resolved.entry.payloadSha256,
        },
        source,
        explodexHome,
        signal: options.signal,
      });
      transportTrust = "verified-publisher-declared-archive-sha256";
    } else {
      const canonical = parseCanonicalGitHubArtifactUrl(parsed.githubUrl!);
      const archiveBytes = await fetchPluginArchive({
        artifactUrl: canonical.artifactUrl,
        signal: options.signal,
      });
      const source: Extract<ArtifactSource, { kind: "github" }> = {
        kind: "github",
        repositoryUrl: canonical.repositoryUrl,
        artifactUrl: canonical.artifactUrl,
        expectedArchiveSha256: parsed.archiveSha256!,
      };
      result = await installRemotePluginArchive({
        archiveBytes,
        expectedArchiveSha256: parsed.archiveSha256!,
        expectedIdentity: parsed.payloadSha256 === null
          ? undefined
          : { payloadSha256: parsed.payloadSha256 },
        source,
        explodexHome,
        signal: options.signal,
      });
      transportTrust = "verified-publisher-declared-archive-sha256";
    }
  } catch (error: unknown) {
    const interrupted = options.signal?.aborted === true;
    const code = interrupted
      ? "operation.interrupted"
      : error instanceof RegistryClientError
        ? error.code
        : "plugin.registry.fetch-failed";
    const message = interrupted
      ? "Plugin installation was interrupted."
      : error instanceof RegistryClientError
        ? error.message
        : "Remote plugin fetch failed.";
    return renderFailure({
      operation: OPERATION,
      code,
      message,
      details: error instanceof RegistryClientError ? error.details : undefined,
      exitCode: exitCodeForError(code),
      humanStderr: `${message}\nerror.code: ${code}\n`,
    });
  }
  if (!result.ok) {
    return renderFailure({
      operation: OPERATION,
      code: result.code,
      message: result.message,
      details: {
        ...result.details,
        artifactCommitted: result.artifactCommitted,
        ...(result.stateCommitted === undefined
          ? {}
          : { stateCommitted: result.stateCommitted }),
        ...(result.completedMutation === undefined
          ? {}
          : { completedMutation: result.completedMutation }),
        ...(result.artifactPath === undefined ? {} : { artifactPath: result.artifactPath }),
        ...(result.residualLockAuthority === undefined
          ? {}
          : { residualLockAuthority: result.residualLockAuthority }),
      },
      exitCode: exitCodeForError(result.code),
      humanStderr: `${result.message}\nerror.code: ${result.code}\n`,
    });
  }

  const payload = {
    id: result.id,
    version: result.version,
    payloadSha256: result.payloadSha256,
    archiveSha256: result.archiveSha256,
    archiveRootName: result.archiveRootName,
    lifecycle: result.lifecycle,
    sdkRange: result.sdkRange,
    files: result.files,
    artifactPath: result.artifactPath,
    relativePath: result.relativePath,
    source: result.source,
    sourceLabel: result.sourceLabel,
    outcome: result.outcome,
    installed: true,
    artifactCommitted: result.artifactCommitted,
    stateCommitted: result.stateCommitted,
    activationChanged: result.activationChanged,
    enabled: result.enabled,
    pendingReview: result.pendingReview,
    target,
    transportTrust,
  };
  if (result.pendingReview && target !== "none") {
    const review = await performPendingPluginReview({
      globals: options.globals,
      env: options.env,
      io: options.io,
      explodexHome,
      pending: [{
        id: result.id,
        displayName: result.displayName,
        description: result.description,
        version: result.version,
        payloadSha256: result.payloadSha256,
        sdkRange: result.sdkRange,
        sourceLabel: result.sourceLabel,
      }],
      request: {
        id: result.id,
        version: result.version,
        payloadSha256: result.payloadSha256,
      },
      target,
      signal: options.signal,
    });
    if (!review.ok) {
      return renderFailure({
        operation: OPERATION,
        code: review.code,
        message: review.message,
        details: {
          ...payload,
          ...review.details,
          sourceDelivered: review.sourceDelivered,
          authorityChanged: review.authorityChanged,
        },
        exitCode: review.exitCode ?? exitCodeForError(review.code),
        humanStderr: [
          "Plugin installation completed disabled and pending review.",
          review.message,
          `error.code: ${review.code}`,
          "",
        ].join("\n"),
      });
    }
    const management = await openPostOperationManagement({
      globals: options.globals,
      env: options.env,
      explodexHome,
      target,
      signal: options.signal,
    });
    return {
      envelope: successEnvelope(
        OPERATION,
        {
          ...payload,
          review,
          management,
        },
        management.warning === null ? [] : [management.warning],
      ),
      exitCode: EXIT_SUCCESS,
      humanStdout: [
        `Installed plugin: ${result.id}@${result.version}`,
        review.status === "approved"
          ? `Approval committed: ${review.selected.length} selected`
          : "Review submitted with an empty selection",
        review.status === "approved"
          ? `Application results: ${review.applications.length}`
          : "Activation authority was unchanged.",
        management.humanLine,
        "",
      ].join("\n"),
      humanStderr: "",
    };
  }
  const human = [
    `${result.outcome === "already-installed" ? "Already installed" : result.outcome === "rediscovered" ? "Rediscovered" : "Installed"} plugin: ${result.id}@${result.version}`,
    `  payloadSha256: ${result.payloadSha256}`,
    `  archiveSha256: ${result.archiveSha256} (${transportTrust === "verified-publisher-declared-archive-sha256" ? "verified against publisher-declared digest" : "computed from the local archive; not publisher-authenticated"})`,
    `  artifact: ${result.artifactPath}`,
    `  source: ${result.sourceLabel}`,
    result.enabled
      ? "  authority: unchanged (this exact identity was already enabled before reinstall)"
      : result.pendingReview
        ? "  enabled: no (pending separate review)"
        : "  authority: unchanged",
    "",
  ].join("\n");
  return {
    envelope: successEnvelope(OPERATION, payload),
    exitCode: EXIT_SUCCESS,
    humanStdout: human,
    humanStderr: "",
  };
}
