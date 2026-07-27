/**
 * Type-only public description of the generated runtime artifact.
 * The value export path resolves to the classic-script IIFE.
 */

import type { PluginLogger } from "../types/runtime-api.ts";
import type {
  PluginReviewRequest,
  PluginUpdateReviewRequest,
  ReviewOutcome,
} from "./plugin-review.ts";
import type {
  PluginManagementFailure,
  PluginManagementModel,
  PluginManagementRequest,
} from "./plugin-management.ts";

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
  readonly updates: {
    open(request: PluginUpdateReviewRequest): Promise<ReviewOutcome>;
    cancel(reason?: string): void;
    cancelExact(
      operationId: string,
      callbackName: string,
      reason?: string,
    ): boolean;
  };
  readonly management: {
    open(
      request: PluginManagementRequest,
    ): PluginManagementModel | PluginManagementFailure;
    close(): void;
  };
  destroy(options?: { reason?: string }): void;
};
