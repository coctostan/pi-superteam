// src/workflow/docs.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

describe("documentation completeness", () => {
  it("README mentions brainstorm phase", () => {
    const readme = fs.readFileSync("README.md", "utf-8");
    expect(readme).toContain("brainstorm");
  });

  it("workflow guide exists and covers all phases", () => {
    const guide = fs.readFileSync("docs/guides/workflow.md", "utf-8");
    expect(guide).toContain("Brainstorm");
    expect(guide).toContain("Plan");
    expect(guide).toContain("Review");
    expect(guide).toContain("Configure");
    expect(guide).toContain("Execute");
    expect(guide).toContain("Finalize");
  });

  it("workflow guide documents brainstormer and planner agents", () => {
    const guide = fs.readFileSync("docs/guides/workflow.md", "utf-8");
    expect(guide).toContain("brainstormer");
    expect(guide).toContain("planner");
  });

  it("workflow guide documents /workflow command", () => {
    const guide = fs.readFileSync("docs/guides/workflow.md", "utf-8");
    expect(guide).toContain("/workflow");
    expect(guide).toContain("status");
    expect(guide).toContain("abort");
  });

  it("workflow guide documents progress file and streaming activity", () => {
    const guide = fs.readFileSync("docs/guides/workflow.md", "utf-8");
    expect(guide).toContain("progress");
    expect(guide).toContain("activity");
  });
});
