import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createInitialState,
  saveState,
  loadState,
  clearState,
  type OrchestratorPhase,
  type OrchestratorConfig,
  type TaskExecState,
  type PendingInteraction,
  type OrchestratorState,
} from "./orchestrator-state.ts";

describe("orchestrator-state", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-state-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createInitialState", () => {
    it("creates state with plan-draft phase and given description", () => {
      const state = createInitialState("Build a REST API");
      expect(state.phase).toBe("plan-draft");
      expect(state.userDescription).toBe("Build a REST API");
    });

    it("sets startedAt to approximately now", () => {
      const before = Date.now();
      const state = createInitialState("test");
      const after = Date.now();
      expect(state.startedAt).toBeGreaterThanOrEqual(before);
      expect(state.startedAt).toBeLessThanOrEqual(after);
    });

    it("sets config defaults", () => {
      const state = createInitialState("test");
      expect(state.config.tddMode).toBe("tdd");
      expect(state.config.maxPlanReviewCycles).toBe(3);
      expect(state.config.maxTaskReviewCycles).toBe(3);
    });

    it("initializes empty tasks and zero counters", () => {
      const state = createInitialState("test");
      expect(state.tasks).toEqual([]);
      expect(state.currentTaskIndex).toBe(0);
      expect(state.planReviewCycles).toBe(0);
      expect(state.totalCostUsd).toBe(0);
    });

    it("has no optional fields set", () => {
      const state = createInitialState("test");
      expect(state.planPath).toBeUndefined();
      expect(state.planContent).toBeUndefined();
      expect(state.pendingInteraction).toBeUndefined();
      expect(state.error).toBeUndefined();
    });
  });

  describe("saveState and loadState", () => {
    it("round-trips state through save and load", () => {
      const state = createInitialState("my project");
      saveState(state, tmpDir);
      const loaded = loadState(tmpDir);
      expect(loaded).toEqual(state);
    });

    it("writes to .superteam-workflow.json", () => {
      const state = createInitialState("test");
      saveState(state, tmpDir);
      const filePath = path.join(tmpDir, ".superteam-workflow.json");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("saves atomically via tmp file (no leftover tmp)", () => {
      const state = createInitialState("test");
      saveState(state, tmpDir);
      const files = fs.readdirSync(tmpDir);
      expect(files).toEqual([".superteam-workflow.json"]);
    });

    it("overwrites existing state", () => {
      const state1 = createInitialState("first");
      saveState(state1, tmpDir);

      const state2 = createInitialState("second");
      state2.phase = "execute";
      saveState(state2, tmpDir);

      const loaded = loadState(tmpDir);
      expect(loaded!.userDescription).toBe("second");
      expect(loaded!.phase).toBe("execute");
    });

    it("preserves all fields including optional ones", () => {
      const state = createInitialState("full test");
      state.planPath = "/some/plan.md";
      state.planContent = "# Plan\n- task 1";
      state.error = "something went wrong";
      state.pendingInteraction = {
        id: "pi-1",
        type: "choice",
        question: "Pick one",
        options: [
          { key: "a", label: "Option A", description: "First option" },
          { key: "b", label: "Option B" },
        ],
        default: "a",
      };
      state.tasks = [
        {
          id: 1,
          title: "Task one",
          description: "Do something",
          files: ["src/a.ts", "src/b.ts"],
          status: "implementing",
          reviewsPassed: ["lint"],
          reviewsFailed: ["types"],
          fixAttempts: 2,
          gitShaBeforeImpl: "abc123",
        },
      ];

      saveState(state, tmpDir);
      const loaded = loadState(tmpDir);
      expect(loaded).toEqual(state);
    });
  });

  describe("loadState", () => {
    it("returns null when file does not exist", () => {
      const result = loadState(tmpDir);
      expect(result).toBeNull();
    });

    it("returns null when file contains invalid JSON", () => {
      const filePath = path.join(tmpDir, ".superteam-workflow.json");
      fs.writeFileSync(filePath, "not json {{{");
      const result = loadState(tmpDir);
      expect(result).toBeNull();
    });
  });

  describe("clearState", () => {
    it("deletes the state file", () => {
      const state = createInitialState("test");
      saveState(state, tmpDir);
      clearState(tmpDir);
      const filePath = path.join(tmpDir, ".superteam-workflow.json");
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("does nothing if file does not exist", () => {
      // Should not throw
      expect(() => clearState(tmpDir)).not.toThrow();
    });
  });

  describe("type constraints", () => {
    it("OrchestratorPhase accepts valid values", () => {
      const phases: OrchestratorPhase[] = [
        "plan-draft",
        "plan-review",
        "configure",
        "execute",
        "finalize",
        "done",
      ];
      expect(phases).toHaveLength(6);
    });

    it("TaskExecState status accepts all valid values", () => {
      const statuses: TaskExecState["status"][] = [
        "pending",
        "implementing",
        "reviewing",
        "fixing",
        "complete",
        "skipped",
        "escalated",
      ];
      expect(statuses).toHaveLength(7);
    });

    it("PendingInteraction type accepts all valid values", () => {
      const types: PendingInteraction["type"][] = [
        "choice",
        "confirm",
        "input",
      ];
      expect(types).toHaveLength(3);
    });
  });
});
