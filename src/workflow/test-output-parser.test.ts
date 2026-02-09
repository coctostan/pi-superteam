import { describe, it, expect } from "vitest";
import { parseTestOutput, type TestResult } from "./test-output-parser.js";

describe("parseTestOutput", () => {
  it("parses vitest/jest passing test lines", () => {
    const output = [
      " ✓ src/a.test.ts > describe > adds numbers (2ms)",
      " ✓ src/a.test.ts > describe > subtracts numbers (1ms)",
    ].join("\n");
    const results = parseTestOutput(output);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      name: "src/a.test.ts > describe > adds numbers",
      passed: true,
      duration: 2,
    });
    expect(results[1]).toEqual({
      name: "src/a.test.ts > describe > subtracts numbers",
      passed: true,
      duration: 1,
    });
  });

  it("parses vitest/jest failing test lines", () => {
    const output = [
      " ✗ src/b.test.ts > fails gracefully (3ms)",
      "   → expected true, got false",
    ].join("\n");
    const results = parseTestOutput(output);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      name: "src/b.test.ts > fails gracefully",
      passed: false,
      duration: 3,
      output: "expected true, got false",
    });
  });

  it("parses × as failure marker (bun test style)", () => {
    const output = " × src/c.test.ts > broken (1ms)\n   → assertion failed";
    const results = parseTestOutput(output);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].name).toBe("src/c.test.ts > broken");
  });

  it("handles mixed pass and fail", () => {
    const output = [
      " ✓ src/a.test.ts > passes (1ms)",
      " ✗ src/b.test.ts > fails (2ms)",
      "   → error details",
      " ✓ src/c.test.ts > also passes (0ms)",
    ].join("\n");
    const results = parseTestOutput(output);
    expect(results).toHaveLength(3);
    expect(results.filter(r => r.passed)).toHaveLength(2);
    expect(results.filter(r => !r.passed)).toHaveLength(1);
  });

  it("returns empty array for unparseable output", () => {
    const output = "some random text\nno test markers here";
    const results = parseTestOutput(output);
    expect(results).toEqual([]);
  });

  it("handles duration without ms suffix", () => {
    const output = " ✓ src/a.test.ts > fast";
    const results = parseTestOutput(output);
    expect(results).toHaveLength(1);
    expect(results[0].duration).toBeUndefined();
  });

  it("strips ANSI color codes before parsing", () => {
    const output = " \x1b[32m✓\x1b[39m src/a.test.ts > works (2ms)\n \x1b[31m✗\x1b[39m src/b.test.ts > fails (1ms)\n   → \x1b[31merror msg\x1b[39m";
    const results = parseTestOutput(output);
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[0].name).toBe("src/a.test.ts > works");
    expect(results[1].passed).toBe(false);
    expect(results[1].output).toBe("error msg");
  });

  it("captures multi-line failure output up to next test line", () => {
    const output = [
      " ✗ src/x.test.ts > complex fail (5ms)",
      "   → line 1 of error",
      "   → line 2 of error",
      " ✓ src/y.test.ts > next test (1ms)",
    ].join("\n");
    const results = parseTestOutput(output);
    expect(results).toHaveLength(2);
    expect(results[0].output).toContain("line 1 of error");
    expect(results[0].output).toContain("line 2 of error");
  });
});
