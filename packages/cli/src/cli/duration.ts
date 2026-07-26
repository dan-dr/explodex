/**
 * Frozen --timeout grammar: positive base-10 integer + ms|s|m, range 1ms..10m.
 */

const DURATION_PATTERN = /^([1-9][0-9]*)(ms|s|m)$/;
const MIN_MS = 1;
const MAX_MS = 10 * 60 * 1000;

export type DurationParseResult =
  | { ok: true; milliseconds: number; raw: string }
  | { ok: false; message: string };

export function parseDuration(raw: string): DurationParseResult {
  const match = DURATION_PATTERN.exec(raw);
  if (match === null) {
    return {
      ok: false,
      message:
        "Invalid --timeout value. Use a positive integer with unit ms, s, or m (for example 60s).",
    };
  }
  const amount = Number(match[1]);
  const unit = match[2];
  let milliseconds: number;
  if (unit === "ms") milliseconds = amount;
  else if (unit === "s") milliseconds = amount * 1000;
  else milliseconds = amount * 60 * 1000;

  if (milliseconds < MIN_MS || milliseconds > MAX_MS) {
    return {
      ok: false,
      message: "Invalid --timeout value. Duration must be between 1ms and 10m inclusive.",
    };
  }
  return { ok: true, milliseconds, raw };
}

export const DEFAULT_ONE_SHOT_TIMEOUT_MS = 60_000;
