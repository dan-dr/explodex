/**
 * Type-only public description of the generated runtime artifact.
 * The value export path resolves to the classic-script IIFE.
 */

import type { PluginLogger } from "../types/runtime-api.ts";
import type {
  PluginReviewRequest,
  ReviewOutcome,
} from "./plugin-review.ts";

export type ExplodexRuntime = {
  readonly version: string;
  readonly log: PluginLogger;
  readonly review: {
    open(request: PluginReviewRequest): Promise<ReviewOutcome>;
    cancel(reason?: string): void;
    cancelExact(
      operationId: string,
      callbackName: string,
      reason?: string,
    ): boolean;
  };
  destroy(options?: { reason?: string }): void;
};
