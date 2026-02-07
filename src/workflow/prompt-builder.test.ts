import { describe, it, expect } from "vitest";
import {
	buildScoutPrompt,
	buildPlannerPrompt,
	buildPlanRevisionPrompt,
	buildPlanReviewPrompt,
	buildImplPrompt,
	buildFixPrompt,
	buildSpecReviewPrompt,
	buildQualityReviewPrompt,
	buildFinalReviewPrompt,
	extractPlanContext,
} from "./prompt-builder.ts";
import type { TaskExecState } from "./orchestrator-state.ts";
import type { ReviewFindings } from "../review-parser.ts";

// --- Helpers ---

function makeTask(overrides: Partial<TaskExecState> = {}): TaskExecState {
	return {
		id: 1,
		title: "Implement widget",
		description: "Build the widget component with tests.",
		files: ["src/widget.ts", "src/widget.test.ts"],
		status: "implementing",
		reviewsPassed: [],
		reviewsFailed: [],
		fixAttempts: 0,
		...overrides,
	};
}

function makeFindings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
	return {
		passed: false,
		findings: [
			{ severity: "high", file: "src/widget.ts", issue: "Missing error handling" },
		],
		mustFix: ["Add try-catch in processData"],
		summary: "Needs error handling improvements",
		...overrides,
	};
}

// --- buildScoutPrompt ---

describe("buildScoutPrompt", () => {
	it("includes cwd path", () => {
		const result = buildScoutPrompt("/my/project");
		expect(result).toContain("/my/project");
	});

	it("asks for key files, tech stack, directory structure", () => {
		const result = buildScoutPrompt("/proj");
		expect(result).toContain("key files");
		expect(result).toContain("tech stack");
		expect(result).toContain("directory structure");
	});

	it("asks for structured summary", () => {
		const result = buildScoutPrompt("/proj");
		expect(result).toContain("structured summary");
	});
});

// --- buildPlannerPrompt ---

describe("buildPlannerPrompt", () => {
	it("includes scout output", () => {
		const result = buildPlannerPrompt("Scout found: TS project", "Add auth", "/plans/auth.md");
		expect(result).toContain("Scout found: TS project");
	});

	it("includes user description", () => {
		const result = buildPlannerPrompt("scout data", "Add authentication module", "/plans/auth.md");
		expect(result).toContain("Add authentication module");
	});

	it("includes plan path", () => {
		const result = buildPlannerPrompt("scout", "desc", "/docs/plans/my-plan.md");
		expect(result).toContain("/docs/plans/my-plan.md");
	});

	it("mentions superteam-tasks block", () => {
		const result = buildPlannerPrompt("scout", "desc", "/plan.md");
		expect(result).toContain("superteam-tasks");
	});

	it("mentions TDD", () => {
		const result = buildPlannerPrompt("scout", "desc", "/plan.md");
		expect(result).toMatch(/tdd/i);
	});

	it("mentions small tasks", () => {
		const result = buildPlannerPrompt("scout", "desc", "/plan.md");
		expect(result).toContain("1-3 files");
	});
});

// --- buildPlanRevisionPrompt ---

describe("buildPlanRevisionPrompt", () => {
	it("includes plan content", () => {
		const result = buildPlanRevisionPrompt("# My Plan\n...", "Finding: tasks too large");
		expect(result).toContain("# My Plan");
	});

	it("includes findings", () => {
		const result = buildPlanRevisionPrompt("plan", "Finding: missing tests");
		expect(result).toContain("Finding: missing tests");
	});

	it("mentions superteam-tasks block", () => {
		const result = buildPlanRevisionPrompt("plan", "findings");
		expect(result).toContain("superteam-tasks");
	});
});

// --- buildPlanReviewPrompt ---

describe("buildPlanReviewPrompt", () => {
	it("includes plan content", () => {
		const result = buildPlanReviewPrompt("# Plan\ntasks here", "architect");
		expect(result).toContain("# Plan");
	});

	it("architect review checks design, modularity, task ordering", () => {
		const result = buildPlanReviewPrompt("plan", "architect");
		expect(result).toMatch(/design/i);
		expect(result).toMatch(/modular/i);
		expect(result).toMatch(/order/i);
	});

	it("spec review checks completeness, task independence, file coverage", () => {
		const result = buildPlanReviewPrompt("plan", "spec");
		expect(result).toMatch(/complete/i);
		expect(result).toMatch(/independen/i);
		expect(result).toMatch(/file.*coverage|coverage/i);
	});

	it("mandates superteam-json output", () => {
		const result = buildPlanReviewPrompt("plan", "architect");
		expect(result).toContain("superteam-json");
	});

	it("mentions passed/findings/mustFix/summary fields", () => {
		const result = buildPlanReviewPrompt("plan", "spec");
		expect(result).toContain("passed");
		expect(result).toContain("findings");
		expect(result).toContain("mustFix");
		expect(result).toContain("summary");
	});
});

// --- buildImplPrompt ---

describe("buildImplPrompt", () => {
	it("includes task title and description", () => {
		const task = makeTask();
		const result = buildImplPrompt(task, "Architecture: modular design");
		expect(result).toContain("Implement widget");
		expect(result).toContain("Build the widget component with tests.");
	});

	it("includes file list", () => {
		const task = makeTask();
		const result = buildImplPrompt(task, "context");
		expect(result).toContain("src/widget.ts");
		expect(result).toContain("src/widget.test.ts");
	});

	it("includes plan context", () => {
		const task = makeTask();
		const result = buildImplPrompt(task, "Goal: Build a REST API");
		expect(result).toContain("Goal: Build a REST API");
	});

	it("includes TDD instructions", () => {
		const task = makeTask();
		const result = buildImplPrompt(task, "ctx");
		expect(result).toMatch(/tdd/i);
		expect(result).toMatch(/failing test/i);
	});

	it("mentions self-review", () => {
		const task = makeTask();
		const result = buildImplPrompt(task, "ctx");
		expect(result).toMatch(/self.review/i);
	});
});

// --- buildFixPrompt ---

describe("buildFixPrompt", () => {
	it("includes review type", () => {
		const result = buildFixPrompt(makeTask(), "spec", makeFindings(), ["src/widget.ts"]);
		expect(result).toContain("spec");
	});

	it("includes formatted findings", () => {
		const result = buildFixPrompt(makeTask(), "quality", makeFindings(), ["src/widget.ts"]);
		expect(result).toContain("Missing error handling");
	});

	it("includes mustFix items", () => {
		const result = buildFixPrompt(makeTask(), "spec", makeFindings(), ["src/widget.ts"]);
		expect(result).toContain("Add try-catch in processData");
	});

	it("includes changed files list", () => {
		const result = buildFixPrompt(makeTask(), "spec", makeFindings(), ["src/a.ts", "src/b.ts"]);
		expect(result).toContain("src/a.ts");
		expect(result).toContain("src/b.ts");
	});

	it("mentions TDD / update tests", () => {
		const result = buildFixPrompt(makeTask(), "spec", makeFindings(), ["src/a.ts"]);
		expect(result).toMatch(/test/i);
	});
});

// --- buildSpecReviewPrompt ---

describe("buildSpecReviewPrompt", () => {
	it("includes task spec inline", () => {
		const task = makeTask({ description: "Build the parser module" });
		const result = buildSpecReviewPrompt(task, ["src/parser.ts"]);
		expect(result).toContain("Build the parser module");
	});

	it("includes changed files to read", () => {
		const result = buildSpecReviewPrompt(makeTask(), ["src/widget.ts", "src/widget.test.ts"]);
		expect(result).toContain("src/widget.ts");
		expect(result).toContain("src/widget.test.ts");
	});

	it("says do NOT trust implementer self-report", () => {
		const result = buildSpecReviewPrompt(makeTask(), ["src/widget.ts"]);
		expect(result).toMatch(/do\s+NOT\s+trust/i);
	});

	it("mandates superteam-json output", () => {
		const result = buildSpecReviewPrompt(makeTask(), ["src/widget.ts"]);
		expect(result).toContain("superteam-json");
	});
});

// --- buildQualityReviewPrompt ---

describe("buildQualityReviewPrompt", () => {
	it("includes changed files", () => {
		const result = buildQualityReviewPrompt(makeTask(), ["src/widget.ts"]);
		expect(result).toContain("src/widget.ts");
	});

	it("checks naming, DRY, error handling, test quality", () => {
		const result = buildQualityReviewPrompt(makeTask(), ["src/widget.ts"]);
		expect(result).toMatch(/naming/i);
		expect(result).toMatch(/dry/i);
		expect(result).toMatch(/error handling/i);
		expect(result).toMatch(/test quality/i);
	});

	it("mandates superteam-json output", () => {
		const result = buildQualityReviewPrompt(makeTask(), ["src/widget.ts"]);
		expect(result).toContain("superteam-json");
	});
});

// --- buildFinalReviewPrompt ---

describe("buildFinalReviewPrompt", () => {
	it("summarizes completed tasks", () => {
		const tasks = [
			makeTask({ id: 1, title: "Task A" }),
			makeTask({ id: 2, title: "Task B" }),
		];
		const result = buildFinalReviewPrompt(tasks, ["src/a.ts", "src/b.ts"]);
		expect(result).toContain("Task A");
		expect(result).toContain("Task B");
	});

	it("includes all changed files", () => {
		const result = buildFinalReviewPrompt([makeTask()], ["src/x.ts", "src/y.ts", "src/z.ts"]);
		expect(result).toContain("src/x.ts");
		expect(result).toContain("src/y.ts");
		expect(result).toContain("src/z.ts");
	});

	it("mandates superteam-json output", () => {
		const result = buildFinalReviewPrompt([makeTask()], ["src/a.ts"]);
		expect(result).toContain("superteam-json");
	});
});

// --- extractPlanContext ---

describe("extractPlanContext", () => {
	it("extracts everything before superteam-tasks block", () => {
		const plan = `# Goal
Build a REST API

# Architecture
Modular design

\`\`\`superteam-tasks
- title: Task 1
  description: Do something
  files: [src/a.ts]
\`\`\``;
		const result = extractPlanContext(plan);
		expect(result).toContain("# Goal");
		expect(result).toContain("Build a REST API");
		expect(result).toContain("# Architecture");
		expect(result).toContain("Modular design");
		expect(result).not.toContain("superteam-tasks");
		expect(result).not.toContain("Task 1");
	});

	it("returns entire content if no superteam-tasks block", () => {
		const plan = "# Just a plan\nNo tasks here";
		const result = extractPlanContext(plan);
		expect(result).toBe("# Just a plan\nNo tasks here");
	});

	it("trims whitespace", () => {
		const plan = `  # Goal  \n\n\`\`\`superteam-tasks\n...\n\`\`\``;
		const result = extractPlanContext(plan);
		expect(result).toBe("# Goal");
	});
});
