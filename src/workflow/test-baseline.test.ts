import { describe, it, expect } from "vitest";
import {
  classifyFailures,
  type TestBaseline,
  type ClassifiedResults,
} from "./test-baseline.js";
import type { TestResult } from "./test-output-parser.js";

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

function makeResult(name: string, passed: boolean): TestResult {
  return { name, passed };
}

describe("classifyFailures", () => {
  it("classifies new failures (passed in baseline, fail now) as newFailures", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", true), makeResult("test-b", true)],
      knownFailures: [],
    });
    const current: TestResult[] = [
      makeResult("test-a", true),
      makeResult("test-b", false),
    ];
    const classified = classifyFailures(current, baseline);
    expect(classified.newFailures).toHaveLength(1);
    expect(classified.newFailures[0].name).toBe("test-b");
  });

  it("classifies pre-existing failures (failed in baseline too) as preExisting", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", false)],
      knownFailures: ["test-a"],
    });
    const current: TestResult[] = [makeResult("test-a", false)];
    const classified = classifyFailures(current, baseline);
    expect(classified.preExisting).toHaveLength(1);
    expect(classified.preExisting[0].name).toBe("test-a");
    expect(classified.newFailures).toHaveLength(0);
  });

  it("classifies new passes (failed in baseline, pass now) as newPasses", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", false)],
      knownFailures: ["test-a"],
    });
    const current: TestResult[] = [makeResult("test-a", true)];
    const classified = classifyFailures(current, baseline);
    expect(classified.newPasses).toHaveLength(1);
    expect(classified.newPasses[0].name).toBe("test-a");
  });

  it("marks new failures as flake candidates", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", true)],
      knownFailures: [],
    });
    const current: TestResult[] = [makeResult("test-a", false)];
    const classified = classifyFailures(current, baseline);
    expect(classified.flakeCandidates).toHaveLength(1);
    expect(classified.flakeCandidates[0].name).toBe("test-a");
  });

  it("handles empty baseline (all current failures are new)", () => {
    const baseline = makeBaseline({ results: [], knownFailures: [] });
    const current: TestResult[] = [makeResult("test-a", false)];
    const classified = classifyFailures(current, baseline);
    expect(classified.newFailures).toHaveLength(1);
    expect(classified.flakeCandidates).toHaveLength(1);
  });

  it("handles empty current results", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", true)],
      knownFailures: [],
    });
    const classified = classifyFailures([], baseline);
    expect(classified.newFailures).toHaveLength(0);
    expect(classified.preExisting).toHaveLength(0);
    expect(classified.newPasses).toHaveLength(0);
    expect(classified.flakeCandidates).toHaveLength(0);
  });

  it("handles tests not in baseline (new tests that fail are new failures)", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", true)],
      knownFailures: [],
    });
    const current: TestResult[] = [
      makeResult("test-a", true),
      makeResult("test-new", false),
    ];
    const classified = classifyFailures(current, baseline);
    expect(classified.newFailures).toHaveLength(1);
    expect(classified.newFailures[0].name).toBe("test-new");
  });

  it("handles complex mixed scenario", () => {
    const baseline = makeBaseline({
      results: [
        makeResult("passes-stays", true),
        makeResult("passes-regresses", true),
        makeResult("fails-stays", false),
        makeResult("fails-fixed", false),
      ],
      knownFailures: ["fails-stays", "fails-fixed"],
    });
    const current: TestResult[] = [
      makeResult("passes-stays", true),
      makeResult("passes-regresses", false),
      makeResult("fails-stays", false),
      makeResult("fails-fixed", true),
    ];
    const classified = classifyFailures(current, baseline);
    expect(classified.newFailures.map(r => r.name)).toEqual(["passes-regresses"]);
    expect(classified.preExisting.map(r => r.name)).toEqual(["fails-stays"]);
    expect(classified.newPasses.map(r => r.name)).toEqual(["fails-fixed"]);
    expect(classified.flakeCandidates.map(r => r.name)).toEqual(["passes-regresses"]);
  });
});
