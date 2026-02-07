import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState, type OrchestratorState, type TaskExecState } from "../orchestrator-state.ts";

// Mock modules
vi.mock("../../dispatch.js", () => ({
	discoverAgents: vi.fn(),
	dispatchAgent: vi.fn(),
	getFinalOutput: vi.fn(),
}));

vi.mock("../orchestrator-state.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../orchestrator-state.ts")>();
	return { ...orig, saveState: vi.fn(), clearState: vi.fn() };
});

vi.mock("../git-utils.js", () => ({
	computeChangedFiles: vi.fn(),
}));

vi.mock("../../review-parser.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../review-parser.ts")>();
	return { ...orig, parseReviewOutput: vi.fn() };
});

vi.mock("../prompt-builder.js", () => ({
	buildFinalReviewPrompt: vi.fn(),
}));

import { discoverAgents, dispatchAgent, getFinalOutput } from "../../dispatch.ts";
import { saveState, clearState } from "../orchestrator-state.ts";
import { computeChangedFiles } from "../git-utils.ts";
import { parseReviewOutput } from "../../review-parser.ts";
import { buildFinalReviewPrompt } from "../prompt-builder.ts";
import { runFinalizePhase } from "./finalize.ts";
import type { AgentProfile, DispatchResult } from "../../dispatch.ts";

const mockDiscoverAgents = vi.mocked(discoverAgents);
const mockDispatchAgent = vi.mocked(dispatchAgent);
const mockGetFinalOutput = vi.mocked(getFinalOutput);
const mockClearState = vi.mocked(clearState);
const mockComputeChangedFiles = vi.mocked(computeChangedFiles);
const mockParseReviewOutput = vi.mocked(parseReviewOutput);
const mockBuildFinalReviewPrompt = vi.mocked(buildFinalReviewPrompt);

function makeAgent(name: string): AgentProfile {
	return { name, description: `${name} agent`, systemPrompt: "", source: "package", filePath: `/agents/${name}.md` };
}

function makeResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
	return {
		agent: "test", agentSource: "package", task: "test", exitCode: 0,
		messages: [], stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 0, turns: 0 },
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
	base.phase = "finalize";
	base.config = {
		tddMode: "tdd", reviewMode: "iterative", executionMode: "auto",
		batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 3,
	};
	base.tasks = [
		makeTask({ id: 1, title: "Task 1", status: "complete", gitShaBeforeImpl: "abc123" }),
		makeTask({ id: 2, title: "Task 2", status: "complete", gitShaBeforeImpl: "def456" }),
	];
	base.totalCostUsd = 0.10;
	return { ...base, ...overrides };
}

const fakeCtx = { cwd: "/fake/project" } as any;

describe("runFinalizePhase", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("no completed tasks", () => {
		it("skips final review and returns report", async () => {
			const state = makeState({
				tasks: [
					makeTask({ id: 1, title: "Task 1", status: "skipped" }),
					makeTask({ id: 2, title: "Task 2", status: "escalated" }),
				],
			});

			const { state: result, report } = await runFinalizePhase(state, fakeCtx);

			expect(result.phase).toBe("done");
			expect(mockDispatchAgent).not.toHaveBeenCalled();
			expect(mockClearState).toHaveBeenCalledWith("/fake/project");
			expect(report).toContain("# Workflow Complete");
			expect(report).toContain("⏭️ Task 1");
			expect(report).toContain("⚠️ Task 2");
			expect(report).toContain("0 completed");
			expect(report).toContain("1 skipped");
			expect(report).toContain("1 escalated");
		});
	});

	describe("with completed tasks and quality-reviewer available", () => {
		it("runs final review and includes findings in report", async () => {
			const state = makeState();
			mockComputeChangedFiles.mockResolvedValue(["src/a.ts", "src/b.ts"]);
			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("quality-reviewer"), makeAgent("implementer")],
				projectAgentsDir: null,
			});
			mockBuildFinalReviewPrompt.mockReturnValue("review prompt");
			mockDispatchAgent.mockResolvedValue(makeResult({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.03, contextTokens: 0, turns: 0 } }));
			mockGetFinalOutput.mockReturnValue("review output");
			mockParseReviewOutput.mockReturnValue({
				status: "pass",
				findings: { passed: true, findings: [], mustFix: [], summary: "All good" },
			});

			const { state: result, report } = await runFinalizePhase(state, fakeCtx);

			expect(result.phase).toBe("done");
			expect(result.totalCostUsd).toBeCloseTo(0.13); // 0.10 + 0.03
			expect(mockComputeChangedFiles).toHaveBeenCalledWith("/fake/project", "abc123");
			expect(mockBuildFinalReviewPrompt).toHaveBeenCalled();
			expect(mockDispatchAgent).toHaveBeenCalledTimes(1);
			expect(mockClearState).toHaveBeenCalledWith("/fake/project");

			expect(report).toContain("# Workflow Complete");
			expect(report).toContain("✅ Task 1");
			expect(report).toContain("✅ Task 2");
			expect(report).toContain("2 completed");
			expect(report).toContain("All good");
			expect(report).toContain("src/a.ts");
			expect(report).toContain("src/b.ts");
		});
	});

	describe("with completed tasks but no quality-reviewer", () => {
		it("skips final review with note", async () => {
			const state = makeState();
			mockComputeChangedFiles.mockResolvedValue(["src/a.ts"]);
			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("implementer")],
				projectAgentsDir: null,
			});

			const { state: result, report } = await runFinalizePhase(state, fakeCtx);

			expect(result.phase).toBe("done");
			expect(mockDispatchAgent).not.toHaveBeenCalled();
			expect(report).toContain("Skipped");
			expect(report).toContain("quality-reviewer");
			expect(mockClearState).toHaveBeenCalledWith("/fake/project");
		});
	});

	describe("uses earliest gitShaBeforeImpl", () => {
		it("picks the first sha among completed tasks", async () => {
			const state = makeState({
				tasks: [
					makeTask({ id: 1, title: "Task 1", status: "skipped" }),
					makeTask({ id: 2, title: "Task 2", status: "complete", gitShaBeforeImpl: "second_sha" }),
					makeTask({ id: 3, title: "Task 3", status: "complete", gitShaBeforeImpl: "third_sha" }),
				],
			});
			mockComputeChangedFiles.mockResolvedValue([]);
			mockDiscoverAgents.mockReturnValue({ agents: [], projectAgentsDir: null });

			await runFinalizePhase(state, fakeCtx);

			expect(mockComputeChangedFiles).toHaveBeenCalledWith("/fake/project", "second_sha");
		});
	});

	describe("report includes all task statuses", () => {
		it("shows pending tasks with pause emoji", async () => {
			const state = makeState({
				tasks: [
					makeTask({ id: 1, title: "Done Task", status: "complete", gitShaBeforeImpl: "sha1" }),
					makeTask({ id: 2, title: "Skipped Task", status: "skipped" }),
					makeTask({ id: 3, title: "Escalated Task", status: "escalated" }),
					makeTask({ id: 4, title: "Pending Task", status: "pending" }),
				],
			});
			mockComputeChangedFiles.mockResolvedValue([]);
			mockDiscoverAgents.mockReturnValue({ agents: [], projectAgentsDir: null });

			const { report } = await runFinalizePhase(state, fakeCtx);

			expect(report).toContain("✅ Done Task");
			expect(report).toContain("⏭️ Skipped Task");
			expect(report).toContain("⚠️ Escalated Task");
			expect(report).toContain("⏸️ Pending Task");
			expect(report).toContain("1 completed");
			expect(report).toContain("1 skipped");
			expect(report).toContain("1 escalated");
		});
	});

	describe("review output parsing failure (inconclusive)", () => {
		it("reports inconclusive review", async () => {
			const state = makeState();
			mockComputeChangedFiles.mockResolvedValue(["src/a.ts"]);
			mockDiscoverAgents.mockReturnValue({
				agents: [makeAgent("quality-reviewer")],
				projectAgentsDir: null,
			});
			mockBuildFinalReviewPrompt.mockReturnValue("review prompt");
			mockDispatchAgent.mockResolvedValue(makeResult());
			mockGetFinalOutput.mockReturnValue("garbage output");
			mockParseReviewOutput.mockReturnValue({
				status: "inconclusive",
				rawOutput: "garbage output",
				parseError: "Could not parse",
			});

			const { report } = await runFinalizePhase(state, fakeCtx);

			expect(report).toContain("Inconclusive");
		});
	});

	describe("cost tracking", () => {
		it("includes total cost in stats section", async () => {
			const state = makeState({ totalCostUsd: 1.23 });
			state.tasks = [makeTask({ status: "skipped" })]; // no completed tasks

			const { report } = await runFinalizePhase(state, fakeCtx);

			expect(report).toContain("$1.23");
		});
	});
});
