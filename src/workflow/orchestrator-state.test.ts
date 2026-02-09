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
  type BrainstormState,
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
    it("creates state with brainstorm phase and given description", () => {
      const state = createInitialState("Build a REST API");
      expect(state.phase).toBe("brainstorm");
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
      expect(state.error).toBeUndefined();
    });

    it("does not set gitStartingSha or gitBranch", () => {
      const state = createInitialState("test");
      expect(state.gitStartingSha).toBeUndefined();
      expect(state.gitBranch).toBeUndefined();
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
        "brainstorm",
        "plan-write",
        "plan-draft",
        "plan-review",
        "configure",
        "execute",
        "finalize",
        "done",
      ];
      expect(phases).toHaveLength(8);
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

  describe("TaskExecState summary field", () => {
    it("TaskExecState accepts optional summary with title, status, changedFiles", () => {
      const task: TaskExecState = {
        id: 1,
        title: "Task 1",
        description: "Do something",
        files: ["src/a.ts"],
        status: "complete",
        reviewsPassed: ["spec"],
        reviewsFailed: [],
        fixAttempts: 0,
        summary: {
          title: "Task 1",
          status: "complete",
          changedFiles: ["src/a.ts", "src/a.test.ts"],
        },
      };
      expect(task.summary).toBeDefined();
      expect(task.summary!.changedFiles).toHaveLength(2);
    });

    it("summary is optional — existing tasks without summary still work", () => {
      const task: TaskExecState = {
        id: 1, title: "T", description: "D", files: ["a.ts"],
        status: "pending", reviewsPassed: [], reviewsFailed: [], fixAttempts: 0,
      };
      expect(task.summary).toBeUndefined();
    });
  });

  describe("testBaseline state field", () => {
    it("OrchestratorState accepts optional testBaseline", () => {
      const state = createInitialState("test");
      expect(state.testBaseline).toBeUndefined();
    });

    it("testBaseline round-trips through save/load", () => {
      const state = createInitialState("test");
      state.testBaseline = {
        capturedAt: 1700000000000,
        sha: "abc123",
        command: "npx vitest run",
        results: [
          { name: "test-a", passed: true, duration: 5 },
          { name: "test-b", passed: false, output: "error" },
        ],
        knownFailures: ["test-b"],
      };
      saveState(state, tmpDir);
      const loaded = loadState(tmpDir);
      expect(loaded!.testBaseline).toBeDefined();
      expect(loaded!.testBaseline!.knownFailures).toEqual(["test-b"]);
      expect(loaded!.testBaseline!.results).toHaveLength(2);
    });

    it("missing testBaseline in loaded state defaults to undefined", () => {
      const state = createInitialState("test");
      saveState(state, tmpDir);
      const loaded = loadState(tmpDir);
      expect(loaded!.testBaseline).toBeUndefined();
    });
  });

  describe("conversationLog and complexityLevel", () => {
    it("BrainstormState accepts conversationLog entries", () => {
      const bs: BrainstormState = {
        step: "scout",
        conversationLog: [
          { role: "brainstormer", step: "questions", content: "Here are my questions" },
          { role: "user", step: "questions", content: "Question 2 doesn't apply" },
        ],
      };
      expect(bs.conversationLog).toHaveLength(2);
      expect(bs.conversationLog![0].role).toBe("brainstormer");
      expect(bs.conversationLog![1].role).toBe("user");
    });

    it("BrainstormState accepts complexityLevel", () => {
      const bs: BrainstormState = { step: "triage", complexityLevel: "straightforward" };
      expect(bs.complexityLevel).toBe("straightforward");
      bs.complexityLevel = "exploration";
      expect(bs.complexityLevel).toBe("exploration");
      bs.complexityLevel = "complex";
      expect(bs.complexityLevel).toBe("complex");
    });

    it("conversationLog round-trips through save/load", () => {
      const state = createInitialState("test");
      state.brainstorm.conversationLog = [
        { role: "brainstormer", step: "triage", content: "This looks straightforward" },
        { role: "user", step: "triage", content: "I agree" },
      ];
      state.brainstorm.complexityLevel = "straightforward";
      saveState(state, tmpDir);
      const loaded = loadState(tmpDir);
      expect(loaded!.brainstorm.conversationLog).toHaveLength(2);
      expect(loaded!.brainstorm.complexityLevel).toBe("straightforward");
    });
  });

  describe("updated state model", () => {
    it("createInitialState starts in brainstorm phase", () => {
      const state = createInitialState("Build auth");
      expect(state.phase).toBe("brainstorm");
    });

    it("createInitialState has initialized brainstorm sub-state", () => {
      const state = createInitialState("Build auth");
      expect(state.brainstorm).toBeDefined();
      expect(state.brainstorm.step).toBe("scout");
    });

    it("state supports designPath and designContent", () => {
      const state = createInitialState("Build auth");
      state.designPath = "docs/plans/2026-02-07-auth-design.md";
      state.designContent = "# Design\n...";
      expect(state.designPath).toBeTruthy();
      expect(state.designContent).toBeTruthy();
    });

    it("OrchestratorPhase includes brainstorm and plan-write", () => {
      const state = createInitialState("test");
      state.phase = "brainstorm";
      expect(state.phase).toBe("brainstorm");
      state.phase = "plan-write";
      expect(state.phase).toBe("plan-write");
    });

    it("BrainstormState has all required fields", () => {
      const bs: BrainstormState = { step: "scout" };
      expect(bs.step).toBe("scout");
      bs.scoutOutput = "output";
      bs.questions = [];
      bs.currentQuestionIndex = 0;
      bs.approaches = [];
      bs.recommendation = "a1";
      bs.chosenApproach = "a1";
      bs.designSections = [];
      bs.currentSectionIndex = 0;
    });

    it("state round-trips through save/load with new fields", () => {
      const state = createInitialState("Build auth");
      state.brainstorm.scoutOutput = "scout data";
      state.brainstorm.step = "questions";
      state.designPath = "docs/plans/test-design.md";
      state.designContent = "# Design";
      saveState(state, tmpDir);
      const loaded = loadState(tmpDir);
      expect(loaded).toBeDefined();
      expect(loaded!.brainstorm.scoutOutput).toBe("scout data");
      expect(loaded!.designPath).toBe("docs/plans/test-design.md");
    });
  });
});
