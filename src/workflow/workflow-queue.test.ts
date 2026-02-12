// src/workflow/workflow-queue.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { enqueueWorkflow, dequeueWorkflow, peekQueue, clearQueue, type QueuedWorkflow } from "./workflow-queue.ts";

describe("workflow-queue", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfqueue-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enqueue adds an item and peek returns it", () => {
    enqueueWorkflow(tmpDir, { title: "API endpoint", description: "New REST endpoint" });
    const items = peekQueue(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("API endpoint");
    expect(items[0].description).toBe("New REST endpoint");
  });

  it("enqueue multiple items maintains order", () => {
    enqueueWorkflow(tmpDir, { title: "First", description: "D1" });
    enqueueWorkflow(tmpDir, { title: "Second", description: "D2" });
    const items = peekQueue(tmpDir);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("First");
    expect(items[1].title).toBe("Second");
  });

  it("dequeue returns and removes the first item", () => {
    enqueueWorkflow(tmpDir, { title: "First", description: "D1" });
    enqueueWorkflow(tmpDir, { title: "Second", description: "D2" });

    const item = dequeueWorkflow(tmpDir);
    expect(item).toBeDefined();
    expect(item!.title).toBe("First");

    const remaining = peekQueue(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe("Second");
  });

  it("dequeue from empty queue returns undefined", () => {
    const item = dequeueWorkflow(tmpDir);
    expect(item).toBeUndefined();
  });

  it("clearQueue removes all items", () => {
    enqueueWorkflow(tmpDir, { title: "T1", description: "D1" });
    enqueueWorkflow(tmpDir, { title: "T2", description: "D2" });
    clearQueue(tmpDir);
    expect(peekQueue(tmpDir)).toHaveLength(0);
  });

  it("peekQueue returns empty array for non-existent queue", () => {
    expect(peekQueue(tmpDir)).toHaveLength(0);
  });

  it("round-trips through file system", () => {
    enqueueWorkflow(tmpDir, { title: "T1", description: "D1", parentScoutOutput: "scout data" });
    // Re-read from disk
    const items = peekQueue(tmpDir);
    expect(items[0].parentScoutOutput).toBe("scout data");
  });
});
