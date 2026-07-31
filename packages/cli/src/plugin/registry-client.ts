import { encodeArtifactIdentity } from "./identity-encode.ts";

const REPOSITORY_URL = "https://github.com/dan-dr/explodex";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_REGISTRY_BYTES = 1_048_576;
const MAX_ARCHIVE_BYTES = 64 * 1_048_576;
const MAX_REDIRECTS = 4;

export const DEFAULT_PLUGIN_REGISTRY_URL =
  "https://github.com/dan-dr/explodex/releases/latest/download/registry.json";

export type RegistryPluginEntry = {
  version: string;
  displayName: string;
  description: string;
  sdkRange: string;
  artifactUrl: string;
  payloadSha256: string;
  archiveSha256: string;
};

export type PluginRegistry = {
  schemaVersion: 1;
  repositoryUrl: typeof REPOSITORY_URL;
  plugins: Record<string, RegistryPluginEntry>;
};

export class RegistryClientError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RegistryClientError";
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeHttpsUrl(value: string): URL | null {
  if (value.length === 0 || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.port !== "" || url.hash !== "") return null;
    return url;
  } catch {
    return null;
  }
}

function githubReleaseAsset(url: URL): {
  repositoryUrl: string;
  tag: string;
  assetName: string;
} | null {
  if (url.hostname !== "github.com" || url.search !== "") return null;
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length !== 6 || parts[2] !== "releases" || parts[3] !== "download") {
    return null;
  }
  const [owner, repository, , , tag, assetName] = parts;
  if (owner === undefined || repository === undefined || tag === undefined ||
    assetName === undefined || tag === "." || tag === ".." || assetName.includes("/")) {
    return null;
  }
  return {
    repositoryUrl: `https://github.com/${owner}/${repository}`,
    tag,
    assetName,
  };
}

export function parseCanonicalGitHubArtifactUrl(value: string): {
  repositoryUrl: string;
  artifactUrl: string;
  tag: string;
  assetName: string;
} {
  const url = safeHttpsUrl(value);
  const parsed = url === null ? null : githubReleaseAsset(url);
  if (url === null || parsed === null || parsed.repositoryUrl !== REPOSITORY_URL) {
    throw new RegistryClientError(
      "plugin.install.github-url-invalid",
      "Plugin artifact URL must be one canonical immutable dan-dr/explodex GitHub release asset URL.",
    );
  }
  return { ...parsed, artifactUrl: url.toString() };
}

function parseEntry(id: string, value: unknown): RegistryPluginEntry {
  if (!PLUGIN_ID_PATTERN.test(id) || !isRecord(value) || !exactKeys(value, [
    "version",
    "displayName",
    "description",
    "sdkRange",
    "artifactUrl",
    "payloadSha256",
    "archiveSha256",
  ])) {
    throw new RegistryClientError("plugin.registry.invalid", "Plugin registry entry is malformed.", { id });
  }
  const version = value["version"];
  const displayName = value["displayName"];
  const description = value["description"];
  const sdkRange = value["sdkRange"];
  const artifactUrl = value["artifactUrl"];
  const payloadSha256 = value["payloadSha256"];
  const archiveSha256 = value["archiveSha256"];
  if (!isBoundedText(version, 256) || !isBoundedText(displayName, 512) ||
    !isBoundedText(description, 4_096) || !isBoundedText(sdkRange, 256) ||
    typeof artifactUrl !== "string" || typeof payloadSha256 !== "string" ||
    !SHA256_PATTERN.test(payloadSha256) || typeof archiveSha256 !== "string" ||
    !SHA256_PATTERN.test(archiveSha256)) {
    throw new RegistryClientError("plugin.registry.invalid", "Plugin registry entry is malformed.", { id });
  }
  const canonical = parseCanonicalGitHubArtifactUrl(artifactUrl);
  const identity = encodeArtifactIdentity({ id, version, payloadSha256 });
  if (canonical.assetName !== identity.archiveFileName) {
    throw new RegistryClientError(
      "plugin.registry.identity-mismatch",
      "Plugin registry artifact filename does not match its declared identity.",
      { id },
    );
  }
  return {
    version,
    displayName,
    description,
    sdkRange,
    artifactUrl: canonical.artifactUrl,
    payloadSha256,
    archiveSha256,
  };
}

export function parsePluginRegistry(value: unknown): PluginRegistry {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "repositoryUrl", "plugins"]) ||
    value["schemaVersion"] !== 1 || value["repositoryUrl"] !== REPOSITORY_URL ||
    !isRecord(value["plugins"])) {
    throw new RegistryClientError("plugin.registry.invalid", "Plugin registry is malformed.");
  }
  const plugins: Record<string, RegistryPluginEntry> = {};
  for (const id of Object.keys(value["plugins"]).sort()) {
    plugins[id] = parseEntry(id, value["plugins"][id]);
  }
  return { schemaVersion: 1, repositoryUrl: REPOSITORY_URL, plugins };
}

function redirectHostAllowed(hostname: string): boolean {
  return hostname === "github.com" || hostname === "objects.githubusercontent.com" ||
    hostname === "release-assets.githubusercontent.com" ||
    hostname.endsWith(".githubusercontent.com");
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new RegistryClientError("plugin.registry.response-too-large", "Remote plugin response exceeds the size limit.");
    }
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        throw new RegistryClientError("plugin.registry.response-too-large", "Remote plugin response exceeds the size limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function fetchGitHubBytes(options: {
  url: string;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<Buffer> {
  let current = safeHttpsUrl(options.url);
  if (current === null || current.hostname !== "github.com") {
    throw new RegistryClientError("plugin.registry.url-invalid", "Remote plugin URL must be a safe GitHub HTTPS URL.");
  }
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current, { method: "GET", redirect: "manual", signal: options.signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null || redirect === MAX_REDIRECTS) {
        throw new RegistryClientError("plugin.registry.redirect-invalid", "GitHub response exceeded the redirect limit.");
      }
      const next = safeHttpsUrl(new URL(location, current).toString());
      if (next === null || !redirectHostAllowed(next.hostname)) {
        throw new RegistryClientError("plugin.registry.redirect-invalid", "GitHub response redirected outside the trusted host set.");
      }
      current = next;
      continue;
    }
    if (!response.ok) {
      throw new RegistryClientError(
        "plugin.registry.fetch-failed",
        `Remote plugin fetch failed with HTTP ${response.status}.`,
        { status: response.status },
      );
    }
    return readBoundedBody(response, options.maxBytes);
  }
  throw new RegistryClientError("plugin.registry.redirect-invalid", "GitHub response exceeded the redirect limit.");
}

export async function resolveRegistryPlugin(options: {
  id: string;
  registryUrl?: string;
  signal?: AbortSignal;
}): Promise<{
  registryUrl: string;
  repositoryUrl: string;
  entry: RegistryPluginEntry;
}> {
  if (!PLUGIN_ID_PATTERN.test(options.id)) {
    throw new RegistryClientError("plugin.registry.id-invalid", "Registry plugin ID is invalid.", { id: options.id });
  }
  const registryUrl = options.registryUrl ?? DEFAULT_PLUGIN_REGISTRY_URL;
  const parsedRegistryUrl = safeHttpsUrl(registryUrl);
  if (parsedRegistryUrl === null || parsedRegistryUrl.hostname !== "github.com" ||
    !parsedRegistryUrl.pathname.startsWith("/dan-dr/explodex/releases/") ||
    !parsedRegistryUrl.pathname.endsWith("/registry.json")) {
    throw new RegistryClientError("plugin.registry.url-invalid", "Configured plugin registry URL is not a canonical Explodex GitHub release registry.");
  }
  const bytes = await fetchGitHubBytes({ url: registryUrl, maxBytes: MAX_REGISTRY_BYTES, signal: options.signal });
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new RegistryClientError("plugin.registry.invalid", "Plugin registry is not valid JSON.");
  }
  const registry = parsePluginRegistry(value);
  const entry = registry.plugins[options.id];
  if (entry === undefined) {
    throw new RegistryClientError("plugin.registry.not-found", "Plugin ID was not found in the configured registry.", { id: options.id });
  }
  return { registryUrl: parsedRegistryUrl.toString(), repositoryUrl: registry.repositoryUrl, entry };
}

export async function fetchPluginArchive(options: {
  artifactUrl: string;
  signal?: AbortSignal;
}): Promise<Buffer> {
  parseCanonicalGitHubArtifactUrl(options.artifactUrl);
  return fetchGitHubBytes({ url: options.artifactUrl, maxBytes: MAX_ARCHIVE_BYTES, signal: options.signal });
}
