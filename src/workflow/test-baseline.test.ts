import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  classifyFailures,
  captureBaseline,
  type TestBaseline,
  type ClassifiedResults,
} from "./test-baseline.js";
import type { TestResult } from "./test-output-parser.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFileCb);

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

describe("captureBaseline (integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-int-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function initGitRepo(dir: string) {
    await run("git", ["init"], { cwd: dir });
    await run("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    await run("git", ["config", "user.name", "Test"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "dummy.txt"), "x");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "init"], { cwd: dir });
  }

  it("captures baseline from a command that outputs test-like lines", async () => {
    const script = path.join(tmpDir, "fake-test.sh");
    fs.writeFileSync(script, [
      "#!/bin/bash",
      'echo " ✓ test-a > passes (1ms)"',
      'echo " ✗ test-b > fails (2ms)"',
      'echo "   → expected 1, got 2"',
      "exit 1",
    ].join("\n"), { mode: 0o755 });

    await initGitRepo(tmpDir);

    const baseline = await captureBaseline(`bash ${script}`, tmpDir);

    expect(baseline.sha).toBeTruthy();
    expect(baseline.command).toBe(`bash ${script}`);
    expect(baseline.results).toHaveLength(2);
    expect(baseline.results[0].name).toBe("test-a > passes");
    expect(baseline.results[0].passed).toBe(true);
    expect(baseline.results[1].name).toBe("test-b > fails");
    expect(baseline.results[1].passed).toBe(false);
    expect(baseline.knownFailures).toEqual(["test-b > fails"]);
  });

  it("returns empty results for unparseable output", async () => {
    await initGitRepo(tmpDir);

    const baseline = await captureBaseline("echo 'no test output'", tmpDir);

    expect(baseline.results).toEqual([]);
    expect(baseline.knownFailures).toEqual([]);
  });
});
