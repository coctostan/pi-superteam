import { describe, it, expect } from "vitest";
import {
  resolveFailureAction,
  DEFAULT_FAILURE_ACTIONS,
  type FailureType,
  type FailureAction,
} from "./failure-taxonomy.js";

describe("DEFAULT_FAILURE_ACTIONS", () => {
  it("maps every FailureType to a FailureAction", () => {
    const expectedTypes: FailureType[] = [
      "parse-error",
      "test-regression",
      "test-flake",
      "test-preexisting",
      "tool-timeout",
      "budget-threshold",
      "review-max-retries",
      "validation-failure",
      "impl-crash",
    ];
    for (const ft of expectedTypes) {
      expect(DEFAULT_FAILURE_ACTIONS[ft]).toBeDefined();
    }
  });

  it("test-regression defaults to stop-show-diff", () => {
    expect(DEFAULT_FAILURE_ACTIONS["test-regression"]).toBe("stop-show-diff");
  });

  it("test-flake defaults to warn-continue", () => {
    expect(DEFAULT_FAILURE_ACTIONS["test-flake"]).toBe("warn-continue");
  });

  it("test-preexisting defaults to ignore", () => {
    expect(DEFAULT_FAILURE_ACTIONS["test-preexisting"]).toBe("ignore");
  });

  it("parse-error defaults to auto-retry", () => {
    expect(DEFAULT_FAILURE_ACTIONS["parse-error"]).toBe("auto-retry");
  });

  it("budget-threshold defaults to checkpoint", () => {
    expect(DEFAULT_FAILURE_ACTIONS["budget-threshold"]).toBe("checkpoint");
  });
});

describe("resolveFailureAction", () => {
  it("returns default action when no overrides", () => {
    expect(resolveFailureAction("test-flake")).toBe("warn-continue");
  });

  it("returns default action when overrides don't contain the type", () => {
    expect(resolveFailureAction("test-flake", { "parse-error": "escalate" })).toBe("warn-continue");
  });

  it("returns overridden action when override matches type", () => {
    expect(resolveFailureAction("test-flake", { "test-flake": "escalate" })).toBe("escalate");
  });

  it("returns overridden action for multiple overrides", () => {
    const overrides: Partial<Record<FailureType, FailureAction>> = {
      "test-regression": "auto-retry",
      "impl-crash": "escalate",
    };
    expect(resolveFailureAction("test-regression", overrides)).toBe("auto-retry");
    expect(resolveFailureAction("impl-crash", overrides)).toBe("escalate");
  });

  it("returns default when overrides is undefined", () => {
    expect(resolveFailureAction("validation-failure", undefined)).toBe("retry-then-escalate");
  });

  it("returns default when overrides is empty object", () => {
    expect(resolveFailureAction("tool-timeout", {})).toBe("retry-then-escalate");
  });
});
