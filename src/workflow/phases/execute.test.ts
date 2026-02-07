import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState, type OrchestratorState, type TaskExecState } from "../orchestrator-state.ts";

// Mock modules
vi.mock("../../dispatch.js", () => ({
	discoverAgents: vi.fn(),
	dispatchAgent: vi.fn(),
	dispatchParallel: vi.fn(),
	getFinalOutput: vi.fn(),
	checkCostBudget: vi.fn(),
}));

vi.mock("../orchestrator-state.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../orchestrator-state.ts")>();
	return { ...orig, saveState: vi.fn() };
});

vi.mock("../git-utils.js", () => ({
	getCurrentSha: vi.fn(),
	computeChangedFiles: vi.fn(),
}));

vi.mock("../../review-parser.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../review-parser.ts")>();
	return { ...orig, parseReviewOutput: vi.fn(), hasCriticalFindings: vi.fn() };
});

import { discoverAgents, dispatchAgent, dispatchParallel, getFinalOutput, checkCostBudget } from "../../dispatch.ts";
import { saveState } from "../orchestrator-state.ts";
import { getCurrentSha, computeChangedFiles } from "../git-utils.ts";
import { parseReviewOutput, hasCriticalFindings } from "../../review-parser.ts";
import { runExecutePhase } from "./execute.ts";
import type { AgentProfile, DispatchResult, CostCheckResult } from "../../dispatch.ts";

const mockDiscoverAgents = vi.mocked(discoverAgents);
const mockDispatchAgent = vi.mocked(dispatchAgent);
const mockDispatchParallel = vi.mocked(dispatchParallel);
const mockGetFinalOutput = vi.mocked(getFinalOutput);
const mockCheckCostBudget = vi.mocked(checkCostBudget);
const mockSaveState = vi.mocked(saveState);
const mockGetCurrentSha = vi.mocked(getCurrentSha);
const mockComputeChangedFiles = vi.mocked(computeChangedFiles);
const mockParseReviewOutput = vi.mocked(parseReviewOutput);
const mockHasCriticalFindings = vi.mocked(hasCriticalFindings);

function makeAgent(name: string): AgentProfile {
	return { name, description: `${name} agent`, systemPrompt: "", source: "package", filePath: `/agents/${name}.md` };
}

function makeResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
	return {
		agent: "test", agentSource: "package", task: "test", exitCode: 0,
		messages: [], stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

function makeTask(overrides: Partial<TaskExecState> = {}): TaskExecState {
	return {
		id: 1, title: "Task 1", description: "Do something", files: ["src/a.ts"],
		status: "pending", reviewsPassed: [], reviewsFailed: [], fixAttempts: 0,
		...overrides,
	};
}

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
	const base = createInitialState("test");
	base.phase = "execute";
	base.config = {
		tddMode: "tdd", reviewMode: "iterative", executionMode: "auto",
		batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 3,
	};
	base.tasks = [makeTask()];
	base.planContent = "# Plan\nGoal: test\n```superteam-tasks\n- title: Task 1\n  description: Do something\n  files: [src/a.ts]\n```";
	return { ...base, ...overrides };
}

const fakeCtx = { cwd: "/fake/project" } as any;

function setupDefaultMocks() {
	mockCheckCostBudget.mockReturnValue({ allowed: true, currentCost: 0, limit: 10 });
	mockDiscoverAgents.mockReturnValue({
		agents: [makeAgent("implementer"), makeAgent("spec-reviewer"), makeAgent("quality-reviewer")],
		projectAgentsDir: null,
	});
	mockGetCurrentSha.mockResolvedValue("abc123");
	mockComputeChangedFiles.mockResolvedValue(["src/a.ts"]);
	mockDispatchAgent.mockResolvedValue(makeResult());
	mockGetFinalOutput.mockReturnValue('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');
	mockParseReviewOutput.mockReturnValue({
		status: "pass",
		findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
	});
}

describe("runExecutePhase", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// --- Escalation response handling ---

	describe("escalation responses", () => {
		it("handles 'continue' by resetting task to pending", async () => {
			setupDefaultMocks();
			const state = makeState({
				tasks: [makeTask({ status: "implementing" })],
				pendingInteraction: {
					id: "task-escalation", type: "choice", question: "Task needs attention",
					options: [{ key: "continue", label: "Continue" }, { key: "skip", label: "Skip" }, { key: "abort", label: "Abort" }],
				},
			});
			const result = await runExecutePhase(state, fakeCtx, undefined, "continue");
			expect(result.tasks[0].status).toBe("complete");
			expect(result.pendingInteraction).toBeUndefined();
		});

		it("handles 'skip' by skipping the task and advancing index", async () => {
			setupDefaultMocks();
			const state = makeState({
				tasks: [makeTask({ status: "implementing" }), makeTask({ id: 2, title: "Task 2", status: "pending" })],
				pendingInteraction: {
					id: "task-escalation", type: "choice", question: "Task needs attention",
					options: [{ key: "continue", label: "Continue" }, { key: "skip", label: "Skip" }, { key: "abort", label: "Abort" }],
				},
			});
			const result = await runExecutePhase(state, fakeCtx, undefined, "skip");
			expect(result.tasks[0].status).toBe("skipped");
			// After skip, continues to process task 2 in auto mode
			expect(result.tasks[1].status).toBe("complete");
		});

		it("handles 'abort' by setting phase to done with error", async () => {
			const state = makeState({
				tasks: [makeTask({ status: "implementing" })],
				pendingInteraction: {
					id: "task-escalation", type: "choice", question: "Task needs attention",
					options: [{ key: "continue", label: "Continue" }, { key: "skip", label: "Skip" }, { key: "abort", label: "Abort" }],
				},
			});
			const result = await runExecutePhase(state, fakeCtx, undefined, "abort");
			expect(result.phase).toBe("done");
			expect(result.error).toBe("Aborted by user");
		});
	});

	// --- Cost budget ---

	describe("cost budget", () => {
		it("stops with error when cost budget exceeded", async () => {
			mockCheckCostBudget.mockReturnValue({ allowed: false, currentCost: 10, limit: 10, warning: "limit reached" });
			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("implementer"), makeAgent("spec-reviewer"), makeAgent("quality-reviewer")],
				projectAgentsDir: null,
			});
			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);
			expect(result.phase).toBe("done");
			expect(result.error).toContain("Cost budget exceeded");
		});
	});

	// --- Agent discovery ---

	describe("agent discovery", () => {
		it("escalates when no implementer agent found", async () => {
			mockCheckCostBudget.mockReturnValue({ allowed: true, currentCost: 0, limit: 10 });
			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("spec-reviewer"), makeAgent("quality-reviewer")],
				projectAgentsDir: null,
			});
			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);
			expect(result.pendingInteraction).toBeDefined();
			expect(result.pendingInteraction!.id).toBe("task-escalation");
		});
	});

	// --- Implementation ---

	describe("implementation", () => {
		it("records gitShaBeforeImpl and calls getCurrentSha", async () => {
			setupDefaultMocks();
			const state = makeState();
			await runExecutePhase(state, fakeCtx);

			expect(mockGetCurrentSha).toHaveBeenCalledWith("/fake/project");
			expect(state.tasks[0].gitShaBeforeImpl).toBe("abc123");
		});

		it("dispatches implementer with buildImplPrompt", async () => {
			setupDefaultMocks();
			const state = makeState();
			await runExecutePhase(state, fakeCtx);

			// First dispatch should be to implementer
			expect(mockDispatchAgent.mock.calls[0][0].name).toBe("implementer");
			expect(mockDispatchAgent.mock.calls[0][1]).toContain("Task 1");
		});

		it("escalates when implementer fails (exit code != 0)", async () => {
			setupDefaultMocks();
			mockDispatchAgent.mockResolvedValueOnce(makeResult({ exitCode: 1, errorMessage: "compilation error" }));
			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.pendingInteraction).toBeDefined();
			expect(result.pendingInteraction!.id).toBe("task-escalation");
			expect(result.pendingInteraction!.question).toContain("Task 1");
		});

		it("accumulates cost from implementer dispatch", async () => {
			setupDefaultMocks();
			mockDispatchAgent.mockResolvedValue(makeResult({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 0, turns: 0 } }));
			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			// 3 dispatches: impl + spec-review + quality-review, each 0.05
			expect(result.totalCostUsd).toBeGreaterThan(0);
		});
	});

	// --- Spec review ---

	describe("spec review", () => {
		it("passes spec review and proceeds to quality review", async () => {
			setupDefaultMocks();
			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].reviewsPassed).toContain("spec");
			expect(result.tasks[0].reviewsPassed).toContain("quality");
			expect(result.tasks[0].status).toBe("complete");
		});

		it("retries on spec review failure with fix loop", async () => {
			setupDefaultMocks();
			// impl succeeds, then spec fails, then spec passes
			let specCallCount = 0;
			mockDispatchAgent.mockImplementation(async (agent) => {
				return makeResult();
			});
			mockParseReviewOutput
				.mockReturnValueOnce({
					status: "fail",
					findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix it"], summary: "fail" },
				})
				.mockReturnValueOnce({
					status: "pass",
					findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
				})
				.mockReturnValue({
					status: "pass",
					findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
				});

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].fixAttempts).toBe(1);
			expect(result.tasks[0].reviewsPassed).toContain("spec");
		});

		it("escalates after max spec review retries", async () => {
			setupDefaultMocks();
			mockParseReviewOutput.mockReturnValue({
				status: "fail",
				findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix"], summary: "fail" },
			});

			const state = makeState({
				config: {
					tddMode: "tdd", reviewMode: "iterative", executionMode: "auto",
					batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 2,
				},
			});
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.pendingInteraction).toBeDefined();
			expect(result.pendingInteraction!.id).toBe("task-escalation");
		});

		it("escalates on inconclusive spec review", async () => {
			setupDefaultMocks();
			mockParseReviewOutput.mockReturnValue({
				status: "inconclusive",
				rawOutput: "garbage",
				parseError: "no JSON",
			});

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.pendingInteraction).toBeDefined();
			expect(result.pendingInteraction!.id).toBe("task-escalation");
		});
	});

	// --- Quality review ---

	describe("quality review", () => {
		it("runs quality review after spec review passes", async () => {
			setupDefaultMocks();
			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			// Should have dispatched: implementer, spec-reviewer, quality-reviewer
			const dispatched = mockDispatchAgent.mock.calls.map(c => c[0].name);
			expect(dispatched).toContain("spec-reviewer");
			expect(dispatched).toContain("quality-reviewer");
			// Spec-reviewer dispatched before quality-reviewer
			const specIdx = dispatched.indexOf("spec-reviewer");
			const qualIdx = dispatched.indexOf("quality-reviewer");
			expect(specIdx).toBeLessThan(qualIdx);
		});

		it("retries on quality review failure with fix loop", async () => {
			setupDefaultMocks();
			// spec passes, quality fails once then passes
			mockParseReviewOutput
				.mockReturnValueOnce({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } }) // spec
				.mockReturnValueOnce({ status: "fail", findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad quality" }], mustFix: ["fix"], summary: "fail" } }) // quality first
				.mockReturnValue({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } }); // quality retry

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].reviewsPassed).toContain("quality");
			expect(result.tasks[0].fixAttempts).toBe(1);
		});

		it("escalates after max quality review retries", async () => {
			setupDefaultMocks();
			mockParseReviewOutput
				.mockReturnValueOnce({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } }) // spec passes
				.mockReturnValue({ status: "fail", findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix"], summary: "fail" } }); // quality always fails

			const state = makeState({
				config: {
					tddMode: "tdd", reviewMode: "iterative", executionMode: "auto",
					batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 2,
				},
			});
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.pendingInteraction).toBeDefined();
			expect(result.pendingInteraction!.id).toBe("task-escalation");
		});
	});

	// --- Optional reviews ---

	describe("optional reviews", () => {
		it("runs optional reviewers in parallel when available", async () => {
			setupDefaultMocks();
			mockDiscoverAgents.mockReturnValue({
				agents: [
					makeAgent("implementer"), makeAgent("spec-reviewer"), makeAgent("quality-reviewer"),
					makeAgent("security-reviewer"), makeAgent("performance-reviewer"),
				],
				projectAgentsDir: null,
			});
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockHasCriticalFindings.mockReturnValue(false);

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(mockDispatchParallel).toHaveBeenCalled();
			expect(result.tasks[0].status).toBe("complete");
		});

		it("escalates when optional reviews have critical findings", async () => {
			setupDefaultMocks();
			mockDiscoverAgents.mockReturnValue({
				agents: [
					makeAgent("implementer"), makeAgent("spec-reviewer"), makeAgent("quality-reviewer"),
					makeAgent("security-reviewer"),
				],
				projectAgentsDir: null,
			});
			mockDispatchParallel.mockResolvedValue([makeResult()]);
			mockGetFinalOutput.mockReturnValue('{"passed":false,"findings":[{"severity":"critical","file":"a.ts","issue":"vuln"}],"mustFix":[],"summary":"critical issue"}');
			// Override parseReviewOutput for the optional review to return fail with critical
			mockParseReviewOutput
				.mockReturnValueOnce({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } }) // spec
				.mockReturnValueOnce({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } }) // quality
				.mockReturnValueOnce({
					status: "fail",
					findings: { passed: false, findings: [{ severity: "critical", file: "a.ts", issue: "vuln" }], mustFix: [], summary: "critical" },
				}); // optional (security)
			mockHasCriticalFindings.mockReturnValue(true);

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.pendingInteraction).toBeDefined();
			expect(result.pendingInteraction!.id).toBe("task-escalation");
		});

		it("skips optional reviews when no optional reviewers available", async () => {
			setupDefaultMocks();
			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(mockDispatchParallel).not.toHaveBeenCalled();
			expect(result.tasks[0].status).toBe("complete");
		});
	});

	// --- Task completion and advancement ---

	describe("task completion", () => {
		it("sets task to complete and advances currentTaskIndex", async () => {
			setupDefaultMocks();
			const state = makeState({
				tasks: [makeTask(), makeTask({ id: 2, title: "Task 2", status: "pending" })],
			});
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].status).toBe("complete");
			expect(result.tasks[1].status).toBe("complete");
			expect(result.currentTaskIndex).toBe(2);
		});

		it("transitions to finalize when all tasks done", async () => {
			setupDefaultMocks();
			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.phase).toBe("finalize");
		});
	});

	// --- Execution modes ---

	describe("execution modes", () => {
		it("checkpoint mode: returns after each completed task", async () => {
			setupDefaultMocks();
			const state = makeState({
				config: {
					tddMode: "tdd", reviewMode: "iterative", executionMode: "checkpoint",
					batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 3,
				},
				tasks: [makeTask(), makeTask({ id: 2, title: "Task 2", status: "pending" })],
			});
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].status).toBe("complete");
			expect(result.tasks[1].status).toBe("pending");
			expect(result.currentTaskIndex).toBe(1);
			expect(result.phase).toBe("execute"); // not finalize yet
		});

		it("batch mode: returns after batchSize tasks", async () => {
			setupDefaultMocks();
			const state = makeState({
				config: {
					tddMode: "tdd", reviewMode: "iterative", executionMode: "batch",
					batchSize: 2, maxPlanReviewCycles: 3, maxTaskReviewCycles: 3,
				},
				tasks: [
					makeTask(), makeTask({ id: 2, title: "Task 2", status: "pending" }),
					makeTask({ id: 3, title: "Task 3", status: "pending" }),
				],
			});
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].status).toBe("complete");
			expect(result.tasks[1].status).toBe("complete");
			expect(result.tasks[2].status).toBe("pending");
			expect(result.phase).toBe("execute");
		});

		it("auto mode: runs all tasks", async () => {
			setupDefaultMocks();
			const state = makeState({
				tasks: [makeTask(), makeTask({ id: 2, title: "Task 2", status: "pending" })],
			});
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].status).toBe("complete");
			expect(result.tasks[1].status).toBe("complete");
			expect(result.phase).toBe("finalize");
		});
	});

	// --- Skipped/complete tasks are not re-executed ---

	describe("task filtering", () => {
		it("skips already completed tasks", async () => {
			setupDefaultMocks();
			const state = makeState({
				currentTaskIndex: 1,
				tasks: [
					makeTask({ status: "complete" }),
					makeTask({ id: 2, title: "Task 2", status: "pending" }),
				],
			});
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].status).toBe("complete");
			expect(result.tasks[1].status).toBe("complete");
			// Implementer only called for Task 2
			const implCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "implementer");
			expect(implCalls.length).toBe(1);
		});

		it("skips already skipped tasks", async () => {
			setupDefaultMocks();
			const state = makeState({
				currentTaskIndex: 1,
				tasks: [
					makeTask({ status: "skipped" }),
					makeTask({ id: 2, title: "Task 2", status: "pending" }),
				],
			});
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].status).toBe("skipped");
			expect(result.tasks[1].status).toBe("complete");
		});

		it("finalizes when all remaining tasks are skipped", async () => {
			setupDefaultMocks();
			const state = makeState({
				tasks: [makeTask({ status: "skipped" })],
				currentTaskIndex: 1,
			});
			const result = await runExecutePhase(state, fakeCtx);
			expect(result.phase).toBe("finalize");
		});
	});

	// --- Changed files refresh after fix ---

	describe("changed files refresh", () => {
		it("refreshes changedFiles after fix dispatch", async () => {
			setupDefaultMocks();
			mockParseReviewOutput
				.mockReturnValueOnce({ status: "fail", findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix"], summary: "fail" } })
				.mockReturnValue({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } });

			const state = makeState();
			await runExecutePhase(state, fakeCtx);

			// computeChangedFiles should be called more than once (initial + after fix)
			expect(mockComputeChangedFiles.mock.calls.length).toBeGreaterThan(1);
		});
	});

	// --- saveState calls ---

	describe("state persistence", () => {
		it("saves state on each status transition", async () => {
			setupDefaultMocks();
			const state = makeState();
			await runExecutePhase(state, fakeCtx);

			// At minimum: implementing, reviewing (spec), reviewing (quality), complete, finalize
			expect(mockSaveState.mock.calls.length).toBeGreaterThanOrEqual(4);
		});
	});
});
