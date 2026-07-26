/**
 * CLI access to the single @explodex/sdk version/range authority.
 * Do not reimplement SemVer or range matching in the CLI; import from here.
 */
export {
  SDK_VERSION,
  compareSemVer,
  currentSdkSatisfiesRange,
  evaluateSdkCompatibility,
  parseSemVer,
  satisfiesSdkRange,
  type ParsedSemVer,
  type SdkCompatibilityReason,
  type SdkCompatibilityVerdict,
} from "@explodex/sdk";
