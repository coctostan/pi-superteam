import { describe, it, expect } from "vitest";
import { extractFencedBlock } from "./parse-utils.js";

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
