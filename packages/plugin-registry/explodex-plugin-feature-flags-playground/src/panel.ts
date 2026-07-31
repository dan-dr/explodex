import type { ComponentsApi } from "@explodex/sdk";
import {
  filterFeatures,
  groupFeaturesByStage,
  stageAnchorId,
  type FeatureFlag,
  type FeatureSection,
} from "./model";

export type BundleScanView = {
  available: boolean;
  status: "idle" | "scanning" | "cached" | "ready" | "error";
  scannedAt: Date | null;
  mappingCount: number;
  chunkCount: number;
  error: string | null;
};

export type PanelState = {
  loading: boolean;
  error: string | null;
  features: FeatureFlag[];
  hostId: string;
  updatedAt: Date | null;
};

export type FeatureFlagsPanelActions = {
  readonly components: ComponentsApi;
  readonly getState: () => PanelState;
  readonly getScan: () => BundleScanView;
  readonly isPopover: () => boolean;
  readonly toggle: (feature: FeatureFlag, enabled: boolean) => Promise<void>;
  readonly refresh: () => void;
  readonly rescan: () => void;
  readonly openSettings: () => void;
  readonly isToggling: (name: string) => boolean;
  readonly getView: () => { filter: string; scrollTop: number };
  readonly setFilter: (filter: string) => void;
  readonly setScrollTop: (scrollTop: number) => void;
  readonly appServerAvailable: () => boolean;
};

function summary(scan: BundleScanView): string {
  if (!scan.available) return "Bundle scan unavailable";
  if (scan.status === "scanning") return "Scanning Codex bundles…";
  if (scan.error) return `Bundle scan error: ${scan.error}`;
  if (!scan.scannedAt) return "Bundle scan pending";
  const ageHours = Math.max(0, Math.round((Date.now() - scan.scannedAt.getTime()) / 3_600_000));
  return `Bundle gates: ${scan.mappingCount} features / ${scan.chunkCount} chunks (${scan.status === "cached" ? "cached" : "fresh"}, ${ageHours}h)`;
}

function style<T extends HTMLElement>(element: T, css: string): T {
  element.style.cssText = css;
  return element;
}

function stageHeader(section: FeatureSection, first: boolean): HTMLDivElement {
  const header = style(document.createElement("div"), `display:flex;flex-direction:column;gap:3px;padding:${first ? "2px" : "14px"} 0 8px;${first ? "" : "border-top:1px solid color-mix(in srgb, currentColor 10%, transparent);margin-top:2px;"}`);
  header.id = stageAnchorId(section.key);
  const titleRow = style(document.createElement("div"), "display:flex;align-items:baseline;justify-content:space-between;gap:8px");
  const title = style(document.createElement("div"), "font:11px/1.3 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:color-mix(in srgb,currentColor 78%,transparent)");
  title.textContent = section.title;
  const count = style(document.createElement("div"), "font:10px/1.3 ui-monospace,monospace;color:color-mix(in srgb,currentColor 55%,transparent)");
  count.textContent = `${section.features.filter((feature) => feature.enabled).length}/${section.features.length}`;
  titleRow.append(title, count);
  const description = style(document.createElement("div"), "font:11px/1.4 system-ui,-apple-system,sans-serif;color:color-mix(in srgb,currentColor 58%,transparent)");
  description.textContent = section.description;
  header.append(titleRow, description);
  return header;
}

function featureRow(feature: FeatureFlag, actions: FeatureFlagsPanelActions): HTMLDivElement {
  const row = style(document.createElement("div"), "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start;padding:10px 0;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)");
  const copy = style(document.createElement("div"), "min-width:0;display:flex;flex-direction:column;gap:4px");
  const title = style(document.createElement("div"), "display:flex;flex-wrap:wrap;align-items:center;gap:8px;font:13px/1.35 system-ui,-apple-system,sans-serif");
  const name = style(document.createElement("code"), "font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 6px;border-radius:6px;background:color-mix(in srgb,currentColor 8%,transparent)");
  name.textContent = feature.name;
  title.appendChild(name);
  if (feature.statsigGateIds?.length) {
    const gates = style(document.createElement("span"), "font:10px/1 ui-monospace,monospace;padding:2px 6px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);color:color-mix(in srgb,currentColor 70%,transparent)");
    gates.textContent = feature.statsigGateIds.join(", ");
    title.appendChild(gates);
  }
  copy.appendChild(title);
  for (const [text, css] of [[feature.label, "font:13px/1.35 system-ui,-apple-system,sans-serif"], [feature.description, "font:12px/1.45 system-ui,-apple-system,sans-serif;color:color-mix(in srgb,currentColor 68%,transparent)"]] as const) {
    if (!text) continue;
    const node = style(document.createElement("div"), css);
    node.textContent = text;
    copy.appendChild(node);
  }
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = feature.enabled;
  input.disabled = actions.isToggling(feature.name);
  input.setAttribute("aria-label", `Toggle ${feature.name}`);
  input.style.cssText = "width:16px;height:16px;cursor:pointer;accent-color:var(--color-text-primary,#fff)";
  input.addEventListener("change", () => { void actions.toggle(feature, input.checked); });
  const toggle = style(document.createElement("div"), "display:flex;align-items:start;justify-content:end");
  toggle.appendChild(input);
  row.append(copy, toggle);
  return row;
}

function stageJumpNav(sections: readonly FeatureSection[], scrollContainer: HTMLElement): HTMLDivElement {
  const nav = style(document.createElement("div"), "display:flex;flex-wrap:wrap;gap:6px 10px;padding:2px 0 4px;font:11px/1.3 system-ui,-apple-system,sans-serif");
  for (const section of sections) {
    const link = style(document.createElement("button"), "background:none;border:none;padding:0;margin:0;cursor:pointer;font:inherit;color:color-mix(in srgb,currentColor 88%,transparent);text-decoration:underline;text-underline-offset:2px");
    link.type = "button";
    link.textContent = section.title;
    link.addEventListener("click", () => scrollContainer.querySelector(`#${CSS.escape(stageAnchorId(section.key))}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
    nav.appendChild(link);
  }
  return nav;
}

export function renderFeatureFlagsPanel(actions: FeatureFlagsPanelActions): HTMLDivElement {
  const state = actions.getState();
  const scan = actions.getScan();
  const view = actions.getView();
  const body = style(document.createElement("div"), actions.isPopover() ? "display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow:hidden" : "display:flex;flex-direction:column;gap:12px");
  const intro = style(document.createElement("div"), "font:12px/1.5 system-ui,-apple-system,sans-serif;color:color-mix(in srgb,currentColor 72%,transparent)");
  intro.textContent = actions.appServerAvailable() ? "Toggles persist to config.toml and override linked statsig gates (gate IDs shown per flag) so Codex UI hooks stay in sync." : "Toggles persist config overrides and apply discovered statsig gate overrides when needed.";
  body.appendChild(intro);
  const scanMeta = style(document.createElement("div"), "font:11px/1.4 ui-monospace,monospace;color:color-mix(in srgb,currentColor 62%,transparent)");
  scanMeta.textContent = summary(scan);
  body.appendChild(scanMeta);
  if (state.loading && state.features.length === 0) {
    const loading = style(document.createElement("div"), "font:13px system-ui,-apple-system,sans-serif;opacity:.8");
    loading.textContent = "Loading feature flags…";
    body.appendChild(loading);
    return body;
  }
  if (state.error) {
    const error = style(document.createElement("div"), "font:13px system-ui,-apple-system,sans-serif;color:var(--color-text-danger,#f87171)");
    error.textContent = state.error;
    body.appendChild(error);
  }
  const meta = style(document.createElement("div"), "display:flex;flex-wrap:wrap;gap:8px;font:11px/1.3 ui-monospace,monospace;color:color-mix(in srgb,currentColor 65%,transparent)");
  meta.textContent = `host=${state.hostId} · ${state.features.filter((feature) => feature.enabled).length} enabled · ${state.features.length} total`;
  const filter = document.createElement("input");
  filter.type = "search";
  filter.placeholder = "Filter flags…";
  filter.value = view.filter;
  filter.setAttribute("data-explodex-ff-filter", "");
  filter.style.cssText = "width:100%;padding:8px 10px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;font:13px system-ui,-apple-system,sans-serif";
  const jumpWrap = style(document.createElement("div"), "flex-shrink:0");
  const list = style(document.createElement("div"), actions.isPopover() ? "flex:1;min-height:0;overflow:auto;padding-right:4px;scroll-padding-top:4px" : "max-height:min(60vh,520px);overflow:auto;padding-right:4px;scroll-padding-top:4px");
  list.setAttribute("data-explodex-ff-list", "");
  const paint = (): void => {
    list.replaceChildren(); jumpWrap.replaceChildren();
    const rows = filterFeatures(actions.getState().features, filter.value);
    if (rows.length === 0) {
      const empty = style(document.createElement("div"), "padding:12px 0;font:13px system-ui,-apple-system,sans-serif;opacity:.75");
      empty.textContent = filter.value.trim() ? "No flags match your filter." : "No feature flags returned.";
      list.appendChild(empty); return;
    }
    const sections = groupFeaturesByStage(rows);
    if (sections.length > 1) jumpWrap.appendChild(stageJumpNav(sections, list));
    sections.forEach((section, index) => { list.appendChild(stageHeader(section, index === 0)); for (const feature of section.features) list.appendChild(featureRow(feature, actions)); });
  };
  filter.addEventListener("input", () => { actions.setFilter(filter.value); actions.setScrollTop(0); paint(); });
  list.addEventListener("scroll", () => actions.setScrollTop(list.scrollTop), { passive: true });
  paint();
  if (view.scrollTop > 0) requestAnimationFrame(() => { list.scrollTop = view.scrollTop; });
  body.append(meta, filter, jumpWrap, list);
  const buttons = style(document.createElement("div"), "display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between");
  buttons.appendChild(actions.components.button({ label: state.loading ? "Refreshing…" : "Refresh", color: "outline", size: "composerSm", disabled: state.loading, onClick: actions.refresh }));
  if (scan.available) buttons.appendChild(actions.components.button({ label: scan.status === "scanning" ? "Scanning…" : "Rescan bundles", color: "ghost", size: "composerSm", disabled: scan.status === "scanning", onClick: actions.rescan }));
  buttons.appendChild(actions.components.button({ label: "Open General Settings", color: "ghost", size: "composerSm", onClick: actions.openSettings }));
  body.appendChild(buttons);
  if (state.updatedAt) {
    const stamp = style(document.createElement("div"), "font:11px/1.3 system-ui,-apple-system,sans-serif;color:color-mix(in srgb,currentColor 55%,transparent)");
    stamp.textContent = `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(state.updatedAt)}`;
    body.appendChild(stamp);
  }
  const note = style(document.createElement("div"), "font:11px/1.45 system-ui,-apple-system,sans-serif;color:color-mix(in srgb,currentColor 55%,transparent)");
  note.textContent = "Some flags may require a Codex restart to fully apply. Remote control also updates local host enablement.";
  body.appendChild(note);
  return body;
}
