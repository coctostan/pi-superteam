import * as fs from "node:fs";
import * as path from "node:path";
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
	buildBrainstormQuestionsPrompt,
	buildBrainstormApproachesPrompt,
	buildBrainstormDesignPrompt,
	buildBrainstormSectionRevisionPrompt,
	buildTargetedPlanRevisionPrompt,
} from "./prompt-builder.ts";
import type { TaskExecState, BrainstormQuestion, BrainstormApproach, DesignSection } from "./orchestrator-state.ts";
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

// --- buildScoutPrompt (narrowed) ---

describe("buildScoutPrompt", () => {
	it("includes cwd path", () => {
		const result = buildScoutPrompt("/my/project");
		expect(result).toContain("/my/project");
	});

	it("instructs to read .pi/context.md if present", () => {
		const result = buildScoutPrompt("/proj");
		expect(result).toContain("context.md");
	});

	it("asks for tech stack, directory layout, key entry points, test conventions", () => {
		const result = buildScoutPrompt("/proj");
		expect(result).toMatch(/tech stack/i);
		expect(result).toMatch(/directory/i);
		expect(result).toMatch(/entry point/i);
		expect(result).toMatch(/test convention/i);
	});

	it("limits output to 500 words", () => {
		const result = buildScoutPrompt("/proj");
		expect(result).toContain("500 words");
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

	it("includes previous task section when previousTaskSummary is provided", () => {
		const task = makeTask();
		const summary = { title: "Previous Task", status: "complete", changedFiles: ["src/prev.ts"] };
		const result = buildImplPrompt(task, "ctx", summary);
		expect(result).toContain("## Previous task");
		expect(result).toContain("Previous Task");
		expect(result).toContain("complete");
		expect(result).toContain("src/prev.ts");
	});

	it("does not include previous task section when no summary provided", () => {
		const task = makeTask();
		const result = buildImplPrompt(task, "ctx");
		expect(result).not.toContain("## Previous task");
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

	it("includes instruction to only review listed files, not test files unless targeted", () => {
		const task = makeTask();
		const result = buildSpecReviewPrompt(task, ["src/widget.ts"]);
		expect(result).toContain("do not review test files unless the task description explicitly targets test code");
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
});

// --- REVIEW_OUTPUT_FORMAT removal ---

describe("REVIEW_OUTPUT_FORMAT removal", () => {
	it("buildPlanReviewPrompt does not contain the duplicated IMPORTANT format instruction", () => {
		const result = buildPlanReviewPrompt("plan content", "architect");
		expect(result).not.toContain("IMPORTANT: You MUST end your response with");
	});

	it("buildSpecReviewPrompt does not contain the duplicated IMPORTANT format instruction", () => {
		const task = makeTask();
		const result = buildSpecReviewPrompt(task, ["src/a.ts"]);
		expect(result).not.toContain("IMPORTANT: You MUST end your response with");
	});

	it("buildQualityReviewPrompt does not contain the duplicated IMPORTANT format instruction", () => {
		const task = makeTask();
		const result = buildQualityReviewPrompt(task, ["src/a.ts"]);
		expect(result).not.toContain("IMPORTANT: You MUST end your response with");
	});

	it("buildFinalReviewPrompt does not contain the duplicated IMPORTANT format instruction", () => {
		const result = buildFinalReviewPrompt([makeTask()], ["src/a.ts"]);
		expect(result).not.toContain("IMPORTANT: You MUST end your response with");
	});

	it("all 5 reviewer agents contain superteam-json format in their .md", () => {
		const agentFiles = ["architect", "spec-reviewer", "quality-reviewer", "security-reviewer", "performance-reviewer"];
		const agentsDir = path.resolve(import.meta.dirname, "../../agents");
		for (const name of agentFiles) {
			const content = fs.readFileSync(path.join(agentsDir, name + ".md"), "utf-8");
			expect(content).toContain("```superteam-json");
		}
	});
});

// --- buildImplPrompt prior task context (D6) ---

describe("buildImplPrompt prior task context (D6)", () => {
	it("includes last 5 prior tasks when provided as array", () => {
		const task = makeTask();
		const priorTasks = Array.from({ length: 7 }, (_, i) => ({
			title: `Task ${i + 1}`,
			status: "complete",
			changedFiles: [`src/file${i + 1}.ts`],
		}));

		const result = buildImplPrompt(task, "ctx", undefined, priorTasks);
		expect(result).toContain("## Prior tasks");
		// Should only have last 5 (tasks 3-7)
		expect(result).not.toContain("Task 1");
		expect(result).not.toContain("Task 2");
		expect(result).toContain("Task 3");
		expect(result).toContain("Task 7");
		expect(result).toContain("src/file7.ts");
	});

	it("includes all prior tasks when fewer than 5", () => {
		const task = makeTask();
		const priorTasks = [
			{ title: "Setup", status: "complete", changedFiles: ["src/setup.ts"] },
			{ title: "Config", status: "complete", changedFiles: ["src/config.ts"] },
		];

		const result = buildImplPrompt(task, "ctx", undefined, priorTasks);
		expect(result).toContain("Setup");
		expect(result).toContain("Config");
	});

	it("omits prior tasks section when array is empty", () => {
		const task = makeTask();
		const result = buildImplPrompt(task, "ctx", undefined, []);
		expect(result).not.toContain("## Prior tasks");
	});

	it("still supports legacy single previousTaskSummary", () => {
		const task = makeTask();
		const summary = { title: "Legacy", status: "complete", changedFiles: ["src/old.ts"] };
		const result = buildImplPrompt(task, "ctx", summary);
		expect(result).toContain("## Previous task");
		expect(result).toContain("Legacy");
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

// --- Brainstorm prompts: literal newline warning ---

const NEWLINE_WARNING = "never use literal newlines inside string values";

describe("buildBrainstormQuestionsPrompt", () => {
	it("includes literal newline warning", () => {
		const result = buildBrainstormQuestionsPrompt("scout output", "build a widget");
		expect(result.toLowerCase()).toContain(NEWLINE_WARNING);
	});
});

describe("buildBrainstormApproachesPrompt", () => {
	it("includes literal newline warning", () => {
		const questions: BrainstormQuestion[] = [
			{ id: "q1", text: "What framework?", type: "choice", options: ["React", "Vue"], answer: "React" },
		];
		const result = buildBrainstormApproachesPrompt("scout output", "build a widget", questions);
		expect(result.toLowerCase()).toContain(NEWLINE_WARNING);
	});
});

describe("buildBrainstormDesignPrompt", () => {
	it("includes literal newline warning", () => {
		const questions: BrainstormQuestion[] = [
			{ id: "q1", text: "What framework?", type: "choice", options: ["React"], answer: "React" },
		];
		const approach: BrainstormApproach = {
			id: "a1",
			title: "Component-based",
			summary: "Use components",
			tradeoffs: "More files",
			taskEstimate: 3,
		};
		const result = buildBrainstormDesignPrompt("scout output", "build a widget", questions, approach);
		expect(result.toLowerCase()).toContain(NEWLINE_WARNING);
	});
});

describe("buildBrainstormSectionRevisionPrompt", () => {
	it("includes literal newline warning", () => {
		const section: DesignSection = {
			id: "s1",
			title: "Architecture",
			content: "The system uses a modular design.",
		};
		const result = buildBrainstormSectionRevisionPrompt(section, "Add more detail", "Some context");
		expect(result.toLowerCase()).toContain(NEWLINE_WARNING);
	});
});

describe("buildTargetedPlanRevisionPrompt", () => {
	it("includes plan content", () => {
		const result = buildTargetedPlanRevisionPrompt("# Plan\nTask list here", "Missing error handling", "# Design");
		expect(result).toContain("# Plan");
		expect(result).toContain("Task list here");
	});

	it("includes findings", () => {
		const result = buildTargetedPlanRevisionPrompt("plan content", "Task 3 is missing tests", "design");
		expect(result).toContain("Task 3 is missing tests");
	});

	it("includes design content", () => {
		const result = buildTargetedPlanRevisionPrompt("plan", "findings", "# Design\nPassport.js approach");
		expect(result).toContain("Passport.js approach");
	});

	it("instructs targeted edits — not full rewrite", () => {
		const result = buildTargetedPlanRevisionPrompt("plan", "findings", "design");
		const lower = result.toLowerCase();
		expect(lower).toContain("only");
		expect(lower).toMatch(/task.*mentioned|referenced/);
		expect(lower).toContain("preserve");
	});

	it("instructs to keep the superteam-tasks block", () => {
		const result = buildTargetedPlanRevisionPrompt("plan", "findings", "design");
		expect(result).toContain("superteam-tasks");
	});
});
