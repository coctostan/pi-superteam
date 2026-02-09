/**
 * Failure taxonomy — codified failure types, default actions, and resolution.
 *
 * Used by execute phase to determine how to handle each type of failure.
 * Users can override defaults per-type in their config.
 */

export type FailureType =
  | "parse-error"
  | "test-regression"
  | "test-flake"
  | "test-preexisting"
  | "tool-timeout"
  | "budget-threshold"
  | "review-max-retries"
  | "validation-failure"
  | "impl-crash";

export type FailureAction =
  | "auto-retry"
  | "warn-continue"
  | "ignore"
  | "stop-show-diff"
  | "retry-then-escalate"
  | "checkpoint"
  | "escalate";

export const DEFAULT_FAILURE_ACTIONS: Record<FailureType, FailureAction> = {
  "parse-error": "auto-retry",
  "test-regression": "stop-show-diff",
  "test-flake": "warn-continue",
  "test-preexisting": "ignore",
  "tool-timeout": "retry-then-escalate",
  "budget-threshold": "checkpoint",
  "review-max-retries": "escalate",
  "validation-failure": "retry-then-escalate",
  "impl-crash": "retry-then-escalate",
};

/** Given a failure type, return the action to take. Supports per-type overrides. */
export function resolveFailureAction(
  type: FailureType,
  overrides?: Partial<Record<FailureType, FailureAction>>,
): FailureAction {
  if (overrides && type in overrides) {
    return overrides[type]!;
  }
  return DEFAULT_FAILURE_ACTIONS[type];
}
