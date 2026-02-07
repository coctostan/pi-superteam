import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createInitialState, type OrchestratorState, type TaskExecState } from "../orchestrator-state.ts";

// Mock dispatch module
vi.mock("../../dispatch.js", () => ({
	discoverAgents: vi.fn(),
	dispatchAgent: vi.fn(),
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

import { discoverAgents, dispatchAgent, getFinalOutput } from "../../dispatch.ts";
import { saveState } from "../orchestrator-state.ts";
import { runPlanDraftPhase } from "./plan.ts";
import type { AgentProfile, DispatchResult } from "../../dispatch.ts";

const mockDiscoverAgents = vi.mocked(discoverAgents);
const mockDispatchAgent = vi.mocked(dispatchAgent);
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

function makeDispatchResult(messages: any[] = []): DispatchResult {
	return {
		agent: "test",
		agentSource: "package",
		task: "test",
		exitCode: 0,
		messages,
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

const fakeCtx = {
	cwd: "/fake/project",
} as any;

describe("runPlanDraftPhase", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-phase-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("sets error when no scout agent found", async () => {
		mockDiscoverAgents.mockReturnValue({ agents: [], projectAgentsDir: null });

		const state = createInitialState("Build an API");
		const result = await runPlanDraftPhase(state, fakeCtx);

		expect(result.error).toBe("No scout agent found");
	});

	it("sets error when no implementer agent found", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult());
		mockGetFinalOutput.mockReturnValue("scout output");

		const state = createInitialState("Build an API");
		const result = await runPlanDraftPhase(state, fakeCtx);

		expect(result.error).toBe("No implementer agent found");
	});

	it("dispatches scout with buildScoutPrompt", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult());
		mockGetFinalOutput.mockReturnValue("scout output");

		const state = createInitialState("Build an API");
		// Will fail because plan file won't exist, but we can check scout was dispatched
		await runPlanDraftPhase(state, fakeCtx);

		const scoutAgent = mockDispatchAgent.mock.calls[0][0];
		expect(scoutAgent.name).toBe("scout");
		// First arg is agent, second is task (prompt)
		const scoutPrompt = mockDispatchAgent.mock.calls[0][1];
		expect(scoutPrompt).toContain("/fake/project");
	});

	it("sets error when plan file not written", async () => {
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult());
		mockGetFinalOutput.mockReturnValue("scout output");

		const state = createInitialState("Build an API");
		const result = await runPlanDraftPhase(state, fakeCtx);

		expect(result.error).toBe("Plan file not written");
	});

	it("generates correct planPath with slugified description", async () => {
		const ctx = { cwd: tmpDir } as any;

		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockGetFinalOutput.mockReturnValue("scout output");

		// When implementer is dispatched, create the plan file
		mockDispatchAgent.mockImplementation(async (agent) => {
			if (agent.name === "implementer") {
				// Create the plan file that the prompt references
				const plansDir = path.join(tmpDir, "docs", "plans");
				fs.mkdirSync(plansDir, { recursive: true });
				// Find the plan path from the call args - we'll just write any matching file
				const files = fs.readdirSync(plansDir).filter((f) => f.endsWith(".md"));
				if (files.length === 0) {
					// We need to figure out the filename. Let's use the prompt to find it.
					const prompt = mockDispatchAgent.mock.calls[mockDispatchAgent.mock.calls.length - 1][1];
					const pathMatch = prompt.match(/docs\/plans\/[^\s]+\.md/);
					if (pathMatch) {
						const fullPath = path.join(tmpDir, pathMatch[0]);
						fs.mkdirSync(path.dirname(fullPath), { recursive: true });
						fs.writeFileSync(fullPath, "```superteam-tasks\n- title: Setup\n  description: Init project\n  files: [src/index.ts]\n```");
					}
				}
			}
			return makeDispatchResult();
		});

		const state = createInitialState("Build a REST API!!!");
		const result = await runPlanDraftPhase(state, ctx);

		// Check the planPath contains slugified version
		expect(result.planPath).toBeDefined();
		expect(result.planPath).toContain("docs/plans/");
		expect(result.planPath).toContain("build-a-rest-api");
		expect(result.planPath).not.toContain("!!!");
	});

	it("parses tasks from plan content and sets state correctly", async () => {
		const ctx = { cwd: tmpDir } as any;
		const planContent = [
			"# Plan",
			"",
			"```superteam-tasks",
			"- title: Setup project",
			"  description: Initialize the project structure",
			"  files: [src/index.ts, package.json]",
			"- title: Add models",
			"  description: Create data models",
			"  files: [src/models.ts]",
			"```",
		].join("\n");

		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockGetFinalOutput.mockReturnValue("scout output");

		mockDispatchAgent.mockImplementation(async (agent, task) => {
			if (agent.name === "implementer") {
				const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
				if (pathMatch) {
					const fullPath = path.join(tmpDir, pathMatch[0]);
					fs.mkdirSync(path.dirname(fullPath), { recursive: true });
					fs.writeFileSync(fullPath, planContent);
				}
			}
			return makeDispatchResult();
		});

		const state = createInitialState("my project");
		const result = await runPlanDraftPhase(state, ctx);

		expect(result.error).toBeUndefined();
		expect(result.phase).toBe("plan-review");
		expect(result.tasks).toHaveLength(2);
		expect(result.tasks[0].title).toBe("Setup project");
		expect(result.tasks[0].files).toEqual(["src/index.ts", "package.json"]);
		expect(result.tasks[1].title).toBe("Add models");
		expect(result.currentTaskIndex).toBe(0);
		expect(result.planContent).toBe(planContent);
	});

	it("converts PlanTasks to TaskExecState with correct fields", async () => {
		const ctx = { cwd: tmpDir } as any;
		const planContent = "```superteam-tasks\n- title: Do stuff\n  description: Things\n  files: [a.ts]\n```";

		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockGetFinalOutput.mockReturnValue("scout output");
		mockDispatchAgent.mockImplementation(async (agent, task) => {
			if (agent.name === "implementer") {
				const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
				if (pathMatch) {
					const fullPath = path.join(tmpDir, pathMatch[0]);
					fs.mkdirSync(path.dirname(fullPath), { recursive: true });
					fs.writeFileSync(fullPath, planContent);
				}
			}
			return makeDispatchResult();
		});

		const state = createInitialState("test");
		const result = await runPlanDraftPhase(state, ctx);

		const task = result.tasks[0];
		expect(task.id).toBe(1);
		expect(task.status).toBe("pending");
		expect(task.reviewsPassed).toEqual([]);
		expect(task.reviewsFailed).toEqual([]);
		expect(task.fixAttempts).toBe(0);
		expect(task.gitShaBeforeImpl).toBeUndefined();
	});

	it("calls saveState on success", async () => {
		const ctx = { cwd: tmpDir } as any;
		const planContent = "```superteam-tasks\n- title: Task1\n  description: Desc\n  files: [a.ts]\n```";

		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockGetFinalOutput.mockReturnValue("output");
		mockDispatchAgent.mockImplementation(async (agent, task) => {
			if (agent.name === "implementer") {
				const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
				if (pathMatch) {
					const fullPath = path.join(tmpDir, pathMatch[0]);
					fs.mkdirSync(path.dirname(fullPath), { recursive: true });
					fs.writeFileSync(fullPath, planContent);
				}
			}
			return makeDispatchResult();
		});

		const state = createInitialState("test");
		await runPlanDraftPhase(state, ctx);

		expect(mockSaveState).toHaveBeenCalledOnce();
		expect(mockSaveState).toHaveBeenCalledWith(expect.objectContaining({ phase: "plan-review" }), tmpDir);
	});

	it("retries once when no tasks parsed, then succeeds", async () => {
		const ctx = { cwd: tmpDir } as any;
		let callCount = 0;

		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockGetFinalOutput.mockReturnValue("output");

		mockDispatchAgent.mockImplementation(async (agent, task) => {
			if (agent.name === "implementer") {
				callCount++;
				const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
				if (pathMatch) {
					const fullPath = path.join(tmpDir, pathMatch[0]);
					fs.mkdirSync(path.dirname(fullPath), { recursive: true });
					if (callCount === 1) {
						// First time: no tasks block
						fs.writeFileSync(fullPath, "# Plan\nNo tasks here");
					} else {
						// Retry: fix it
						fs.writeFileSync(fullPath, "```superteam-tasks\n- title: Fixed\n  description: Now with tasks\n  files: [x.ts]\n```");
					}
				}
			}
			return makeDispatchResult();
		});

		const state = createInitialState("test retry");
		const result = await runPlanDraftPhase(state, ctx);

		expect(result.error).toBeUndefined();
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].title).toBe("Fixed");
		// Scout + first implementer + retry implementer = 3 dispatches
		expect(mockDispatchAgent).toHaveBeenCalledTimes(3);
	});

	it("sets error after retry still yields no tasks", async () => {
		const ctx = { cwd: tmpDir } as any;

		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockGetFinalOutput.mockReturnValue("output");

		mockDispatchAgent.mockImplementation(async (agent, task) => {
			if (agent.name === "implementer") {
				const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
				if (pathMatch) {
					const fullPath = path.join(tmpDir, pathMatch[0]);
					fs.mkdirSync(path.dirname(fullPath), { recursive: true });
					// Always write plan without tasks
					fs.writeFileSync(fullPath, "# Plan\nStill no tasks");
				}
			}
			return makeDispatchResult();
		});

		const state = createInitialState("hopeless");
		const result = await runPlanDraftPhase(state, ctx);

		expect(result.error).toBe("Plan has no parseable tasks");
	});

	it("slugifies descriptions with special characters", async () => {
		const ctx = { cwd: tmpDir } as any;
		const planContent = "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```";

		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockGetFinalOutput.mockReturnValue("output");
		mockDispatchAgent.mockImplementation(async (agent, task) => {
			if (agent.name === "implementer") {
				const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
				if (pathMatch) {
					const fullPath = path.join(tmpDir, pathMatch[0]);
					fs.mkdirSync(path.dirname(fullPath), { recursive: true });
					fs.writeFileSync(fullPath, planContent);
				}
			}
			return makeDispatchResult();
		});

		const state = createInitialState("Hello   World!!!  --test-- ");
		const result = await runPlanDraftPhase(state, ctx);

		expect(result.planPath).toContain("hello-world-test");
		expect(result.planPath).not.toMatch(/--/);
	});

	it("truncates slug to 50 characters", async () => {
		const ctx = { cwd: tmpDir } as any;
		const planContent = "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```";

		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockGetFinalOutput.mockReturnValue("output");
		mockDispatchAgent.mockImplementation(async (agent, task) => {
			if (agent.name === "implementer") {
				const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
				if (pathMatch) {
					const fullPath = path.join(tmpDir, pathMatch[0]);
					fs.mkdirSync(path.dirname(fullPath), { recursive: true });
					fs.writeFileSync(fullPath, planContent);
				}
			}
			return makeDispatchResult();
		});

		const longDesc = "a".repeat(100);
		const state = createInitialState(longDesc);
		const result = await runPlanDraftPhase(state, ctx);

		// The slug part should be max 50 chars
		const filename = path.basename(result.planPath!);
		// filename = YYYY-MM-DD-<slug>.md
		const slug = filename.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "");
		expect(slug.length).toBeLessThanOrEqual(50);
	});

	it("passes signal to dispatchAgent", async () => {
		const controller = new AbortController();
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("scout"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
		mockDispatchAgent.mockResolvedValue(makeDispatchResult());
		mockGetFinalOutput.mockReturnValue("output");

		const state = createInitialState("test");
		await runPlanDraftPhase(state, fakeCtx, controller.signal);

		// Scout dispatch should have signal as 4th arg
		expect(mockDispatchAgent.mock.calls[0][3]).toBe(controller.signal);
	});
});
