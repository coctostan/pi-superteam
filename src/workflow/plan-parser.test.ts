import { describe, it, expect } from "vitest";
import { parseTaskBlock, parseTaskHeadings, loadPlan } from "./plan-parser.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("plan-parser", () => {
	describe("parseTaskBlock", () => {
		it("parses a valid superteam-tasks block", () => {
			const content = [
				"# Plan",
				"",
				"```superteam-tasks",
				"- title: Create model",
				"  description: Set up user model",
				"  files: [src/model.ts, src/model.test.ts]",
				"- title: Add routes",
				"  description: REST endpoints",
				"  files: [src/routes.ts]",
				"```",
			].join("\n");

			const tasks = parseTaskBlock(content);
			expect(tasks).not.toBeNull();
			expect(tasks).toHaveLength(2);
			expect(tasks![0].title).toBe("Create model");
			expect(tasks![0].description).toBe("Set up user model");
			expect(tasks![0].files).toEqual(["src/model.ts", "src/model.test.ts"]);
			expect(tasks![1].title).toBe("Add routes");
		});

		it("returns null when no superteam-tasks block", () => {
			const content = "# Plan\nNo tasks here.";
			expect(parseTaskBlock(content)).toBeNull();
		});

		it("assigns sequential IDs starting from 1", () => {
			const content = "```superteam-tasks\n- title: A\n  description: D\n  files: [a.ts]\n- title: B\n  description: D\n  files: [b.ts]\n```";
			const tasks = parseTaskBlock(content)!;
			expect(tasks[0].id).toBe(1);
			expect(tasks[1].id).toBe(2);
		});

		it("handles block scalar descriptions", () => {
			const content = [
				"```superteam-tasks",
				"- title: Complex task",
				"  description: |",
				"    Line one",
				"    Line two",
				"  files: [a.ts]",
				"```",
			].join("\n");

			const tasks = parseTaskBlock(content)!;
			expect(tasks[0].description).toContain("Line one");
			expect(tasks[0].description).toContain("Line two");
		});
	});

	describe("parseTaskHeadings", () => {
		it("parses ### Task N: headings", () => {
			const content = [
				"### Task 1: Setup",
				"Description of setup task.",
				"### Task 2: Build",
				"Description of build task. Uses `src/build.ts`.",
			].join("\n");

			const tasks = parseTaskHeadings(content);
			expect(tasks).toHaveLength(2);
			expect(tasks[0].id).toBe(1);
			expect(tasks[0].title).toBe("Setup");
			expect(tasks[1].id).toBe(2);
			expect(tasks[1].title).toBe("Build");
			expect(tasks[1].files).toContain("src/build.ts");
		});

		it("returns empty array when no task headings", () => {
			expect(parseTaskHeadings("# Plan\nNo tasks")).toEqual([]);
		});
	});

	describe("loadPlan", () => {
		it("loads and parses a plan file with fenced block", () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-parser-"));
			const planPath = path.join(tmpDir, "plan.md");
			fs.writeFileSync(planPath, "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```");
			try {
				const result = loadPlan(planPath);
				expect(result.source).toBe("fenced");
				expect(result.tasks).toHaveLength(1);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("returns empty for nonexistent file", () => {
			const result = loadPlan("/nonexistent/path.md");
			expect(result.source).toBe("empty");
			expect(result.tasks).toEqual([]);
		});
	});
});
