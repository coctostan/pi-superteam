// src/workflow/ui.test.ts
import { describe, it, expect } from "vitest";
import {
  formatStatus,
  formatToolAction,
  formatTaskProgress,
  createActivityBuffer,
} from "./ui.js";

describe("formatStatus", () => {
  it("formats brainstorm phase with sub-step and cost", () => {
    const state = { phase: "brainstorm", brainstorm: { step: "questions" }, totalCostUsd: 0.42, tasks: [], currentTaskIndex: 0 } as any;
    const status = formatStatus(state);
    expect(status).toContain("brainstorm");
    expect(status).toContain("questions");
    expect(status).toContain("$0.42");
  });

  it("formats execute phase with task progress", () => {
    const state = {
      phase: "execute",
      tasks: [{}, {}, { status: "implementing" }, {}, {}],
      currentTaskIndex: 2,
      totalCostUsd: 4.18,
    } as any;
    const status = formatStatus(state);
    expect(status).toContain("execute");
    expect(status).toContain("task 3/5");
    expect(status).toContain("$4.18");
  });
});

describe("formatToolAction", () => {
  it("formats read action with path", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
    expect(result).toContain("read");
    expect(result).toContain("src/index.ts");
  });

  it("formats bash action with command snippet", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "bash", args: { command: "vitest run auth" } });
    expect(result).toContain("vitest run auth");
  });

  it("formats write action with path", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "write", args: { path: "src/auth.ts" } });
    expect(result).toContain("write");
    expect(result).toContain("src/auth.ts");
  });

  it("formats edit action with path", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "edit", args: { path: "src/auth.ts" } });
    expect(result).toContain("edit");
    expect(result).toContain("src/auth.ts");
  });

  it("formats grep action with pattern", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "grep", args: { pattern: "authenticate" } });
    expect(result).toContain("grep");
    expect(result).toContain("authenticate");
  });

  it("truncates long bash commands", () => {
    const longCmd = "a".repeat(200);
    const result = formatToolAction({ type: "tool_execution_start", toolName: "bash", args: { command: longCmd } });
    expect(result.length).toBeLessThan(150);
  });
});

describe("formatTaskProgress", () => {
  it("generates widget lines with status markers", () => {
    const tasks = [
      { id: 1, title: "Create model", status: "complete" },
      { id: 2, title: "Add routes", status: "implementing" },
      { id: 3, title: "Add tests", status: "pending" },
    ] as any[];
    const lines = formatTaskProgress(tasks, 1);
    expect(lines.some((l: string) => l.includes("✓") && l.includes("Create model"))).toBe(true);
    expect(lines.some((l: string) => l.includes("▸") && l.includes("Add routes"))).toBe(true);
    expect(lines.some((l: string) => l.includes("○") && l.includes("Add tests"))).toBe(true);
  });
});

describe("createActivityBuffer", () => {
  it("maintains a ring buffer of max size", () => {
    const buffer = createActivityBuffer(3);
    buffer.push("line 1");
    buffer.push("line 2");
    buffer.push("line 3");
    buffer.push("line 4");
    expect(buffer.lines()).toEqual(["line 2", "line 3", "line 4"]);
  });

  it("returns all lines when under max", () => {
    const buffer = createActivityBuffer(5);
    buffer.push("a");
    buffer.push("b");
    expect(buffer.lines()).toEqual(["a", "b"]);
  });
});
