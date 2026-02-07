import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { OrchestratorState, PendingInteraction } from "./orchestrator-state.ts";
import { createInitialState, saveState, loadState, clearState } from "./orchestrator-state.ts";

// Mock all phase modules
vi.mock("./phases/plan-write.js", () => ({
	runPlanWritePhase: vi.fn(),
}));
vi.mock("./phases/plan-review.js", () => ({
	runPlanReviewPhase: vi.fn(),
}));
vi.mock("./phases/configure.js", () => ({
	runConfigurePhase: vi.fn(),
}));
vi.mock("./phases/execute.js", () => ({
	runExecutePhase: vi.fn(),
}));
vi.mock("./phases/finalize.js", () => ({
	runFinalizePhase: vi.fn(),
}));

import { runOrchestrator, type OrchestratorResult } from "./orchestrator.ts";
import { runPlanWritePhase } from "./phases/plan-write.ts";
import { runPlanReviewPhase } from "./phases/plan-review.ts";
import { runConfigurePhase } from "./phases/configure.ts";
import { runExecutePhase } from "./phases/execute.ts";
import { runFinalizePhase } from "./phases/finalize.ts";

describe("runOrchestrator", () => {
	let tmpDir: string;
	let ctx: any;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
		ctx = { cwd: tmpDir };
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns error when no state and no userInput", async () => {
		const result = await runOrchestrator(ctx);
		expect(result.status).toBe("error");
		expect(result.message).toContain("/workflow");
	});

	it("creates initial state when no state and userInput provided", async () => {
		// Plan draft phase transitions to plan-review so the loop continues,
		// then plan-review sets a pendingInteraction so it stops.
		const mockPlanWrite = vi.mocked(runPlanWritePhase);
		mockPlanWrite.mockImplementation(async (state) => ({
			...state,
			phase: "plan-review" as const,
		}));

		const mockPlanReview = vi.mocked(runPlanReviewPhase);
		mockPlanReview.mockImplementation(async (state) => ({
			...state,
			pendingInteraction: {
				id: "plan-approval",
				type: "choice" as const,
				question: "Approve plan?",
				options: [{ key: "approve", label: "Approve" }],
			},
		}));

		const result = await runOrchestrator(ctx, undefined, "Build a CLI tool");
		expect(result.status).toBe("waiting");
		expect(mockPlanWrite).toHaveBeenCalled();
		// State should be persisted
		const saved = loadState(tmpDir);
		expect(saved).not.toBeNull();
		expect(saved!.userDescription).toBe("Build a CLI tool");
	});

	it("resumes from existing state with pending interaction and userInput", async () => {
		// Set up state with pending interaction
		const state = createInitialState("test");
		state.phase = "configure";
		state.pendingInteraction = {
			id: "review-mode",
			type: "choice",
			question: "Review mode?",
			options: [
				{ key: "single-pass", label: "One round" },
				{ key: "iterative", label: "Review-fix loop" },
			],
		};
		saveState(state, tmpDir);

		const mockConfigure = vi.mocked(runConfigurePhase);
		mockConfigure.mockImplementation(async (s) => ({
			...s,
			pendingInteraction: undefined,
			phase: "execute" as const,
		}));

		// Execute phase returns with a pending interaction
		const mockExecute = vi.mocked(runExecutePhase);
		mockExecute.mockImplementation(async (s) => ({
			...s,
			pendingInteraction: {
				id: "escalation",
				type: "choice" as const,
				question: "Task failed",
				options: [{ key: "skip", label: "Skip" }],
			},
		}));

		const result = await runOrchestrator(ctx, undefined, "single-pass");
		expect(result.status).toBe("waiting");
		expect(mockConfigure).toHaveBeenCalled();
	});

	it("returns waiting with formatted message when pending interaction and no userInput", async () => {
		const state = createInitialState("test");
		state.pendingInteraction = {
			id: "review-mode",
			type: "choice",
			question: "How should reviews work?",
			options: [
				{ key: "single-pass", label: "One round" },
				{ key: "iterative", label: "Review-fix loop" },
			],
		};
		saveState(state, tmpDir);

		const result = await runOrchestrator(ctx);
		expect(result.status).toBe("waiting");
		expect(result.message).toContain("How should reviews work?");
	});

	it("returns error when phase has error", async () => {
		const mockPlanWrite = vi.mocked(runPlanWritePhase);
		mockPlanWrite.mockImplementation(async (state) => ({
			...state,
			error: "Scout agent failed",
		}));

		const result = await runOrchestrator(ctx, undefined, "Build something");
		expect(result.status).toBe("error");
		expect(result.message).toBe("Scout agent failed");
	});

	it("chains through phases when phase changes", async () => {
		const mockPlanWrite = vi.mocked(runPlanWritePhase);
		mockPlanWrite.mockImplementation(async (state) => ({
			...state,
			phase: "plan-review" as const,
		}));

		const mockPlanReview = vi.mocked(runPlanReviewPhase);
		mockPlanReview.mockImplementation(async (state) => ({
			...state,
			phase: "configure" as const,
		}));

		const mockConfigure = vi.mocked(runConfigurePhase);
		mockConfigure.mockImplementation(async (state) => ({
			...state,
			pendingInteraction: {
				id: "review-mode",
				type: "choice" as const,
				question: "Review mode?",
				options: [{ key: "single-pass", label: "One pass" }],
			},
		}));

		const result = await runOrchestrator(ctx, undefined, "Build it");
		expect(result.status).toBe("waiting");
		expect(mockPlanWrite).toHaveBeenCalledTimes(1);
		expect(mockPlanReview).toHaveBeenCalledTimes(1);
		expect(mockConfigure).toHaveBeenCalledTimes(1);
	});

	it("handles finalize phase and returns done with report", async () => {
		const state = createInitialState("test");
		state.phase = "finalize";
		state.tasks = [{ id: 1, title: "Task 1", description: "", files: [], status: "complete", reviewsPassed: [], reviewsFailed: [], fixAttempts: 0 }];
		saveState(state, tmpDir);

		const mockFinalize = vi.mocked(runFinalizePhase);
		mockFinalize.mockImplementation(async (s) => ({
			state: { ...s, phase: "done" as const },
			report: "All tasks completed successfully!",
		}));

		const result = await runOrchestrator(ctx);
		expect(result.status).toBe("done");
		expect(result.message).toBe("All tasks completed successfully!");
	});

	it("returns done when phase is already done", async () => {
		const state = createInitialState("test");
		state.phase = "done";
		saveState(state, tmpDir);

		const result = await runOrchestrator(ctx);
		expect(result.status).toBe("done");
		expect(result.message).toContain("complete");
	});

	it("returns running for execute phase with checkpoint mode", async () => {
		const state = createInitialState("test");
		state.phase = "execute";
		state.config = { ...state.config, executionMode: "checkpoint" };
		state.tasks = [
			{ id: 1, title: "Task 1", description: "", files: [], status: "complete", reviewsPassed: [], reviewsFailed: [], fixAttempts: 0 },
			{ id: 2, title: "Task 2", description: "", files: [], status: "pending", reviewsPassed: [], reviewsFailed: [], fixAttempts: 0 },
		];
		saveState(state, tmpDir);

		const mockExecute = vi.mocked(runExecutePhase);
		mockExecute.mockImplementation(async (s) => ({
			...s,
			// Still in execute phase, no pending interaction, no error — checkpoint pause
		}));

		const result = await runOrchestrator(ctx);
		expect(result.status).toBe("running");
	});

	it("saves state after each phase transition", async () => {
		const mockPlanWrite = vi.mocked(runPlanWritePhase);
		mockPlanWrite.mockImplementation(async (state) => ({
			...state,
			phase: "plan-review" as const,
			pendingInteraction: {
				id: "approval",
				type: "confirm" as const,
				question: "Approve?",
			},
		}));

		await runOrchestrator(ctx, undefined, "Test project");
		const saved = loadState(tmpDir);
		expect(saved).not.toBeNull();
		expect(saved!.phase).toBe("plan-review");
	});

	it("throws on invalid parseUserResponse for pending interaction", async () => {
		const state = createInitialState("test");
		state.phase = "configure";
		state.pendingInteraction = {
			id: "review-mode",
			type: "choice",
			question: "Pick one",
			options: [
				{ key: "a", label: "A" },
				{ key: "b", label: "B" },
			],
		};
		saveState(state, tmpDir);

		const result = await runOrchestrator(ctx, undefined, "invalid-choice");
		expect(result.status).toBe("error");
		expect(result.message).toContain("Invalid choice");
	});
});
