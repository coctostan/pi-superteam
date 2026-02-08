/**
 * Test baseline — capture and classify test results against a known state.
 *
 * Captures which tests pass/fail before execute begins. During execution,
 * classifies failures as new regressions, pre-existing, or flake candidates.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { getCurrentSha } from "./git-utils.js";
import { parseTestOutput, type TestResult } from "./test-output-parser.js";

export type { TestResult };

const execFile = promisify(execFileCb);

export interface TestBaseline {
  capturedAt: number;
  sha: string;
  command: string;
  results: TestResult[];
  knownFailures: string[];
}

export interface ClassifiedResults {
  newFailures: TestResult[];
  preExisting: TestResult[];
  flakeCandidates: TestResult[];
  newPasses: TestResult[];
}

/** Compare current test run against baseline. Classify each failure. */
export function classifyFailures(
  current: TestResult[],
  baseline: TestBaseline,
): ClassifiedResults {
  const knownSet = new Set(baseline.knownFailures);

  const newFailures: TestResult[] = [];
  const preExisting: TestResult[] = [];
  const flakeCandidates: TestResult[] = [];
  const newPasses: TestResult[] = [];

  for (const result of current) {
    if (result.passed) {
      // Was it a known failure that now passes?
      if (knownSet.has(result.name)) {
        newPasses.push(result);
      }
      continue;
    }

    // result.passed === false
    if (knownSet.has(result.name)) {
      // Failed in baseline too
      preExisting.push(result);
    } else {
      // New failure — also a flake candidate for re-run
      newFailures.push(result);
      flakeCandidates.push(result);
    }
  }

  return { newFailures, preExisting, flakeCandidates, newPasses };
}

/** Run test command, parse output, return baseline. */
export async function captureBaseline(
  testCommand: string,
  cwd: string,
): Promise<TestBaseline> {
  const sha = await getCurrentSha(cwd);
  const capturedAt = Date.now();
  let stdout = "";
  let stderr = "";

  try {
    const result = await execFile("bash", ["-c", testCommand], {
      cwd,
      timeout: 120_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    // Test command may exit non-zero if some tests fail — that's expected
    stdout = err.stdout || "";
    stderr = err.stderr || "";
  }

  const combinedOutput = stdout + "\n" + stderr;
  const results = parseTestOutput(combinedOutput);
  const knownFailures = results.filter(r => !r.passed).map(r => r.name);

  return {
    capturedAt,
    sha,
    command: testCommand,
    results,
    knownFailures,
  };
}
