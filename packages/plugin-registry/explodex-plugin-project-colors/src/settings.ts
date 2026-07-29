export type ColorTarget = "projects" | "threads" | "both";

export type ProjectColorSettings = {
  version: 2;
  palette: string[];
  autoAssignProjects: boolean;
  visuals: {
    style: "side" | "full";
    colorTarget: ColorTarget;
  };
  projectOverrides: Record<string, string>;
  threadOverrides: Record<string, string>;
};

export const MIN_PALETTE_SIZE = 5;

export const DEFAULT_PALETTE = [
  "#E06C75",
  "#E5C07B",
  "#98C379",
  "#61AFEF",
  "#C678DD",
  "#56B6C2",
  "#D19A66",
  "#BE5046",
  "#6796E6",
  "#C0CA33",
  "#F06292",
  "#4DB6AC",
] as const;

export function defaultProjectColorSettings(): ProjectColorSettings {
  return {
    version: 2,
    palette: [...DEFAULT_PALETTE],
    autoAssignProjects: true,
    visuals: {
      style: "side",
      colorTarget: "projects",
    },
    projectOverrides: {},
    threadOverrides: {},
  };
}

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return null;
  if (raw.length === 4) {
    const [, red, green, blue] = raw;
    return `#${red}${red}${green}${green}${blue}${blue}`.toUpperCase();
  }
  return raw.toUpperCase();
}

export function normalizePalette(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_PALETTE];
  const colors: string[] = [];
  for (const entry of value) {
    const color = normalizeHexColor(entry);
    if (color !== null && !colors.includes(color)) colors.push(color);
  }
  return colors.length >= MIN_PALETTE_SIZE
    ? colors
    : [...DEFAULT_PALETTE];
}

function normalizeColorTarget(value: unknown): ColorTarget {
  return value === "projects" || value === "threads" || value === "both"
    ? value
    : "projects";
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function migrateProjectColorSettings(
  raw: unknown,
): ProjectColorSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultProjectColorSettings();
  }
  const record = raw as Record<string, unknown>;
  const visuals =
    typeof record.visuals === "object" &&
    record.visuals !== null &&
    !Array.isArray(record.visuals)
      ? (record.visuals as Record<string, unknown>)
      : {};
  let colorTarget = normalizeColorTarget(visuals.colorTarget);
  if (
    visuals.colorTarget === undefined &&
    (visuals.colorThreadsInProject === true || record.colorThreads === true)
  ) {
    colorTarget = "both";
  }
  return {
    version: 2,
    palette: normalizePalette(record.palette),
    autoAssignProjects:
      record.autoAssignProjects !== undefined
        ? record.autoAssignProjects !== false
        : record.autoAssign !== false,
    visuals: {
      style: visuals.style === "full" ? "full" : "side",
      colorTarget,
    },
    projectOverrides: recordOfStrings(
      record.projectOverrides ?? record.overrides,
    ),
    threadOverrides: recordOfStrings(record.threadOverrides),
  };
}

export function autoColorForId(
  id: string,
  palette: readonly string[],
): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length] ?? DEFAULT_PALETTE[0];
}

export function projectColorValue(
  settings: ProjectColorSettings,
  projectId: string,
): string | null {
  const override = settings.projectOverrides[projectId];
  if (override !== undefined) return override;
  if (!settings.autoAssignProjects) return null;
  return autoColorForId(projectId, normalizePalette(settings.palette));
}

export function inheritedThreadColor(
  settings: ProjectColorSettings,
  threadId: string,
  projectId: string | null,
): string | null {
  const manual = settings.threadOverrides[threadId];
  if (manual !== undefined) return manual;
  if (
    projectId === null ||
    (settings.visuals.colorTarget !== "threads" &&
      settings.visuals.colorTarget !== "both")
  ) {
    return null;
  }
  return projectColorValue(settings, projectId);
}
