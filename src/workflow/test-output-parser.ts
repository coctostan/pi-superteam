/**
 * Test output parser — extract individual test results from CLI output.
 *
 * Supports vitest/jest (✓/✗) and bun test (✓/×) output formats.
 * Falls back to empty array if output is unparseable.
 */

export interface TestResult {
  name: string;
  passed: boolean;
  duration?: number;
  output?: string;
}

// Match: " ✓ test name (Nms)" or " ✗ test name (Nms)" or " × test name (Nms)"
const TEST_LINE_RE = /^\s*([✓✗×])\s+(.+?)(?:\s+\((\d+)ms\))?\s*$/;
// Match: "   → error text"
const ERROR_LINE_RE = /^\s+→\s+(.+)$/;

export function parseTestOutput(output: string): TestResult[] {
  const lines = output.split("\n");
  const results: TestResult[] = [];
  let currentFailOutput: string[] = [];
  let lastResult: TestResult | null = null;

  function flushFailOutput() {
    if (lastResult && !lastResult.passed && currentFailOutput.length > 0) {
      lastResult.output = currentFailOutput.join("\n");
    }
    currentFailOutput = [];
  }

  for (const line of lines) {
    const testMatch = line.match(TEST_LINE_RE);
    if (testMatch) {
      flushFailOutput();
      const [, marker, name, durationStr] = testMatch;
      const passed = marker === "✓";
      const result: TestResult = {
        name: name.trim(),
        passed,
        ...(durationStr ? { duration: parseInt(durationStr, 10) } : {}),
      };
      results.push(result);
      lastResult = result;
      continue;
    }

    const errorMatch = line.match(ERROR_LINE_RE);
    if (errorMatch && lastResult && !lastResult.passed) {
      currentFailOutput.push(errorMatch[1]);
    }
  }

  flushFailOutput();
  return results;
}
