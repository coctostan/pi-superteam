import { describe, it, expect } from "vitest";
import { extractFencedBlock, extractLastBraceBlock, sanitizeJsonNewlines, stripAnsi } from "./parse-utils.js";


describe("extractFencedBlock", () => {
  it("extracts content from a superteam-brainstorm fenced block", () => {
    const text = 'Preamble\n```superteam-brainstorm\n{"type":"questions"}\n```\nAfter';
    expect(extractFencedBlock(text, "superteam-brainstorm")).toBe('{"type":"questions"}');
  });

  it("extracts content from a superteam-json fenced block", () => {
    const text = 'Review:\n```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```';
    expect(extractFencedBlock(text, "superteam-json")).toBe('{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}');
  });

  it("returns null when no matching fence found", () => {
    expect(extractFencedBlock("no fences here", "superteam-json")).toBeNull();
  });

  it("returns null when fence language doesn't match", () => {
    const text = '```superteam-brainstorm\n{"type":"questions"}\n```';
    expect(extractFencedBlock(text, "superteam-json")).toBeNull();
  });

  it("handles triple-backtick inside JSON string values (quote-aware)", () => {
    const json = JSON.stringify({ type: "design", sections: [{ id: "s1", title: "G", content: "Use ```code``` blocks." }] });
    const text = "```superteam-brainstorm\n" + json + "\n```";
    const result = extractFencedBlock(text, "superteam-brainstorm");
    expect(result).toBe(json);
  });

  it("handles literal newlines inside JSON string values", () => {
    const text = '```superteam-json\n{"passed":true,"summary":"line1\nline2","findings":[],"mustFix":[]}\n```';
    const result = extractFencedBlock(text, "superteam-json");
    expect(result).toContain("line1\nline2");
  });

  it("handles opening fence with leading whitespace (up to 3 spaces)", () => {
    const text = '   ```superteam-json\n{"passed":true}\n```';
    expect(extractFencedBlock(text, "superteam-json")).toBe('{"passed":true}');
  });

  it("returns null when closing fence is missing", () => {
    const text = '```superteam-json\n{"passed":true}';
    expect(extractFencedBlock(text, "superteam-json")).toBeNull();
  });

  it("returns empty string for empty fenced block", () => {
    const text = '```superteam-json\n\n```';
    expect(extractFencedBlock(text, "superteam-json")).toBe("");
  });
});

describe("extractLastBraceBlock", () => {
  it("extracts the last top-level JSON object", () => {
    const text = 'text {"a":1} more text {"b":2}';
    expect(extractLastBraceBlock(text)).toBe('{"b":2}');
  });

  it("returns null when no braces found", () => {
    expect(extractLastBraceBlock("no json here")).toBeNull();
  });

  it("handles nested braces", () => {
    const text = '{"outer":{"inner":1}}';
    expect(extractLastBraceBlock(text)).toBe('{"outer":{"inner":1}}');
  });

  it("handles braces inside string values", () => {
    const text = '{"text":"has {braces} inside"}';
    expect(extractLastBraceBlock(text)).toBe('{"text":"has {braces} inside"}');
  });

  it("handles escaped quotes inside strings", () => {
    const text = '{"text":"say \\"hi\\""}';
    expect(extractLastBraceBlock(text)).toBe('{"text":"say \\"hi\\""}');
  });

  it("returns null for unbalanced braces", () => {
    expect(extractLastBraceBlock("{unclosed")).toBeNull();
  });
});

describe("sanitizeJsonNewlines", () => {
  it("returns unchanged string when no literal newlines in JSON strings", () => {
    expect(sanitizeJsonNewlines('{"a":"hello"}')).toBe('{"a":"hello"}');
  });

  it("replaces literal newline inside a JSON string with escaped \\n", () => {
    expect(sanitizeJsonNewlines('{"a":"x\ny"}')).toBe('{"a":"x\\ny"}');
  });

  it("does not replace newlines outside of JSON strings", () => {
    const input = '{\n"a": "hello"\n}';
    expect(sanitizeJsonNewlines(input)).toBe(input);
  });

  it("handles escaped quotes correctly", () => {
    const input = '{"text":"say \\"hi\\"\\nbye"}';
    expect(sanitizeJsonNewlines(input)).toBe(input);
  });

  it("handles multiple literal newlines in multiple strings", () => {
    expect(sanitizeJsonNewlines('{"a":"x\ny","b":"p\nq"}')).toBe('{"a":"x\\ny","b":"p\\nq"}');
  });
});

describe("stripAnsi", () => {
  it("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("strips basic color codes (e.g., red)", () => {
    expect(stripAnsi("\x1b[31mred text\x1b[0m")).toBe("red text");
  });

  it("strips bold/bright codes", () => {
    expect(stripAnsi("\x1b[1m\x1b[32mbold green\x1b[0m")).toBe("bold green");
  });

  it("strips multiple ANSI codes in a string", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m and \x1b[34mblue\x1b[0m")).toBe("red and blue");
  });

  it("strips 256-color codes", () => {
    expect(stripAnsi("\x1b[38;5;196mcolor\x1b[0m")).toBe("color");
  });

  it("strips 24-bit RGB color codes", () => {
    expect(stripAnsi("\x1b[38;2;255;0;0mrgb\x1b[0m")).toBe("rgb");
  });

  it("preserves JSON structure with ANSI codes stripped", () => {
    const input = '\x1b[1m```superteam-json\x1b[0m\n{"passed":true}\n\x1b[1m```\x1b[0m';
    const result = stripAnsi(input);
    expect(result).toBe('```superteam-json\n{"passed":true}\n```');
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2Jhello\x1b[H")).toBe("hello");
  });
});
