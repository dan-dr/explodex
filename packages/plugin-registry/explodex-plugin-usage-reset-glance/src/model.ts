import type { FormatApi, HttpRequestOptions } from "@explodex/sdk";

export const SETTINGS_KEY = "explodex-usage-reset-glance";
export const LEGACY_SETTINGS_KEY = "explodex-usage-reset-sidebar";
export const PATH_USAGE = "/wham/usage";
export const PATH_RESET_CREDITS = "/wham/rate-limit-reset-credits";

export const DEFAULT_TEMPLATE =
  "{usage.primary.label}: {usage.primary.left.percent}% {usage.primary.reset.in} • Weekly: {usage.secondary.left.percent}% {usage.secondary.reset.in} • Reset: {resets.count}";

export type UsageSettings = {
  compactTemplate: string;
  refreshIntervalSec: number;
  refreshPreset: "30" | "60" | "300" | "0" | "custom";
};

export type UsageWindow = {
  usedPercent: number;
  resetAt: number | null;
  windowMinutes: number | null;
};

export type UsageStatus = {
  planType: unknown;
  limitReached: boolean;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  credits: unknown;
};

export type ResetCredit = Record<string, unknown> & {
  status?: unknown;
  title?: unknown;
  description?: unknown;
};

export type ResetCreditStatus = {
  availableCount: number;
  credits: ResetCredit[];
};

export type ViewOnlyUsageHttp = {
  isAvailable(): boolean;
  get<T = unknown>(
    path: typeof PATH_USAGE | typeof PATH_RESET_CREDITS,
    options?: HttpRequestOptions,
  ): Promise<T | null>;
};

type HttpGetCapability = {
  isAvailable(): boolean;
  get<T = unknown>(
    path: string,
    options?: HttpRequestOptions,
  ): Promise<T | null>;
};

function toFiniteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampPercent(value: unknown): number {
  return Math.min(100, Math.max(0, toFiniteNumber(value)));
}

export function normalizeUnixTimestamp(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1_000) : Math.floor(value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1e12
      ? Math.floor(numeric / 1_000)
      : Math.floor(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1_000);
}

export function creditExpiryUnix(
  credit: ResetCredit | null | undefined,
): number | null {
  if (credit === null || credit === undefined) return null;
  const directKeys = [
    "expires_at",
    "expiration_at",
    "expiresAt",
    "valid_until",
    "valid_until_at",
    "redeem_by",
    "redeem_by_at",
  ] as const;
  for (const key of directKeys) {
    const unix = normalizeUnixTimestamp(credit[key]);
    if (unix !== null) return unix;
  }
  for (const [key, value] of Object.entries(credit)) {
    if (!/_at$|_until$|_by$/.test(key)) continue;
    const unix = normalizeUnixTimestamp(value);
    if (unix !== null) return unix;
  }
  return null;
}

export function creditExpiryLabel(
  credit: ResetCredit | null | undefined,
  format: FormatApi,
): string | null {
  const unix = creditExpiryUnix(credit);
  if (unix !== null) return format.datetimeCountdown(unix);
  const description =
    typeof credit?.description === "string" ? credit.description.trim() : "";
  return description || null;
}

function parseWindow(raw: unknown): UsageWindow | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const seconds =
    record.limit_window_seconds == null
      ? null
      : toFiniteNumber(record.limit_window_seconds, Number.NaN);
  return {
    usedPercent: clampPercent(record.used_percent),
    resetAt: normalizeUnixTimestamp(record.reset_at),
    windowMinutes: Number.isFinite(seconds) ? seconds! / 60 : null,
  };
}

export function parseUsage(body: unknown): UsageStatus {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const rate =
    record.rate_limit !== null && typeof record.rate_limit === "object"
      ? (record.rate_limit as Record<string, unknown>)
      : null;
  return {
    planType: record.plan_type ?? null,
    limitReached: Boolean(
      rate?.limit_reached || record.rate_limit_reached_type,
    ),
    primary: parseWindow(rate?.primary_window),
    secondary: parseWindow(rate?.secondary_window),
    credits: record.credits ?? null,
  };
}

export function parseResetCredits(body: unknown): ResetCreditStatus {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const rawCredits = Array.isArray(record.credits)
    ? (record.credits as ResetCredit[])
    : [];
  const credits = rawCredits.filter(
    (credit) => credit !== null && credit.status === "available",
  );
  const availableCount = toFiniteNumber(
    record.available_count,
    credits.length,
  );
  return {
    availableCount: Math.max(0, Math.floor(availableCount)),
    credits,
  };
}

export function formatWindowLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return "—";
  const day = 1_440;
  const week = 7 * day;
  if (minutes >= 10_079) {
    const weeks = Math.ceil(minutes / week);
    return weeks === 1 ? "Weekly" : `${weeks}w`;
  }
  if (minutes >= 1_439) return `${Math.ceil(minutes / day)}d`;
  if (minutes >= 60) return `${Math.ceil(minutes / 60)}h`;
  return `${Math.ceil(minutes)}m`;
}

export function percentLeft(usedPercent: number): number {
  return Math.round(100 - clampPercent(usedPercent));
}

export function formatPercentLabel(
  usedPercent: number,
  showLeft: boolean,
): string {
  return showLeft
    ? `${percentLeft(usedPercent)}% left`
    : `${Math.round(clampPercent(usedPercent))}% used`;
}

function windowContext(
  window: UsageWindow | null | undefined,
  format: FormatApi,
) {
  if (!window) {
    return {
      label: "—",
      left: { percent: 0 },
      used: { percent: 0 },
      reset: { in: "—", at: "—" },
    };
  }
  return {
    label: formatWindowLabel(window.windowMinutes),
    left: { percent: percentLeft(window.usedPercent) },
    used: { percent: Math.round(clampPercent(window.usedPercent)) },
    reset: {
      in: format.countdown(window.resetAt),
      at: format.datetimeCountdown(window.resetAt),
    },
  };
}

export function buildUsageContext(
  usage: UsageStatus | null,
  resets: ResetCreditStatus | null,
  format: FormatApi,
) {
  const primary = windowContext(usage?.primary, format);
  const secondary = windowContext(usage?.secondary, format);
  const resetEntries = (resets?.credits ?? []).map((credit) => ({
    title:
      typeof credit.title === "string" && credit.title.trim()
        ? credit.title
        : "Reset",
    expires: creditExpiryLabel(credit, format) ?? "—",
  }));
  const resetsContext: Record<string | number, unknown> = {
    count: resets?.availableCount ?? 0,
    available: resets?.availableCount ?? 0,
  };
  resetEntries.forEach((entry, index) => {
    resetsContext[index] = entry;
  });
  if (resetsContext[0] === undefined) {
    resetsContext[0] = { title: "—", expires: "—" };
  }
  return {
    usage: {
      primary,
      secondary,
      short: primary,
      week: secondary,
    },
    resets: resetsContext,
  };
}

export function formatCompactUsage(
  usage: UsageStatus | null,
  resets: ResetCreditStatus | null,
  template: string,
  format: FormatApi,
): string {
  if (!usage && !resets) return "Usage: unavailable";
  const context = buildUsageContext(usage, resets, format);
  try {
    return format.template(template || DEFAULT_TEMPLATE, context, {
      fallback: "—",
    });
  } catch {
    return format.template(DEFAULT_TEMPLATE, context, { fallback: "—" });
  }
}

export function defaultUsageSettings(): UsageSettings {
  return {
    compactTemplate: DEFAULT_TEMPLATE,
    refreshIntervalSec: 60,
    refreshPreset: "60",
  };
}

export function normalizeUsageSettings(raw: unknown): UsageSettings {
  const defaults = defaultUsageSettings();
  if (raw === null || typeof raw !== "object") return defaults;
  const record = raw as Record<string, unknown>;
  const compactTemplate =
    typeof record.compactTemplate === "string" &&
    record.compactTemplate.trim()
      ? record.compactTemplate.trim()
      : defaults.compactTemplate;
  const rawInterval = Number(
    record.refreshIntervalSec ?? defaults.refreshIntervalSec,
  );
  const refreshIntervalSec = Math.max(
    0,
    Number.isFinite(rawInterval)
      ? Math.floor(rawInterval)
      : defaults.refreshIntervalSec,
  );
  const explicitPreset = record.refreshPreset;
  const refreshPreset: UsageSettings["refreshPreset"] =
    explicitPreset === "30" ||
    explicitPreset === "60" ||
    explicitPreset === "300" ||
    explicitPreset === "0" ||
    explicitPreset === "custom"
      ? explicitPreset
      : refreshIntervalSec === 0
        ? "0"
        : refreshIntervalSec === 30
          ? "30"
          : refreshIntervalSec === 300
            ? "300"
            : refreshIntervalSec === 60
              ? "60"
              : "custom";
  return { compactTemplate, refreshIntervalSec, refreshPreset };
}

export function refreshIntervalMs(settings: UsageSettings): number {
  if (settings.refreshPreset === "custom") {
    return Math.max(5, settings.refreshIntervalSec) * 1_000;
  }
  const seconds = Number(settings.refreshPreset);
  return seconds > 0 ? seconds * 1_000 : 0;
}

export function createViewOnlyUsageHttp(
  http: HttpGetCapability,
): ViewOnlyUsageHttp {
  return {
    isAvailable: () => http.isAvailable(),
    get(path, options) {
      if (path !== PATH_USAGE && path !== PATH_RESET_CREDITS) {
        return Promise.reject(
          new Error("view-only plugin: path not allowed"),
        );
      }
      return http.get(path, options);
    },
  };
}
