import type {
  CdpExecutionContext,
  CdpTarget,
  CdpTargetSummary,
  TargetSelectionResult,
} from "./types.ts";

const EXACT_RENDERER_URL = "app://-/index.html";

function summarize(target: CdpTarget): CdpTargetSummary {
  return {
    id: target.id,
    type: target.type,
    url: target.url,
    title: target.title,
  };
}

function sortSummaries(targets: CdpTarget[]): CdpTargetSummary[] {
  return targets.map(summarize).sort((left, right) => left.id.localeCompare(right.id));
}

/** Require one exact page plus one exact default execution context. */
export function selectExactPageAndContext(input: {
  targets: CdpTarget[];
  contextsByTarget: Record<string, CdpExecutionContext[]>;
}): TargetSelectionResult {
  const compatible = input.targets.filter(
    (target) => target.type === "page" && target.url === EXACT_RENDERER_URL,
  );
  if (compatible.length === 0) {
    return {
      kind: "rejected",
      code: "target_not_found",
      message: `No page target matched exact URL ${EXACT_RENDERER_URL}`,
      candidates: sortSummaries(input.targets),
    };
  }
  if (compatible.length > 1) {
    return {
      kind: "rejected",
      code: "target_ambiguous",
      message: `Expected one exact ${EXACT_RENDERER_URL} page; found ${compatible.length}`,
      candidates: sortSummaries(compatible),
    };
  }

  const target = compatible[0];
  if (target === undefined) throw new Error("Compatible target inventory was unexpectedly empty");
  const contexts = (input.contextsByTarget[target.id] ?? []).filter(
    (candidate) => candidate.targetId === target.id && candidate.isDefault,
  );
  if (contexts.length === 0) {
    return {
      kind: "rejected",
      code: "context_not_found",
      message: `Target ${target.id} exposed no exact default execution context`,
      candidates: [summarize(target)],
    };
  }
  if (contexts.length > 1) {
    return {
      kind: "rejected",
      code: "context_ambiguous",
      message: `Target ${target.id} exposed ${contexts.length} default execution contexts`,
      candidates: [summarize(target)],
    };
  }
  const selectedContext = contexts[0];
  if (selectedContext === undefined) throw new Error("Compatible context inventory was unexpectedly empty");

  return {
    kind: "selected",
    target,
    context: selectedContext,
    ignoredTargetIds: input.targets
      .filter((candidate) => candidate.id !== target.id)
      .map((candidate) => candidate.id),
  };
}
