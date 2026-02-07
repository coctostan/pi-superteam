// src/workflow/phases/plan-write.acceptance.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../dispatch.js", () => ({
	discoverAgents: vi.fn(),
	dispatchAgent: vi.fn(),
	getFinalOutput: vi.fn(),
}));

vi.mock("../orchestrator-state.js", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../orchestrator-state.ts")>();
	return { ...orig, saveState: vi.fn() };
});

import { discoverAgents, dispatchAgent, getFinalOutput } from "../../dispatch.ts";
import type { AgentProfile, DispatchResult } from "../../dispatch.ts";

const mockDiscoverAgents = vi.mocked(discoverAgents);
const mockDispatchAgent = vi.mocked(dispatchAgent);
const mockGetFinalOutput = vi.mocked(getFinalOutput);

const PLAN_CONTENT = `# Test Plan

## Goal
Test the parser

## superteam-tasks block

\`\`\`superteam-tasks
- title: Setup models
  description: Create data models
  files: [src/models.ts]
- title: Add validation with code examples
  description: |
    Implement validation:
    \`\`\`typescript
    function validate(input: string): boolean {
      return input.length > 0;
    }
    \`\`\`
    Write tests first.
  files: [src/validation.ts, src/validation.test.ts]
- title: Add error handling
  description: Wrap all handlers in try-catch
  files: [src/errors.ts]
\`\`\`
`;

function makeAgent(name: string): AgentProfile {
	return { name, description: name, systemPrompt: "", source: "package", filePath: `/agents/${name}.md` };
}

function makeDispatchResult(cost = 0.2): DispatchResult {
	return {
		agent: "test",
		agentSource: "package",
		task: "",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 0 },
	};
}

function makeState(overrides: any = {}): any {
	return {
		phase: "plan-write",
		brainstorm: { step: "done", scoutOutput: "scout data" },
		config: {},
		userDescription: "Add validation",
		designPath: "docs/plans/2026-02-07-test-design.md",
		designContent: "# Design\nValidation approach...",
		tasks: [],
		currentTaskIndex: 0,
		totalCostUsd: 0,
		startedAt: Date.now(),
		planReviewCycles: 0,
		...overrides,
	};
}

describe("AT-10: plan-write phase end-to-end with complex plan (embedded code fences)", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-at10-"));
		mockDiscoverAgents.mockReturnValue({
			agents: [makeAgent("planner"), makeAgent("implementer")],
			projectAgentsDir: null,
		});
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("parses 3 tasks from a plan with multi-line description containing embedded code fences", async () => {
		const { runPlanWritePhase } = await import("./plan-write.js");
		const ui = { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() };
		const ctx = { cwd: tmpDir, hasUI: true, ui } as any;

		mockDispatchAgent.mockImplementation(async (agent) => {
			if (agent.name === "planner") {
				const planDir = path.join(tmpDir, "docs/plans");
				fs.mkdirSync(planDir, { recursive: true });
				fs.writeFileSync(path.join(planDir, "2026-02-07-test-plan.md"), PLAN_CONTENT);
			}
			return makeDispatchResult();
		});
		mockGetFinalOutput.mockReturnValue("plan written");

		const state = makeState();
		const result = await runPlanWritePhase(state, ctx);

		// Phase advanced to plan-review
		expect(result.phase).toBe("plan-review");

		// All 3 tasks parsed
		expect(result.tasks).toHaveLength(3);

		// Task 2 description preserved embedded code fence content
		expect(result.tasks[1].description).toContain("typescript");
		expect(result.tasks[1].description).toContain("validate");

		// UI notified with "3 tasks"
		const notifyCalls = ui.notify.mock.calls.map((c: any[]) => c[0]);
		expect(notifyCalls.some((msg: string) => msg.includes("3 tasks"))).toBe(true);
	});
});
