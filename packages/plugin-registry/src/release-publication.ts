import { resolve } from "node:path";
import { verifyStagedRelease, type ReleaseStagingFailure } from "./release-staging.ts";

export type ReleasePublicationPlan = {
  ok: true;
  command: readonly string[];
  registrySha256: string;
};

export type ReleasePublicationResult = ReleasePublicationPlan | ReleaseStagingFailure;

export async function prepareReleasePublication(options: {
  stagingDirectory: string;
  releaseTag: string;
  approval: string;
  verify?: typeof verifyStagedRelease;
}): Promise<ReleasePublicationResult> {
  const verified = await (options.verify ?? verifyStagedRelease)({
    stagingDirectory: options.stagingDirectory,
    releaseTag: options.releaseTag,
  });
  if (!verified.ok) return verified;
  if (options.approval !== verified.registrySha256) {
    return {
      ok: false,
      code: "registry.publication-not-approved",
      message: "Approval must exactly match the staged registry.json SHA-256.",
    };
  }
  return {
    ok: true,
    registrySha256: verified.registrySha256,
    command: [
      "gh",
      "release",
      "create",
      options.releaseTag,
      ...verified.files.map((file) => resolve(options.stagingDirectory, file)),
      "--title",
      options.releaseTag,
      "--verify-tag",
      "--generate-notes",
    ],
  };
}
