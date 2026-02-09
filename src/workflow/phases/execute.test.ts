import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState, type OrchestratorState, type TaskExecState } from "../orchestrator-state.ts";

// Mock modules
vi.mock("../../dispatch.js", () => ({
	discoverAgents: vi.fn(),
	dispatchAgent: vi.fn(),
	dispatchParallel: vi.fn(),
	getFinalOutput: vi.fn(),
	checkCostBudget: vi.fn(),
	hasWriteToolCalls: vi.fn().mockReturnValue(false),
}));

vi.mock("../orchestrator-state.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../orchestrator-state.ts")>();
	return { ...orig, saveState: vi.fn() };
});

vi.mock("../git-utils.js", () => ({
	getCurrentSha: vi.fn(),
	computeChangedFiles: vi.fn(),
	resetToSha: vi.fn(),
	squashTaskCommits: vi.fn(),
}));

vi.mock("../../review-parser.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../review-parser.ts")>();
	return { ...orig, parseReviewOutput: vi.fn(), hasCriticalFindings: vi.fn() };
});

vi.mock("../../config.js", () => ({
	getConfig: vi.fn(),
}));

vi.mock("../failure-taxonomy.js", () => ({
	resolveFailureAction: vi.fn(),
	DEFAULT_FAILURE_ACTIONS: {
		"parse-error": "auto-retry",
		"test-regression": "stop-show-diff",
		"test-flake": "warn-continue",
		"test-preexisting": "ignore",
		"tool-timeout": "retry-then-escalate",
		"budget-threshold": "checkpoint",
		"review-max-retries": "escalate",
		"validation-failure": "retry-then-escalate",
		"impl-crash": "retry-then-escalate",
	},
}));

vi.mock("../cross-task-validation.js", () => ({
	runCrossTaskValidation: vi.fn(),
	shouldRunValidation: vi.fn(),
}));

vi.mock("../test-baseline.js", () => ({
	captureBaseline: vi.fn(),
}));

vi.mock("../progress.js", () => ({
	writeProgressFile: vi.fn(),
	computeProgressSummary: vi.fn(),
	formatProgressSummary: vi.fn(),
}));

import { discoverAgents, dispatchAgent, dispatchParallel, getFinalOutput, checkCostBudget, hasWriteToolCalls } from "../../dispatch.ts";
import { saveState } from "../orchestrator-state.ts";
import { getCurrentSha, computeChangedFiles, resetToSha, squashTaskCommits } from "../git-utils.ts";
import { parseReviewOutput, hasCriticalFindings } from "../../review-parser.ts";
import { getConfig } from "../../config.ts";
import { runExecutePhase, runValidation } from "./execute.ts";
import { runCrossTaskValidation, shouldRunValidation } from "../cross-task-validation.ts";
import { captureBaseline } from "../test-baseline.ts";
import { resolveFailureAction } from "../failure-taxonomy.ts";
import { computeProgressSummary, formatProgressSummary } from "../progress.ts";
import type { AgentProfile, DispatchResult, CostCheckResult } from "../../dispatch.ts";

const mockRunCrossTaskValidation = vi.mocked(runCrossTaskValidation);
const mockShouldRunValidation = vi.mocked(shouldRunValidation);
const mockCaptureBaseline = vi.mocked(captureBaseline);
const mockResolveFailureAction = vi.mocked(resolveFailureAction);
const mockComputeProgressSummary = vi.mocked(computeProgressSummary);
const mockFormatProgressSummary = vi.mocked(formatProgressSummary);

const mockGetConfig = vi.mocked(getConfig);

const mockDiscoverAgents = vi.mocked(discoverAgents);
const mockDispatchAgent = vi.mocked(dispatchAgent);
const mockDispatchParallel = vi.mocked(dispatchParallel);
const mockGetFinalOutput = vi.mocked(getFinalOutput);
const mockCheckCostBudget = vi.mocked(checkCostBudget);
const mockSaveState = vi.mocked(saveState);
const mockGetCurrentSha = vi.mocked(getCurrentSha);
const mockComputeChangedFiles = vi.mocked(computeChangedFiles);
const mockResetToSha = vi.mocked(resetToSha);
const mockSquashTaskCommits = vi.mocked(squashTaskCommits);
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

function makeCtx(cwd = "/fake/project") {
	return {
		cwd,
		hasUI: true,
		ui: {
			select: vi.fn(),
			confirm: vi.fn(),
			input: vi.fn(),
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
		},
	} as any;
}

const fakeCtx = makeCtx();

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
	mockSquashTaskCommits.mockResolvedValue({ sha: "squashed123", success: true });
	mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
	mockComputeProgressSummary.mockReturnValue({
		tasksCompleted: 1, tasksRemaining: 0, tasksSkipped: 0,
		cumulativeCost: 0.03, estimatedRemainingCost: 0, currentTaskTitle: "Task 1",
	});
	mockFormatProgressSummary.mockReturnValue("Progress: 1 done, 0 remaining | Cost: $0.03");
	mockGetConfig.mockReturnValue({ validationCommand: "", testCommand: "", validationCadence: "every", validationInterval: 3 } as any);
	mockShouldRunValidation.mockReturnValue(false);
	mockResolveFailureAction.mockImplementation((type) => {
		const defaults: Record<string, string> = {
			"test-regression": "stop-show-diff",
			"test-flake": "warn-continue",
			"validation-failure": "retry-then-escalate",
			"impl-crash": "retry-then-escalate",
		};
		return (defaults[type] || "escalate") as any;
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
			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState();
			const result = await runExecutePhase(state, ctx);
			expect(ctx.ui.select).toHaveBeenCalled();
			expect(result.tasks[0].status).toBe("skipped");
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
			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.select).toHaveBeenCalled();
			const selectCall = ctx.ui.select.mock.calls[0];
			expect(selectCall[1]).toEqual(expect.arrayContaining(["Retry", "Skip", "Abort"]));
			expect(result.tasks[0].status).toBe("skipped");
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
		it("passes both spec and quality reviews in parallel", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockParseReviewOutput.mockReturnValue({
				status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
			});

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].reviewsPassed).toContain("spec");
			expect(result.tasks[0].reviewsPassed).toContain("quality");
			expect(result.tasks[0].status).toBe("complete");
		});

		it("retries on review failure with parallel fix loop", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			// First round: spec fails. After fix, both pass.
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
			expect(result.tasks[0].reviewsPassed).toContain("quality");
		});

		it("escalates after max review retries", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockParseReviewOutput.mockReturnValue({
				status: "fail",
				findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix"], summary: "fail" },
			});

			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState({
				config: {
					tddMode: "tdd", reviewMode: "iterative", executionMode: "auto",
					batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 2,
				},
			});
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.select).toHaveBeenCalled();
		});

		it("escalates on inconclusive review", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockParseReviewOutput.mockReturnValue({
				status: "inconclusive",
				rawOutput: "garbage",
				parseError: "no JSON",
			});

			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.select).toHaveBeenCalled();
		});
	});

	// --- Quality review ---

	describe("quality review", () => {
		it("dispatches spec and quality reviewers together in parallel", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockParseReviewOutput.mockReturnValue({
				status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
			});

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			// Both reviewers dispatched via dispatchParallel
			expect(mockDispatchParallel).toHaveBeenCalled();
			const parallelCall = mockDispatchParallel.mock.calls[0];
			const agentNames = parallelCall[0].map((a: any) => a.name);
			expect(agentNames).toContain("spec-reviewer");
			expect(agentNames).toContain("quality-reviewer");
		});

		it("retries on quality review failure with fix loop (parallel re-review)", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			// First parallel: spec passes, quality fails. Second parallel: both pass.
			mockParseReviewOutput
				.mockReturnValueOnce({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } }) // spec (round 1)
				.mockReturnValueOnce({ status: "fail", findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad quality" }], mustFix: ["fix"], summary: "fail" } }) // quality (round 1)
				.mockReturnValue({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } }); // all pass (round 2)

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].reviewsPassed).toContain("quality");
			expect(result.tasks[0].fixAttempts).toBe(1);
		});

		it("escalates after max review retries (parallel)", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			// All reviews fail
			mockParseReviewOutput.mockReturnValue({
				status: "fail", findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix"], summary: "fail" },
			});

			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState({
				config: {
					tddMode: "tdd", reviewMode: "iterative", executionMode: "auto",
					batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 2,
				},
			});
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.select).toHaveBeenCalled();
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
			// First call: spec+quality parallel (pass), second call: optional parallel (fail)
			mockDispatchParallel
				.mockResolvedValueOnce([makeResult(), makeResult()])  // spec+quality
				.mockResolvedValueOnce([makeResult()]);               // optional (security)
			mockGetFinalOutput.mockReturnValue('{"passed":false,"findings":[{"severity":"critical","file":"a.ts","issue":"vuln"}],"mustFix":[],"summary":"critical issue"}');
			mockParseReviewOutput
				.mockReturnValueOnce({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } }) // spec (parallel)
				.mockReturnValueOnce({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } }) // quality (parallel)
				.mockReturnValueOnce({
					status: "fail",
					findings: { passed: false, findings: [{ severity: "critical", file: "a.ts", issue: "vuln" }], mustFix: [], summary: "critical" },
				}); // optional (security)
			mockHasCriticalFindings.mockReturnValue(true);

			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.select).toHaveBeenCalled();
		});

		it("skips optional reviews when no optional reviewers available", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockParseReviewOutput.mockReturnValue({
				status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
			});
			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			// dispatchParallel called once for spec+quality, but NOT for optional reviewers
			expect(mockDispatchParallel).toHaveBeenCalledTimes(1);
			expect(result.tasks[0].status).toBe("complete");
		});
	});

	// --- Parallel reviews (D4) ---

	describe("parallel reviews (D4)", () => {
		it("dispatches spec and quality reviews in parallel via dispatchParallel", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockGetFinalOutput.mockReturnValue('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');
			mockParseReviewOutput.mockReturnValue({
				status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
			});

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			// dispatchParallel should be called for spec+quality
			expect(mockDispatchParallel).toHaveBeenCalled();
			const parallelCall = mockDispatchParallel.mock.calls[0];
			const agentNames = parallelCall[0].map((a: any) => a.name);
			expect(agentNames).toContain("spec-reviewer");
			expect(agentNames).toContain("quality-reviewer");
			expect(result.tasks[0].status).toBe("complete");
		});

		it("re-runs BOTH reviews after a fix when one fails", async () => {
			setupDefaultMocks();
			let parallelCallCount = 0;
			mockDispatchParallel.mockImplementation(async () => {
				parallelCallCount++;
				return [makeResult(), makeResult()];
			});

			// First parallel: spec passes, quality fails. Second parallel: both pass.
			mockParseReviewOutput
				.mockReturnValueOnce({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } })
				.mockReturnValueOnce({ status: "fail", findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix"], summary: "fail" } })
				.mockReturnValue({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } });

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			// Two parallel dispatches: initial + after fix
			expect(parallelCallCount).toBe(2);
			expect(result.tasks[0].status).toBe("complete");
		});

		it("escalates after maxRetries when reviews keep failing", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockParseReviewOutput.mockReturnValue({
				status: "fail",
				findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix"], summary: "fail" },
			});

			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState({
				config: {
					tddMode: "tdd", reviewMode: "iterative", executionMode: "auto",
					batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 2,
				},
			});
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.select).toHaveBeenCalled();
			expect(result.tasks[0].status).toBe("skipped");
		});

		it("completes when both reviews pass first try — no fix loop", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockParseReviewOutput.mockReturnValue({
				status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
			});

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].fixAttempts).toBe(0);
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

		it("squashes commits after task completion and stores commitSha", async () => {
			setupDefaultMocks();
			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(mockSquashTaskCommits).toHaveBeenCalledWith(
				"/fake/project",
				"abc123",  // gitShaBeforeImpl
				1,         // task id
				"Task 1",  // task title
			);
			expect(result.tasks[0].commitSha).toBe("squashed123");
		});

		it("warns but does not block when squash fails", async () => {
			setupDefaultMocks();
			mockSquashTaskCommits.mockResolvedValue({ sha: "", success: false, error: "squash error" });

			const ctx = makeCtx();
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			expect(result.tasks[0].status).toBe("complete");
			expect(result.tasks[0].commitSha).toBeUndefined();
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("squash"), "warning");
		});

		it("displays progress summary after each task completion", async () => {
			setupDefaultMocks();
			const ctx = makeCtx();
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			expect(mockComputeProgressSummary).toHaveBeenCalled();
			expect(mockFormatProgressSummary).toHaveBeenCalled();
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Progress"),
				"info",
			);
		});

		it("populates task.summary with title, status, and changedFiles", async () => {
			setupDefaultMocks();
			mockComputeChangedFiles.mockResolvedValue(["src/a.ts", "test/a.test.ts"]);

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].summary).toBeDefined();
			expect(result.tasks[0].summary!.title).toBe("Task 1");
			expect(result.tasks[0].summary!.status).toBe("complete");
			expect(result.tasks[0].summary!.changedFiles).toContain("src/a.ts");
		});
	});

	// --- Context forwarding (D6) ---

	describe("context forwarding (D6)", () => {
		it("passes prior completed task summaries to buildImplPrompt", async () => {
			setupDefaultMocks();

			const state = makeState({
				tasks: [
					makeTask({ id: 1, title: "Task 1", status: "complete", summary: { title: "Task 1", status: "complete", changedFiles: ["src/a.ts"] } }),
					makeTask({ id: 2, title: "Task 2", status: "pending" }),
				],
				currentTaskIndex: 1,
			});

			const result = await runExecutePhase(state, fakeCtx);

			// Check that the impl dispatch for Task 2 includes prior context
			const implCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "implementer");
			expect(implCalls.length).toBeGreaterThanOrEqual(1);
			const implPrompt = implCalls[0][1];
			expect(implPrompt).toContain("Prior tasks");
			expect(implPrompt).toContain("Task 1");
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

	// --- New: UI escalation and streaming ---

	describe("UI escalation", () => {
		it("calls ctx.ui.select for task escalation (Retry/Skip/Abort)", async () => {
			setupDefaultMocks();
			mockDispatchAgent.mockResolvedValue({ ...makeResult(), exitCode: 1, errorMessage: "compilation error" });
			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");

			const state = makeState({ tasks: [makeTask()] });
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.select).toHaveBeenCalled();
			const selectCall = ctx.ui.select.mock.calls[0];
			expect(selectCall[1]).toEqual(expect.arrayContaining(["Retry", "Skip", "Abort"]));
			expect(result.tasks[0].status).toBe("skipped");
		});

		it("aborts workflow when user selects Abort on escalation", async () => {
			setupDefaultMocks();
			mockDispatchAgent.mockResolvedValue({ ...makeResult(), exitCode: 1, errorMessage: "fail" });
			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Abort");

			const state = makeState({ tasks: [makeTask()] });
			const result = await runExecutePhase(state, ctx);

			expect(result.error).toBeDefined();
		});

		it("passes onStreamEvent to dispatchAgent and updates status bar", async () => {
			setupDefaultMocks();
			const ctx = makeCtx();

			mockDispatchAgent.mockImplementation(async (agent, task, cwd, signal, onUpdate, onStreamEvent) => {
				if (onStreamEvent) {
					onStreamEvent({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
				}
				return makeResult();
			});

			const state = makeState({ tasks: [makeTask()], config: { reviewMode: "iterative", executionMode: "auto", tddMode: "tdd", batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 } });
			await runExecutePhase(state, ctx);

			expect(ctx.ui.setStatus).toHaveBeenCalledWith("workflow", expect.stringContaining("read"));
		});

		it("updates progress widget after task completion", async () => {
			setupDefaultMocks();
			const ctx = makeCtx();

			const state = makeState({ tasks: [makeTask(), makeTask({ id: 2, title: "Task 2" })], config: { reviewMode: "iterative", executionMode: "auto", tddMode: "tdd", batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 } });
			await runExecutePhase(state, ctx);

			expect(ctx.ui.setWidget).toHaveBeenCalledWith("workflow-progress", expect.any(Array));
		});
	});

	// --- Escalate with rollback option ---

	describe("escalate with rollback option", () => {
		it("offers Rollback alongside Retry/Skip/Abort", async () => {
			setupDefaultMocks();
			mockGetCurrentSha.mockResolvedValue("abc123sha");
			const state = makeState();
			const ctx = makeCtx();

			mockDispatchAgent.mockResolvedValue(makeResult({ exitCode: 1, errorMessage: "Failed" }));
			mockResetToSha.mockResolvedValue(true);

			// User selects Rollback first → triggers resetToSha, then on retry the impl fails again → Skip
			ctx.ui.select
				.mockResolvedValueOnce("Rollback")
				.mockResolvedValueOnce("Skip");

			const result = await runExecutePhase(state, ctx);

			// Verify Rollback was offered in the select options
			const selectCalls = ctx.ui.select.mock.calls;
			expect(selectCalls[0][1]).toContain("Rollback");

			// Verify resetToSha was called with the saved SHA
			expect(mockResetToSha).toHaveBeenCalledWith(ctx.cwd, "abc123sha");
		});

		it("resets to saved SHA and retries when Rollback selected", async () => {
			setupDefaultMocks();
			const state = makeState({
				tasks: [makeTask(), makeTask({ id: 2, title: "Task 2", status: "pending" })],
			});
			const ctx = makeCtx();

			// First impl fails, user selects Rollback, second impl (retry) succeeds,
			// then remaining dispatches succeed
			let implCallCount = 0;
			mockDispatchAgent.mockImplementation(async (agent) => {
				if (agent.name === "implementer") {
					implCallCount++;
					if (implCallCount === 1) {
						return makeResult({ exitCode: 1, errorMessage: "Failed" });
					}
				}
				return makeResult({ exitCode: 0 });
			});
			mockResetToSha.mockResolvedValue(true);
			mockParseReviewOutput.mockReturnValue({
				status: "pass",
				findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
			});

			ctx.ui.select.mockResolvedValueOnce("Rollback");

			const result = await runExecutePhase(state, ctx);

			expect(mockResetToSha).toHaveBeenCalled();
			// The impl was dispatched at least twice (first fail + retry)
			const implCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "implementer");
			expect(implCalls.length).toBeGreaterThanOrEqual(2);
		});

		it("includes Rollback option in all escalation contexts", async () => {
			setupDefaultMocks();
			// Make spec review fail repeatedly to trigger escalation
			mockParseReviewOutput.mockReturnValue({
				status: "fail",
				findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix"], summary: "fail" },
			});

			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState({
				config: {
					tddMode: "tdd", reviewMode: "iterative", executionMode: "auto",
					batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 2,
				},
			});
			await runExecutePhase(state, ctx);

			// All escalation calls should include Rollback
			for (const call of ctx.ui.select.mock.calls) {
				expect(call[1]).toContain("Rollback");
			}
		});

		it("resets task metadata on rollback for clean retry", async () => {
			setupDefaultMocks();
			mockGetCurrentSha.mockResolvedValue("abc123sha");
			mockResetToSha.mockResolvedValue(true);
			mockComputeChangedFiles.mockResolvedValue(["src/changed.ts", "src/other.ts"]);

			// First impl fails → Rollback → retry succeeds
			let implCallCount = 0;
			mockDispatchAgent.mockImplementation(async (agent) => {
				if (agent.name === "implementer") {
					implCallCount++;
					if (implCallCount === 1) return makeResult({ exitCode: 1, errorMessage: "Failed" });
				}
				return makeResult();
			});
			mockParseReviewOutput.mockReturnValue({
				status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
			});

			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValueOnce("Rollback");

			const state = makeState({
				tasks: [makeTask({
					reviewsPassed: ["spec"],
					reviewsFailed: ["quality"],
					fixAttempts: 2,
				})],
			});
			const result = await runExecutePhase(state, ctx);

			// After rollback, task retries and completes
			expect(result.tasks[0].status).toBe("complete");
			// Verify notify was called with file count info
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Rolling back"),
				"info",
			);
		});

		it("notifies how many files will be reverted on rollback", async () => {
			setupDefaultMocks();
			mockGetCurrentSha.mockResolvedValue("abc123sha");
			mockResetToSha.mockResolvedValue(true);
			mockComputeChangedFiles.mockResolvedValue(["a.ts", "b.ts", "c.ts"]);

			mockDispatchAgent.mockResolvedValue(makeResult({ exitCode: 1, errorMessage: "Failed" }));

			const ctx = makeCtx();
			ctx.ui.select
				.mockResolvedValueOnce("Rollback")
				.mockResolvedValueOnce("Skip");

			const state = makeState();
			await runExecutePhase(state, ctx);

			// Check that notify mentioned the file count
			const notifyCalls = ctx.ui.notify.mock.calls.map((c: any) => c[0]);
			const rollbackNotify = notifyCalls.find((msg: string) => msg.includes("Rolling back"));
			expect(rollbackNotify).toContain("3 files");
		});
	});

	// --- Validation gate ---

	describe("validation gate (validationCommand)", () => {
		it("skips validation gate when validationCommand is empty string", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({ validationCommand: "" } as any);

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.tasks[0].status).toBe("complete");
		});

		it("proceeds to reviews when validation command succeeds", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({ validationCommand: "true" } as any);

			const state = makeState();
			const ctx = makeCtx("/tmp");
			const result = await runExecutePhase(state, ctx);

			expect(result.tasks[0].status).toBe("complete");
			expect(result.tasks[0].reviewsPassed).toContain("spec");
		});

		it("enters escalation when validation command fails", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({ validationCommand: "false" } as any);

			const ctx = makeCtx("/tmp");
			ctx.ui.select.mockResolvedValue("Skip");

			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.select).toHaveBeenCalled();
			const selectCall = ctx.ui.select.mock.calls[0];
			expect(selectCall[0]).toContain("Validation");
			expect(result.tasks[0].status).toBe("skipped");
		});

		it("retries after validation failure when user selects Retry", async () => {
			setupDefaultMocks();
			// getConfig calls: 1=baseline, 2=val gate (fail), 3=re-val after auto-fix (fail),
			// 4=val gate on retry (pass), etc.
			let callCount = 0;
			mockGetConfig.mockImplementation(() => {
				callCount++;
				return { validationCommand: callCount <= 3 ? "false" : "true", testCommand: "", validationCadence: "every", validationInterval: 3 } as any;
			});

			const ctx = makeCtx("/tmp");
			ctx.ui.select.mockResolvedValueOnce("Retry");

			// Two tasks: after retry of task 1, loop advances to task 2 which completes
			const state = makeState({
				tasks: [makeTask(), makeTask({ id: 2, title: "Task 2", status: "pending" })],
			});
			const result = await runExecutePhase(state, ctx);

			// Escalation after auto-fix fails, user retries, task 2 completes
			expect(ctx.ui.select).toHaveBeenCalledTimes(1);
			expect(result.tasks[1].status).toBe("complete");
		});

		it("auto-fix retry: dispatches implementer with error on first validation failure, then re-validates", async () => {
			setupDefaultMocks();

			// getConfig is called: 1=baseline capture, 2=validation gate, 3=re-validation
			// Validation fails on call 2, passes on call 3 (after auto-fix)
			let validationCallCount = 0;
			mockGetConfig.mockImplementation(() => {
				validationCallCount++;
				return { validationCommand: validationCallCount <= 2 ? "false" : "true", testCommand: "", validationCadence: "every", validationInterval: 3 } as any;
			});

			const ctx = makeCtx("/tmp");
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			// Should have dispatched implementer at least twice (impl + auto-fix)
			const implCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "implementer");
			expect(implCalls.length).toBeGreaterThanOrEqual(2);
			// Task should complete (validation passed on retry)
			expect(result.tasks[0].status).toBe("complete");
		});

		it("auto-fix retry: escalates after auto-fix still fails validation", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({ validationCommand: "false" } as any);

			const ctx = makeCtx("/tmp");
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			// After auto-fix attempt, validation still fails → escalate
			expect(ctx.ui.select).toHaveBeenCalled();
			expect(result.tasks[0].status).toBe("skipped");
		});
	});

	// --- Cross-task validation ---

	describe("cross-task validation", () => {
		it("captures baseline on first task when testCommand is configured", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({
				validationCommand: "",
				testCommand: "npx vitest run",
				validationCadence: "every",
				validationInterval: 3,
			} as any);
			mockShouldRunValidation.mockReturnValue(true);
			mockCaptureBaseline.mockResolvedValue({
				capturedAt: Date.now(),
				sha: "abc",
				command: "npx vitest run",
				results: [],
				knownFailures: [],
			});
			mockRunCrossTaskValidation.mockResolvedValue({
				passed: true,
				classified: { newFailures: [], preExisting: [], flakeCandidates: [], newPasses: [] },
				flakyTests: [],
				blockingFailures: [],
			});

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(mockCaptureBaseline).toHaveBeenCalledWith("npx vitest run", fakeCtx.cwd);
			expect(result.tasks[0].status).toBe("complete");
		});

		it("skips cross-task validation when testCommand is empty", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({
				validationCommand: "",
				testCommand: "",
				validationCadence: "every",
				validationInterval: 3,
			} as any);

			const state = makeState();
			await runExecutePhase(state, fakeCtx);

			expect(mockRunCrossTaskValidation).not.toHaveBeenCalled();
		});

		it("skips validation when shouldRunValidation returns false", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({
				validationCommand: "",
				testCommand: "npx vitest run",
				validationCadence: "every-N",
				validationInterval: 3,
			} as any);
			mockShouldRunValidation.mockReturnValue(false);
			mockCaptureBaseline.mockResolvedValue({
				capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
				results: [], knownFailures: [],
			});

			const state = makeState();
			await runExecutePhase(state, fakeCtx);

			expect(mockRunCrossTaskValidation).not.toHaveBeenCalled();
		});

		it("escalates on blocking failures from cross-task validation", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({
				validationCommand: "",
				testCommand: "npx vitest run",
				validationCadence: "every",
				validationInterval: 3,
			} as any);
			mockShouldRunValidation.mockReturnValue(true);
			mockCaptureBaseline.mockResolvedValue({
				capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
				results: [{ name: "test-a", passed: true }], knownFailures: [],
			});
			mockRunCrossTaskValidation.mockResolvedValue({
				passed: false,
				classified: {
					newFailures: [{ name: "test-a", passed: false }],
					preExisting: [],
					flakeCandidates: [{ name: "test-a", passed: false }],
					newPasses: [],
				},
				flakyTests: [],
				blockingFailures: [{ name: "test-a", passed: false }],
			});

			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.select).toHaveBeenCalled();
			const callArgs = ctx.ui.select.mock.calls[0][0];
			expect(callArgs).toContain("test regression");
		});

		it("warns and continues on flaky tests", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({
				validationCommand: "",
				testCommand: "npx vitest run",
				validationCadence: "every",
				validationInterval: 3,
			} as any);
			mockShouldRunValidation.mockReturnValue(true);
			mockCaptureBaseline.mockResolvedValue({
				capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
				results: [{ name: "test-a", passed: true }], knownFailures: [],
			});
			mockRunCrossTaskValidation.mockResolvedValue({
				passed: true,
				classified: {
					newFailures: [{ name: "test-a", passed: false }],
					preExisting: [],
					flakeCandidates: [{ name: "test-a", passed: false }],
					newPasses: [],
				},
				flakyTests: ["test-a"],
				blockingFailures: [],
			});

			const ctx = makeCtx();
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("flaky"), "warning");
			expect(result.tasks[0].status).toBe("complete");
		});

		it("stores baseline in state.testBaseline after capture", async () => {
			setupDefaultMocks();
			const fakeBaseline = {
				capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
				results: [{ name: "test-a", passed: true }], knownFailures: [],
			};
			mockGetConfig.mockReturnValue({
				validationCommand: "",
				testCommand: "npx vitest run",
				validationCadence: "every",
				validationInterval: 3,
			} as any);
			mockShouldRunValidation.mockReturnValue(true);
			mockCaptureBaseline.mockResolvedValue(fakeBaseline);
			mockRunCrossTaskValidation.mockResolvedValue({
				passed: true,
				classified: { newFailures: [], preExisting: [], flakeCandidates: [], newPasses: [] },
				flakyTests: [],
				blockingFailures: [],
			});

			const state = makeState();
			const result = await runExecutePhase(state, fakeCtx);

			expect(result.testBaseline).toBeDefined();
			expect(result.testBaseline!.sha).toBe("abc");
		});
	});

	// --- Failure taxonomy integration ---

	describe("failure taxonomy integration", () => {
		it("calls resolveFailureAction for test-regression on cross-task validation failure", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({
				validationCommand: "",
				testCommand: "npx vitest run",
				validationCadence: "every",
				validationInterval: 3,
			} as any);
			mockShouldRunValidation.mockReturnValue(true);
			mockCaptureBaseline.mockResolvedValue({
				capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
				results: [{ name: "test-a", passed: true }], knownFailures: [],
			});
			mockRunCrossTaskValidation.mockResolvedValue({
				passed: false,
				classified: {
					newFailures: [{ name: "test-a", passed: false }],
					preExisting: [], flakeCandidates: [], newPasses: [],
				},
				flakyTests: [],
				blockingFailures: [{ name: "test-a", passed: false }],
			});
			mockResolveFailureAction.mockReturnValue("stop-show-diff");

			const ctx = makeCtx();
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState();
			await runExecutePhase(state, ctx);

			expect(mockResolveFailureAction).toHaveBeenCalledWith("test-regression");
		});

		it("calls resolveFailureAction for test-flake and warns when action is warn-continue", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({
				validationCommand: "",
				testCommand: "npx vitest run",
				validationCadence: "every",
				validationInterval: 3,
			} as any);
			mockShouldRunValidation.mockReturnValue(true);
			mockCaptureBaseline.mockResolvedValue({
				capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
				results: [{ name: "test-a", passed: true }], knownFailures: [],
			});
			mockRunCrossTaskValidation.mockResolvedValue({
				passed: true,
				classified: {
					newFailures: [], preExisting: [],
					flakeCandidates: [{ name: "test-a", passed: false }],
					newPasses: [],
				},
				flakyTests: ["test-a"],
				blockingFailures: [],
			});
			mockResolveFailureAction.mockReturnValue("warn-continue");

			const ctx = makeCtx();
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			expect(mockResolveFailureAction).toHaveBeenCalledWith("test-flake");
			expect(result.tasks[0].status).toBe("complete");
		});

		it("calls resolveFailureAction for validation-failure on validation gate failure", async () => {
			setupDefaultMocks();
			mockGetConfig.mockReturnValue({ validationCommand: "false", testCommand: "", validationCadence: "every", validationInterval: 3 } as any);
			mockResolveFailureAction.mockReturnValue("retry-then-escalate");

			const ctx = makeCtx("/tmp");
			ctx.ui.select.mockResolvedValue("Skip");
			const state = makeState();
			await runExecutePhase(state, ctx);

			expect(mockResolveFailureAction).toHaveBeenCalledWith("validation-failure");
		});
	});

	// --- runValidation unit tests ---

	describe("runValidation", () => {
		it("returns success for a passing command", async () => {
			const result = await runValidation("echo hello", "/tmp");
			expect(result.success).toBe(true);
		});

		it("returns failure with stderr for a failing command", async () => {
			const result = await runValidation("bash -c 'echo err >&2; exit 1'", "/tmp");
			expect(result.success).toBe(false);
			expect(result.error).toContain("err");
		});

		it("returns success true when command is empty string", async () => {
			const result = await runValidation("", "/tmp");
			expect(result.success).toBe(true);
		});

		it("returns failure for a nonexistent command", async () => {
			const result = await runValidation("nonexistent_command_xyz_12345", "/tmp");
			expect(result.success).toBe(false);
		});
	});

	// --- Full D1-D8 integration ---

	describe("full D1-D8 integration", () => {
		it("complete task flow: impl → parallel review → squash → summary → advance", async () => {
			setupDefaultMocks();
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockParseReviewOutput.mockReturnValue({
				status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
			});
			mockSquashTaskCommits.mockResolvedValue({ sha: "squashed-sha", success: true });
			mockComputeProgressSummary.mockReturnValue({
				tasksCompleted: 1, tasksRemaining: 0, tasksSkipped: 0,
				cumulativeCost: 0.05, estimatedRemainingCost: 0, currentTaskTitle: "Task 1",
			});
			mockFormatProgressSummary.mockReturnValue("Progress: 1 done");

			const state = makeState({
				tasks: [makeTask({ id: 1, title: "Task 1", status: "pending" })],
			});
			const result = await runExecutePhase(state, fakeCtx);

			// Verify complete flow
			expect(result.tasks[0].status).toBe("complete");
			expect(result.tasks[0].commitSha).toBe("squashed-sha");
			expect(result.tasks[0].summary).toBeDefined();
			expect(mockDispatchParallel).toHaveBeenCalled(); // parallel reviews
			expect(mockSquashTaskCommits).toHaveBeenCalled(); // squash
			expect(mockComputeProgressSummary).toHaveBeenCalled(); // progress
			expect(result.phase).toBe("finalize");
		});
	});

	// --- Reviewer write-guard ---

	describe("reviewer write-guard", () => {
		it("warns when parallel review results contain write tool calls", async () => {
			setupDefaultMocks();
			const mockHasWrite = vi.mocked(hasWriteToolCalls);
			// First parallel result has writes
			mockHasWrite
				.mockReturnValueOnce(true)
				.mockReturnValue(false);
			mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
			mockParseReviewOutput.mockReturnValue({
				status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
			});

			const ctx = makeCtx();
			const state = makeState();
			const result = await runExecutePhase(state, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("write operations"), "warning");
			expect(result.tasks[0].status).toBe("complete");
		});
	});
});
