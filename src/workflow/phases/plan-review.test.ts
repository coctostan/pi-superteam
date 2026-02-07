import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createInitialState, type OrchestratorState, type TaskExecState } from "../orchestrator-state.ts";

// Mock dispatch module
vi.mock("../../dispatch.js", () => ({
	discoverAgents: vi.fn(),
	dispatchAgent: vi.fn(),
	dispatchParallel: vi.fn(),
	getFinalOutput: vi.fn(),
}));

// Mock orchestrator-state saveState
vi.mock("../orchestrator-state.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../orchestrator-state.ts")>();
	return {
		...orig,
		saveState: vi.fn(),
	};
});

import { discoverAgents, dispatchAgent, dispatchParallel, getFinalOutput } from "../../dispatch.ts";
import { saveState } from "../orchestrator-state.ts";
import { runPlanReviewPhase } from "./plan-review.ts";
import type { AgentProfile, DispatchResult } from "../../dispatch.ts";

const mockDiscoverAgents = vi.mocked(discoverAgents);
const mockDispatchAgent = vi.mocked(dispatchAgent);
const mockDispatchParallel = vi.mocked(dispatchParallel);
const mockGetFinalOutput = vi.mocked(getFinalOutput);
const mockSaveState = vi.mocked(saveState);

function makeAgent(name: string): AgentProfile {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "",
		source: "package",
		filePath: `/agents/${name}.md`,
	};
}

function makeDispatchResult(agent: string = "test", messages: any[] = []): DispatchResult {
	return {
		agent,
		agentSource: "package",
		task: "test",
		exitCode: 0,
		messages,
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

function passReviewJson(): string {
	return '```superteam-json\n{"passed": true, "findings": [], "mustFix": [], "summary": "All good"}\n```';
}

function failReviewJson(issues: string = "Bad architecture"): string {
	return `\`\`\`superteam-json\n{"passed": false, "findings": [{"severity": "high", "file": "plan.md", "issue": "${issues}"}], "mustFix": ["Fix the design"], "summary": "Needs work"}\n\`\`\``;
}

function makeStateWithPlan(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
	const state = createInitialState("Build an API");
	state.phase = "plan-review";
	state.planPath = "/fake/project/docs/plans/test-plan.md";
	state.planContent = "# Plan\n\n```superteam-tasks\n- title: Task 1\n  description: Do thing\n  files: [a.ts]\n- title: Task 2\n  description: Do other thing\n  files: [b.ts]\n```";
	state.tasks = [
		{ id: 1, title: "Task 1", description: "Do thing", files: ["a.ts"], status: "pending", reviewsPassed: [], reviewsFailed: [], fixAttempts: 0 },
		{ id: 2, title: "Task 2", description: "Do other thing", files: ["b.ts"], status: "pending", reviewsPassed: [], reviewsFailed: [], fixAttempts: 0 },
	];
	return { ...state, ...overrides };
}

const fakeCtx = { cwd: "/fake/project" } as any;

describe("runPlanReviewPhase", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// --- Agent discovery ---

	it("works with both architect and spec-reviewer available", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("spec-reviewer")],
			projectAgentsDir: null,
		});
		mockDispatchParallel.mockResolvedValue([
			makeDispatchResult("architect"),
			makeDispatchResult("spec-reviewer"),
		]);
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, fakeCtx);

		expect(mockDispatchParallel).toHaveBeenCalledOnce();
		expect(result.pendingInteraction).toBeDefined();
		expect(result.pendingInteraction!.id).toBe("plan-approval");
	});

	it("works with only architect available", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, fakeCtx);

		expect(mockDispatchAgent).toHaveBeenCalledOnce();
		expect(mockDispatchParallel).not.toHaveBeenCalled();
		expect(result.pendingInteraction).toBeDefined();
	});

	it("works with only spec-reviewer available", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("spec-reviewer")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("spec-reviewer"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, fakeCtx);

		expect(mockDispatchAgent).toHaveBeenCalledOnce();
		expect(result.pendingInteraction).toBeDefined();
	});

	it("continues with no reviewers (logs warning, approves directly)", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [],
			projectAgentsDir: null,
		});

		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, fakeCtx);

		expect(result.pendingInteraction).toBeDefined();
		expect(result.pendingInteraction!.id).toBe("plan-approval");
		expect(mockDispatchAgent).not.toHaveBeenCalled();
		expect(mockDispatchParallel).not.toHaveBeenCalled();
	});

	// --- All reviews pass ---

	it("sets pendingInteraction to confirmPlanApproval when all pass", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("spec-reviewer")],
			projectAgentsDir: null,
		});
		mockDispatchParallel.mockResolvedValue([
			makeDispatchResult("architect"),
			makeDispatchResult("spec-reviewer"),
		]);
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, fakeCtx);

		expect(result.pendingInteraction).toBeDefined();
		expect(result.pendingInteraction!.id).toBe("plan-approval");
		expect(result.pendingInteraction!.question).toContain("2 tasks");
		expect(result.pendingInteraction!.question).toContain("Task 1");
		expect(result.pendingInteraction!.question).toContain("Task 2");
	});

	it("saves state when all reviews pass", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, fakeCtx);

		expect(mockSaveState).toHaveBeenCalled();
	});

	// --- Reviews fail, single-pass mode ---

	it("shows findings as warning in single-pass mode and sets approval", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(failReviewJson());

		const state = makeStateWithPlan();
		// reviewMode not set = single-pass
		const result = await runPlanReviewPhase(state, fakeCtx);

		expect(result.error).toBeDefined();
		expect(result.error).toContain("Needs work");
		expect(result.pendingInteraction).toBeDefined();
		expect(result.pendingInteraction!.id).toBe("plan-approval");
	});

	it("treats undefined reviewMode as single-pass", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(failReviewJson());

		const state = makeStateWithPlan();
		state.config = { tddMode: "tdd", maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 };
		// No reviewMode set
		const result = await runPlanReviewPhase(state, fakeCtx);

		// Should not attempt iterative revision
		expect(result.pendingInteraction).toBeDefined();
		expect(result.error).toBeDefined();
	});

	// --- Reviews fail, iterative mode ---

	it("dispatches implementer for revision in iterative mode", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-"));
		try {
			const planPath = path.join(tmpDir, "plan.md");
			const revisedPlan = "# Revised\n\n```superteam-tasks\n- title: Better Task\n  description: Improved\n  files: [c.ts]\n```";

			// Write initial plan
			fs.writeFileSync(planPath, "initial plan content");

			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("architect"), makeAgent("spec-reviewer"), makeAgent("implementer")],
				projectAgentsDir: null,
			});

			let reviewCallCount = 0;
			mockDispatchParallel.mockImplementation(async () => {
				reviewCallCount++;
				if (reviewCallCount === 1) {
					return [makeDispatchResult("architect"), makeDispatchResult("spec-reviewer")];
				}
				// Second round passes
				return [makeDispatchResult("architect"), makeDispatchResult("spec-reviewer")];
			});

			let getOutputCallCount = 0;
			mockGetFinalOutput.mockImplementation(() => {
				getOutputCallCount++;
				// First 2 calls are for failed reviews (architect + spec-reviewer)
				if (getOutputCallCount <= 2) return failReviewJson();
				// After revision, reviews pass
				return passReviewJson();
			});

			// Implementer writes revised plan
			mockDispatchAgent.mockImplementation(async () => {
				fs.writeFileSync(planPath, revisedPlan);
				return makeDispatchResult("implementer");
			});

			const ctx = { cwd: tmpDir } as any;
			const state = makeStateWithPlan({
				config: { tddMode: "tdd", reviewMode: "iterative", maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 },
				planPath,
			});

			const result = await runPlanReviewPhase(state, ctx);

			// Should have dispatched implementer for revision
			expect(mockDispatchAgent).toHaveBeenCalled();
			const implCall = mockDispatchAgent.mock.calls[0];
			expect(implCall[0].name).toBe("implementer");

			// Plan should be updated
			expect(result.planContent).toBe(revisedPlan);
			expect(result.tasks).toHaveLength(1);
			expect(result.tasks[0].title).toBe("Better Task");
			expect(result.planReviewCycles).toBe(1);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("increments planReviewCycles each iteration", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-"));
		try {
			const planPath = path.join(tmpDir, "plan.md");
			const planContent = "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```";
			fs.writeFileSync(planPath, planContent);

			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("architect"), makeAgent("implementer")],
				projectAgentsDir: null,
			});

			// Always fail reviews
			mockDispatchAgent.mockImplementation(async (agent) => {
				if (agent.name === "implementer") {
					fs.writeFileSync(planPath, planContent);
				}
				return makeDispatchResult(agent.name);
			});
			mockGetFinalOutput.mockReturnValue(failReviewJson());

			const ctx = { cwd: tmpDir } as any;
			const state = makeStateWithPlan({
				config: { tddMode: "tdd", reviewMode: "iterative", maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 },
				planPath,
			});

			const result = await runPlanReviewPhase(state, ctx);

			// Should have hit max cycles (3)
			expect(result.planReviewCycles).toBe(3);
			// Should still set pendingInteraction
			expect(result.pendingInteraction).toBeDefined();
			expect(result.error).toBeDefined();
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("stops iterating when max cycles reached and asks for approval", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-"));
		try {
			const planPath = path.join(tmpDir, "plan.md");
			const planContent = "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```";
			fs.writeFileSync(planPath, planContent);

			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("architect"), makeAgent("implementer")],
				projectAgentsDir: null,
			});
			mockDispatchAgent.mockImplementation(async (agent) => {
				if (agent.name === "implementer") {
					fs.writeFileSync(planPath, planContent);
				}
				return makeDispatchResult(agent.name);
			});
			mockGetFinalOutput.mockReturnValue(failReviewJson());

			const ctx = { cwd: tmpDir } as any;
			const state = makeStateWithPlan({
				config: { tddMode: "tdd", reviewMode: "iterative", maxPlanReviewCycles: 2, maxTaskReviewCycles: 3 },
				planPath,
			});

			const result = await runPlanReviewPhase(state, ctx);

			expect(result.planReviewCycles).toBe(2);
			expect(result.pendingInteraction!.id).toBe("plan-approval");
			expect(result.error).toBeDefined();
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("skips revision dispatch when implementer agent not found in iterative mode", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(failReviewJson());

		const state = makeStateWithPlan({
			config: { tddMode: "tdd", reviewMode: "iterative", maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 },
		});

		const result = await runPlanReviewPhase(state, fakeCtx);

		// No implementer means can't revise — should fall through to approval with error
		expect(result.pendingInteraction).toBeDefined();
		expect(result.error).toBeDefined();
	});

	// --- Review prompt construction ---

	it("passes planContent and review type to buildPlanReviewPrompt for each reviewer", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("spec-reviewer")],
			projectAgentsDir: null,
		});
		mockDispatchParallel.mockResolvedValue([
			makeDispatchResult("architect"),
			makeDispatchResult("spec-reviewer"),
		]);
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, fakeCtx);

		// Check dispatchParallel was called with correct prompts
		const call = mockDispatchParallel.mock.calls[0];
		const tasks = call[1] as string[];
		expect(tasks[0]).toContain("architect");
		expect(tasks[1]).toContain("spec");
		// Both should contain plan content
		expect(tasks[0]).toContain("superteam-tasks");
		expect(tasks[1]).toContain("superteam-tasks");
	});

	// --- Inconclusive review output ---

	it("treats inconclusive review output as failure", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue("no json here, just text");

		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, fakeCtx);

		// Inconclusive = treated as not passing, single-pass → show findings + approval
		expect(result.pendingInteraction).toBeDefined();
		expect(result.error).toBeDefined();
	});

	// --- Signal passing ---

	it("passes signal to dispatch calls", async () => {
		const controller = new AbortController();
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("spec-reviewer")],
			projectAgentsDir: null,
		});
		mockDispatchParallel.mockResolvedValue([
			makeDispatchResult("architect"),
			makeDispatchResult("spec-reviewer"),
		]);
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, fakeCtx, controller.signal);

		// dispatchParallel should receive signal
		expect(mockDispatchParallel.mock.calls[0][3]).toBe(controller.signal);
	});
});
