import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./test-baseline.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./test-baseline.js")>();
  return { ...orig, captureBaseline: vi.fn() };
});

import {
  runCrossTaskValidation,
  shouldRunValidation,
  type ValidationResult,
} from "./cross-task-validation.js";
import { captureBaseline, classifyFailures, type TestBaseline } from "./test-baseline.js";
import type { TestResult } from "./test-output-parser.js";

const mockCaptureBaseline = vi.mocked(captureBaseline);

function makeBaseline(overrides: Partial<TestBaseline> = {}): TestBaseline {
  return {
    capturedAt: Date.now(),
    sha: "abc123",
    command: "npx vitest run",
    results: [],
    knownFailures: [],
    ...overrides,
  };
}

function makeTestResult(name: string, passed: boolean): TestResult {
  return { name, passed };
}

describe("shouldRunValidation", () => {
  it("returns true when cadence is 'every'", () => {
    expect(shouldRunValidation("every", 1, 1)).toBe(true);
    expect(shouldRunValidation("every", 1, 5)).toBe(true);
  });

  it("returns true when cadence is 'every-N' and taskIndex is multiple of interval", () => {
    expect(shouldRunValidation("every-N", 3, 3)).toBe(true);
    expect(shouldRunValidation("every-N", 3, 6)).toBe(true);
  });

  it("returns false when cadence is 'every-N' and taskIndex is not multiple of interval", () => {
    expect(shouldRunValidation("every-N", 3, 1)).toBe(false);
    expect(shouldRunValidation("every-N", 3, 2)).toBe(false);
    expect(shouldRunValidation("every-N", 3, 4)).toBe(false);
  });

  it("returns false when cadence is 'on-demand'", () => {
    expect(shouldRunValidation("on-demand", 1, 1)).toBe(false);
    expect(shouldRunValidation("on-demand", 1, 5)).toBe(false);
  });
});

describe("runCrossTaskValidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns passed=true when no new failures", async () => {
    const baseline = makeBaseline({
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    // Current run: all pass
    mockCaptureBaseline.mockResolvedValue({
      ...baseline,
      capturedAt: Date.now(),
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    const result = await runCrossTaskValidation("npx vitest run", baseline, "/fake");
    expect(result.passed).toBe(true);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it("detects genuine regression (fails on re-run too)", async () => {
    const baseline = makeBaseline({
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    // First run: test-a fails. Re-run: test-a still fails.
    mockCaptureBaseline
      .mockResolvedValueOnce({
        ...baseline,
        capturedAt: Date.now(),
        results: [makeTestResult("test-a", false)],
        knownFailures: ["test-a"],
      })
      .mockResolvedValueOnce({
        ...baseline,
        capturedAt: Date.now(),
        results: [makeTestResult("test-a", false)],
        knownFailures: ["test-a"],
      });

    const result = await runCrossTaskValidation("npx vitest run", baseline, "/fake");
    expect(result.passed).toBe(false);
    expect(result.blockingFailures).toHaveLength(1);
    expect(result.blockingFailures[0].name).toBe("test-a");
    expect(result.flakyTests).toHaveLength(0);
  });

  it("detects flake (fails first run, passes re-run)", async () => {
    const baseline = makeBaseline({
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    // First run: test-a fails. Re-run: test-a passes.
    mockCaptureBaseline
      .mockResolvedValueOnce({
        ...baseline,
        capturedAt: Date.now(),
        results: [makeTestResult("test-a", false)],
        knownFailures: ["test-a"],
      })
      .mockResolvedValueOnce({
        ...baseline,
        capturedAt: Date.now(),
        results: [makeTestResult("test-a", true)],
        knownFailures: [],
      });

    const result = await runCrossTaskValidation("npx vitest run", baseline, "/fake");
    expect(result.passed).toBe(true);
    expect(result.flakyTests).toEqual(["test-a"]);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it("ignores pre-existing failures", async () => {
    const baseline = makeBaseline({
      results: [makeTestResult("test-a", false), makeTestResult("test-b", true)],
      knownFailures: ["test-a"],
    });

    // Current run: test-a still fails (pre-existing), test-b passes
    mockCaptureBaseline.mockResolvedValue({
      ...baseline,
      capturedAt: Date.now(),
      results: [makeTestResult("test-a", false), makeTestResult("test-b", true)],
      knownFailures: ["test-a"],
    });

    const result = await runCrossTaskValidation("npx vitest run", baseline, "/fake");
    expect(result.passed).toBe(true);
    expect(result.classified.preExisting).toHaveLength(1);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it("skips flake re-run when no flake candidates", async () => {
    const baseline = makeBaseline({
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    // All pass — no flake candidates
    mockCaptureBaseline.mockResolvedValue({
      ...baseline,
      capturedAt: Date.now(),
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    const result = await runCrossTaskValidation("npx vitest run", baseline, "/fake");
    expect(result.passed).toBe(true);
    // captureBaseline called only once (no re-run needed)
    expect(mockCaptureBaseline).toHaveBeenCalledTimes(1);
  });
});
