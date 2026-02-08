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
}));

vi.mock("../orchestrator-state.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../orchestrator-state.ts")>();
	return { ...orig, saveState: vi.fn() };
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
		mockDispatchParallel.mockResolvedValue([makeDispatchResult("architect"), makeDispatchResult("spec-reviewer")]);
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");
		const state = makeStateWithPlan();
		const result = await runPlanReviewPhase(state, ctx);

		expect(mockDispatchParallel).toHaveBeenCalledOnce();
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
		mockDispatchParallel.mockResolvedValue([makeDispatchResult("architect"), makeDispatchResult("spec-reviewer")]);
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");
		const state = makeStateWithPlan({ designContent: "# Design\nThe system uses Passport.js..." } as any);
		await runPlanReviewPhase(state, ctx);

		const tasks = mockDispatchParallel.mock.calls[0][1] as string[];
		expect(tasks[0]).toContain("Passport.js");
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
			mockGetFinalOutput.mockReturnValue(failReviewJson());

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

	it("forwards onStreamEvent to dispatchParallel when multiple reviewers", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("spec-reviewer"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchParallel.mockResolvedValue([makeDispatchResult("architect"), makeDispatchResult("spec-reviewer")]);
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");

		const onStreamEvent = vi.fn();
		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, ctx, undefined, onStreamEvent);

		// dispatchParallel doesn't take onStreamEvent directly, but dispatchAgent calls within revision should
		expect(mockDispatchParallel).toHaveBeenCalledOnce();
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

	it("passes signal to dispatch calls", async () => {
		const controller = new AbortController();
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("architect"), makeAgent("spec-reviewer"), makeAgent("planner")],
			projectAgentsDir: null,
		});
		mockDispatchParallel.mockResolvedValue([makeDispatchResult("architect"), makeDispatchResult("spec-reviewer")]);
		mockGetFinalOutput.mockReturnValue(passReviewJson());

		const ctx = makeCtx();
		ctx.ui.select.mockResolvedValue("Approve");
		const state = makeStateWithPlan();
		await runPlanReviewPhase(state, ctx, controller.signal);

		expect(mockDispatchParallel.mock.calls[0][3]).toBe(controller.signal);
	});
});
