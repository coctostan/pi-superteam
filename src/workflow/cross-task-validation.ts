/**
 * Cross-task validation — run full test suite after task completion,
 * classify failures against baseline, detect flakes via re-run.
 */

import { captureBaseline, classifyFailures, type TestBaseline, type ClassifiedResults } from "./test-baseline.js";
import type { TestResult } from "./test-output-parser.js";

export type { ClassifiedResults };

export interface ValidationResult {
  passed: boolean;
  classified: ClassifiedResults;
  flakyTests: string[];
  blockingFailures: TestResult[];
}

/** Determine whether to run cross-task validation based on cadence config. */
export function shouldRunValidation(
  cadence: "every" | "every-N" | "on-demand",
  interval: number,
  completedTaskCount: number,
): boolean {
  if (cadence === "every") return true;
  if (cadence === "on-demand") return false;
  // "every-N"
  return completedTaskCount > 0 && completedTaskCount % interval === 0;
}

/** Run full test suite, classify against baseline, detect flakes. */
export async function runCrossTaskValidation(
  testCommand: string,
  baseline: TestBaseline,
  cwd: string,
): Promise<ValidationResult> {
  // 1. Run the test suite
  const currentRun = await captureBaseline(testCommand, cwd);

  // 2. Classify against baseline
  const classified = classifyFailures(currentRun.results, baseline);

  // 3. If no new failures, we're done
  if (classified.flakeCandidates.length === 0) {
    return {
      passed: true,
      classified,
      flakyTests: [],
      blockingFailures: [],
    };
  }

  // 4. Re-run to detect flakes
  const rerun = await captureBaseline(testCommand, cwd);
  const rerunResults = new Map<string, boolean>();
  for (const r of rerun.results) {
    rerunResults.set(r.name, r.passed);
  }

  const flakyTests: string[] = [];
  const blockingFailures: TestResult[] = [];

  for (const candidate of classified.flakeCandidates) {
    const passedOnRerun = rerunResults.get(candidate.name) ?? false;
    if (passedOnRerun) {
      flakyTests.push(candidate.name);
    } else {
      blockingFailures.push(candidate);
    }
  }

  return {
    passed: blockingFailures.length === 0,
    classified,
    flakyTests,
    blockingFailures,
  };
}
