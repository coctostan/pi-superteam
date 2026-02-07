import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// Mock child_process.spawn to emit controlled JSON lines
vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from "node:child_process";
import type { StreamEvent, OnStreamEvent } from "./dispatch.js";

const mockSpawn = vi.mocked(spawn);

function createFakeProcess(jsonLines: string[]) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: null,
    pid: 1234,
    killed: false,
    kill: vi.fn(),
  });

  // Use setImmediate so events fire after listeners are attached
  setImmediate(() => {
    for (const line of jsonLines) {
      stdout.push(line + "\n");
    }
    stdout.push(null);
    proc.emit("close", 0);
  });

  return proc;
}

describe("onStreamEvent callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires for tool_execution_start events with toolName and args", async () => {
    const events: StreamEvent[] = [];
    const onStreamEvent: OnStreamEvent = (e) => events.push(e);

    const jsonLines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read", args: { path: "src/index.ts" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "tc1", toolName: "read", result: "file contents", isError: false }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 10, output: 5, cost: { total: 0.01 } } } }),
    ];

    // Use mockImplementation so process is created fresh on each spawn() call
    mockSpawn.mockImplementation(() => createFakeProcess(jsonLines) as any);

    const { dispatchAgent } = await import("./dispatch.js");
    const agent = { name: "test", description: "test", systemPrompt: "", source: "package" as const, filePath: "/test.md", tools: ["read"] };
    await dispatchAgent(agent, "test task", "/tmp", undefined, undefined, onStreamEvent);

    const starts = events.filter(e => e.type === "tool_execution_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].toolName).toBe("read");
    expect(starts[0].args).toEqual({ path: "src/index.ts" });

    const ends = events.filter(e => e.type === "tool_execution_end");
    expect(ends).toHaveLength(1);
    expect(ends[0].isError).toBe(false);
  });

  it("fires for tool_execution_update events with partial results", async () => {
    const events: StreamEvent[] = [];

    const jsonLines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "npm test" } }),
      JSON.stringify({ type: "tool_execution_update", toolCallId: "tc1", toolName: "bash", args: { command: "npm test" }, partialResult: "PASS 3/3" }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: "PASS", isError: false }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 10, output: 5, cost: { total: 0.01 } } } }),
    ];

    mockSpawn.mockImplementation(() => createFakeProcess(jsonLines) as any);

    const { dispatchAgent } = await import("./dispatch.js");
    const agent = { name: "test", description: "test", systemPrompt: "", source: "package" as const, filePath: "/test.md", tools: ["bash"] };
    await dispatchAgent(agent, "test", "/tmp", undefined, undefined, (e) => events.push(e));

    const updates = events.filter(e => e.type === "tool_execution_update");
    expect(updates).toHaveLength(1);
    expect(updates[0].partialResult).toBe("PASS 3/3");
  });

  it("StreamEvent type exports compile correctly", async () => {
    const start: StreamEvent = { type: "tool_execution_start", toolName: "read", args: { path: "x" } };
    const update: StreamEvent = { type: "tool_execution_update", toolName: "bash", partialResult: "partial" };
    const end: StreamEvent = { type: "tool_execution_end", toolName: "write", isError: false };
    expect(start.type).toBe("tool_execution_start");
    expect(update.type).toBe("tool_execution_update");
    expect(end.type).toBe("tool_execution_end");
  });
});
