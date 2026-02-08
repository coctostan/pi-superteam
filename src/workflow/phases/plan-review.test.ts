import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createInitialState, type OrchestratorState } from "../orchestrator-state.ts";

vi.mock("../../dispatch.js", () => ({
	discoverAgents: vi.fn(),
	dispatchAgent: vi.fn(),
	dispatchParallel: vi.fn(),
	getFinalOutput: vi.fn(),
	hasWriteToolCalls: vi.fn().mockReturnValue(false),
}));

vi.mock("../orchestrator-state.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../orchestrator-state.ts")>();
	return { ...orig, saveState: vi.fn() };
});

import { discoverAgents, dispatchAgent, dispatchParallel, getFinalOutput, hasWriteToolCalls } from "../../dispatch.ts";
import { saveState } from "../orchestrator-state.ts";
import { runPlanReviewPhase } from "./plan-review.ts";
import type { AgentProfile, DispatchResult } from "../../dispatch.ts";

const mockDiscoverAgents = vi.mocked(discoverAgents);
const mockDispatchAgent = vi.mocked(dispatchAgent);
const mockDispatchParallel = vi.mocked(dispatchParallel);
const mockGetFinalOutput = vi.mocked(getFinalOutput);
const mockSaveState = vi.mocked(saveState);

function makeAgent(name: string): AgentProfile {
	return { name, description: `${name} agent`, systemPrompt: "", source: "package", filePath: `/agents/${name}.md` };
}

function makeDispatchResult(agent: string = "test"): DispatchResult {
	return {
		agent, agentSource: "package", task: "test", exitCode: 0, messages: [], stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

function passReviewJson(): string {
	return '```superteam-json\n{"passed": true, "findings": [], "mustFix": [], "summary": "All good"}\n```';
}

function failReviewJson(issues: string = "Bad architecture"): string {
	return `\`\`\`superteam-json\n{"passed": false, "findings": [{"severity": "high", "file": "plan.md", "issue": "${issues}"}], "mustFix": ["Fix the design"], "summary": "Needs work"}\n\`\`\``;
}

function makeCtx(tmpDir?: string) {
	return {
		cwd: tmpDir || "/fake/project",
		hasUI: true,
		ui: {
			select: vi.fn(),
			confirm: vi.fn(),
			input: vi.fn(),
			editor: vi.fn(),
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
		},
	} as any;
}

function makeStateWithPlan(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
	const state = createInitialState("Build an API");
	state.phase = "plan-review";
	state.planPath = "/fake/project/docs/plans/test-plan.md";
	state.planContent = "# Plan\n\n```superteam-tasks\n- title: Task 1\n  description: Do thing\n  files: [a.ts]\n- title: Task 2\n  description: Do other thing\n  files: [b.ts]\n```";
	state.designContent = "# Design\nThe system uses...";
	state.tasks = [
		{ id: 1, title: "Task 1", description: "Do thing", files: ["a.ts"], status: "pending", reviewsPassed: [], reviewsFailed: [], fixAttempts: 0 },
		{ id: 2, title: "Task 2", description: "Do other thing", files: ["b.ts"], status: "pending", reviewsPassed: [], reviewsFailed: [], fixAttempts: 0 },
	];
	return { ...state, ...overrides } as OrchestratorState;
}

describe("runPlanReviewPhase", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("works with both architect and spec-reviewer available", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("spec-reviewer"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");
		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, ctx);

		// Both reviewers dispatched via dispatchAgent (in parallel via Promise.all)
		const reviewerCalls = mockDispatchAgent.mock.calls.filter(
			c => c[0].name === "architect" || c[0].name === "spec-reviewer"
		);
		expect(reviewerCalls).toHaveLength(2);
		expect(result.phase).toBe("configure");
	});

	it("works with only architect available", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");
		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, ctx);

		expect(mockDispatchAgent).toHaveBeenCalledOnce();
	});

	it("works with only spec-reviewer available", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("spec-reviewer"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("spec-reviewer"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");
		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, ctx);

		expect(mockDispatchAgent).toHaveBeenCalledOnce();
	});

	it("continues with no reviewers (approves directly)", async () => {
		mockDiscoverAgents.mockReturnValue({ agents: [makeAgent("planner")], projectAgentsDir: null });
		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");

		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, ctx);

		expect(result.phase).toBe("configure");
		expect(mockDispatchAgent).not.toHaveBeenCalled();
	});

	it("uses ctx.ui.select for plan approval (Approve/Revise/Abort)", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");
		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, ctx);

		expect(ctx.ui.select).toHaveBeenCalled();
		expect(result.phase).toBe("configure");
	});

	it("passes design content to review prompts", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("spec-reviewer"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");
		const state = makeStateWithPlan({ designContent: "# Design\nThe system uses Passport.js..." } as any);
		await runPlanReviewPhase(state, ctx);

		// Check that review prompts contain design content
		const reviewerCalls = mockDispatchAgent.mock.calls.filter(
			c => c[0].name === "architect" || c[0].name === "spec-reviewer"
		);
		expect(reviewerCalls[0][1]).toContain("Passport.js");
	});

	it("dispatches planner for revision when review fails", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-"));
		try {
			const planPath = path.join(tmpDir, "plan.md");
			const planContent = "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```";
			const revisedPlan = "# Revised\n```superteam-tasks\n- title: Better\n  description: I\n  files: [c.ts]\n```";
			fs.writeFileSync(planPath, planContent);

			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("architect"), makeAgent("planner")],
				projectAgentsDir: null,
			});

			let reviewCallCount = 0;
			mockDispatchAgent.mockImplementation(async (agent) => {
				if (agent.name === "planner") {
					fs.writeFileSync(planPath, revisedPlan);
				}
				return makeDispatchResult(agent.name);
			});

			mockGetFinalOutput
				.mockReturnValueOnce(failReviewJson("Missing error handling"))
				.mockReturnValueOnce(passReviewJson());

			const ctx = makeCtx(tmpDir);
			ctx.ui.select.mockResolvedValue("Approve");
			const state = makeStateWithPlan({
				config: { tddMode: "tdd", reviewMode: "iterative", maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 },
				planPath,
			} as any);

			const result = await runPlanReviewPhase(state, ctx);

			const plannerCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "planner");
			expect(plannerCalls.length).toBeGreaterThanOrEqual(1);
			expect(plannerCalls[0][1]).toContain("Missing error handling");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("handles user selecting Revise with editor feedback", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-"));
		try {
			const planPath = path.join(tmpDir, "plan.md");
			const planContent = "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```";
			fs.writeFileSync(planPath, planContent);

			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("architect"), makeAgent("planner")],
				projectAgentsDir: null,
			});
			mockDispatchAgent.mockImplementation(async (agent) => {
				if (agent.name === "planner") {
					fs.writeFileSync(planPath, planContent);
				}
				return makeDispatchResult(agent.name);
			});
			mockGetFinalOutput.mockReturnValue(passReviewJson());

			const ctx = makeCtx(tmpDir);
			ctx.ui.select
				.mockResolvedValueOnce("Revise")
				.mockResolvedValueOnce("Approve");
			ctx.ui.editor.mockResolvedValue("Add more error handling tasks");

			const state = makeStateWithPlan({ planPath } as any);
			await runPlanReviewPhase(state, ctx);

			expect(ctx.ui.editor).toHaveBeenCalled();
			const plannerCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "planner");
			expect(plannerCalls.length).toBeGreaterThanOrEqual(1);
			expect(plannerCalls[0][1]).toContain("error handling");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("handles Abort", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Abort");

		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, ctx);

		expect(result.error).toBeDefined();
	});

	it("increments planReviewCycles each iteration", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-"));
		try {
			const planPath = path.join(tmpDir, "plan.md");
			const planContent = "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```";
			fs.writeFileSync(planPath, planContent);

			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("architect"), makeAgent("planner")],
				projectAgentsDir: null,
			});
			mockDispatchAgent.mockImplementation(async (agent) => {
				if (agent.name === "planner") fs.writeFileSync(planPath, planContent);
				return makeDispatchResult(agent.name);
			});
			// Return DIFFERENT findings each time to avoid convergence detection
			let failCount = 0;
			mockGetFinalOutput.mockImplementation(() => {
				failCount++;
				return failReviewJson(`Issue number ${failCount}`);
			});

			const ctx = makeCtx(tmpDir);
			ctx.ui.select.mockResolvedValue("Approve");
			const state = makeStateWithPlan({
				config: { tddMode: "tdd", reviewMode: "iterative", maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 },
				planPath,
			} as any);

			const result = await runPlanReviewPhase(state, ctx);

			expect(result.planReviewCycles).toBe(3);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("treats inconclusive review output as failure", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue("no json here");

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");

		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, ctx);

		expect(ctx.ui.select).toHaveBeenCalled();
	});

	it("forwards onStreamEvent callback to dispatchAgent", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");

		const onStreamEvent = vi.fn();
		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, ctx, undefined, onStreamEvent);

		// Verify dispatchAgent was called with onStreamEvent in the 6th position
		const firstDispatchCall = mockDispatchAgent.mock.calls[0];
		expect(firstDispatchCall.length).toBeGreaterThanOrEqual(6);
		expect(firstDispatchCall[5]).toBeDefined();
	});

	it("forwards onStreamEvent to each reviewer dispatchAgent when multiple reviewers", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("spec-reviewer"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");

		const onStreamEvent = vi.fn();
		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, ctx, undefined, onStreamEvent);

		// With multiple reviewers, dispatchAgent should be called for each reviewer (not dispatchParallel)
		const reviewerCalls = mockDispatchAgent.mock.calls.filter(
			c => c[0].name === "architect" || c[0].name === "spec-reviewer"
		);
		expect(reviewerCalls).toHaveLength(2);
		// Each call should have onStreamEvent wrapper (6th arg, index 5)
		for (const call of reviewerCalls) {
			expect(call.length).toBeGreaterThanOrEqual(6);
			expect(call[5]).toBeDefined(); // onStreamEvent wrapper
		}
	});

	it("forwards onStreamEvent to planner dispatch during revision", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-stream-"));
		try {
			const planPath = path.join(tmpDir, "plan.md");
			const planContent = "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```";
			fs.writeFileSync(planPath, planContent);

			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("architect"), makeAgent("planner")],
				projectAgentsDir: null,
			});

			mockDispatchAgent.mockImplementation(async (agent) => {
				if (agent.name === "planner") {
					fs.writeFileSync(planPath, planContent);
				}
				return makeDispatchResult(agent.name);
			});

			mockGetFinalOutput
				.mockReturnValueOnce(failReviewJson("Missing error handling"))
				.mockReturnValueOnce(passReviewJson());

			const ctx = makeCtx(tmpDir);
			ctx.ui.select.mockResolvedValue("Approve");

			const onStreamEvent = vi.fn();
			const state = makeStateWithPlan({
				config: { tddMode: "tdd", reviewMode: "iterative", maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 },
				planPath,
			} as any);

			await runPlanReviewPhase(state, ctx, undefined, onStreamEvent);

			// Planner dispatch should also have onStreamEvent (6th arg)
			const plannerCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "planner");
			expect(plannerCalls.length).toBeGreaterThanOrEqual(1);
			expect(plannerCalls[0].length).toBeGreaterThanOrEqual(6);
			expect(plannerCalls[0][5]).toBeDefined();
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("escalates to user when same findings recur (convergence failure)", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-conv-"));
		try {
			const planPath = path.join(tmpDir, "plan.md");
			const planContent = "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```";
			fs.writeFileSync(planPath, planContent);

			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("architect"), makeAgent("planner")],
				projectAgentsDir: null,
			});
			mockDispatchAgent.mockImplementation(async (agent) => {
				if (agent.name === "planner") fs.writeFileSync(planPath, planContent);
				return makeDispatchResult(agent.name);
			});
			// Always returns same failure findings
			mockGetFinalOutput.mockReturnValue(failReviewJson("Same issue every time"));

			const ctx = makeCtx(tmpDir);
			// Convergence escalation: "Approve as-is" to break out
			ctx.ui.select
				.mockResolvedValueOnce("Approve as-is")   // convergence escalation
				.mockResolvedValueOnce("Approve");         // final approval
			const state = makeStateWithPlan({
				config: { tddMode: "tdd", reviewMode: "iterative", maxPlanReviewCycles: 5, maxTaskReviewCycles: 3 },
				planPath,
			} as any);

			const result = await runPlanReviewPhase(state, ctx);

			// Should have shown convergence escalation (at cycle 2, same findings)
			const selectCalls = ctx.ui.select.mock.calls;
			expect(selectCalls[0][0]).toContain("converging");
			expect(result.phase).toBe("configure");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("uses targeted revision prompt instead of full rewrite", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-review-targeted-"));
		try {
			const planPath = path.join(tmpDir, "plan.md");
			const planContent = "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```";
			fs.writeFileSync(planPath, planContent);

			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("architect"), makeAgent("planner")],
				projectAgentsDir: null,
			});
			mockDispatchAgent.mockImplementation(async (agent) => {
				if (agent.name === "planner") fs.writeFileSync(planPath, planContent);
				return makeDispatchResult(agent.name);
			});
			mockGetFinalOutput
				.mockReturnValueOnce(failReviewJson("Missing error handling"))
				.mockReturnValueOnce(passReviewJson());

			const ctx = makeCtx(tmpDir);
			ctx.ui.select.mockResolvedValue("Approve");
			const state = makeStateWithPlan({
				config: { tddMode: "tdd", reviewMode: "iterative", maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 },
				planPath,
			} as any);

			await runPlanReviewPhase(state, ctx);

			// The planner dispatch should use targeted prompt (contains "Targeted edits only")
			const plannerCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "planner");
			expect(plannerCalls.length).toBeGreaterThanOrEqual(1);
			expect(plannerCalls[0][1]).toContain("Targeted edits only");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("re-dispatches reviewer when hasWriteToolCalls returns true", async () => {
		const mockHasWriteToolCalls = vi.mocked(hasWriteToolCalls);
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		// First call: has writes, second call (re-dispatch): no writes
		mockHasWriteToolCalls
			.mockReturnValueOnce(true)
			.mockReturnValue(false);

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");
		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, ctx);

		// Should have been dispatched twice for the same reviewer (original + re-dispatch)
		const reviewerCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "architect");
		expect(reviewerCalls).toHaveLength(2);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("write operations"), "warning");
	});

	it("passes signal to dispatch calls", async () => {
		const controller = new AbortController();
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("spec-reviewer"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");
		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, ctx, controller.signal);

		// Each dispatchAgent call should receive the signal (5th arg, index 3)
		const reviewerCalls = mockDispatchAgent.mock.calls.filter(
			c => c[0].name === "architect" || c[0].name === "spec-reviewer"
		);
		expect(reviewerCalls).toHaveLength(2);
		for (const call of reviewerCalls) {
			expect(call[3]).toBe(controller.signal);
		}
	});
});
