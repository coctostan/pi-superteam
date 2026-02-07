import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTaskBlock } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("parseTaskBlock — acceptance tests (Bug 1)", () => {
	describe("AT-1: real smoke-test plan fixture", () => {
		const fixturePath = path.join(__dirname, "__fixtures__", "smoke-test-plan.md");
		const fixtureContent = fs.readFileSync(fixturePath, "utf-8");

		it("returns exactly 3 tasks", () => {
			const tasks = parseTaskBlock(fixtureContent);
			expect(tasks).not.toBeNull();
			expect(tasks).toHaveLength(3);
		});

		it("Task 1 title contains 'Install test dependencies'", () => {
			const tasks = parseTaskBlock(fixtureContent)!;
			expect(tasks[0].title).toContain("Install test dependencies");
		});

		it("Task 2 title contains 'Extract app module'", () => {
			const tasks = parseTaskBlock(fixtureContent)!;
			expect(tasks[1].title).toContain("Extract app module");
		});

		it("Task 3 title contains '/health route'", () => {
			const tasks = parseTaskBlock(fixtureContent)!;
			expect(tasks[2].title).toContain("/health route");
		});

		it("Task 2 description is real multi-line content, not literal '|'", () => {
			const tasks = parseTaskBlock(fixtureContent)!;
			expect(tasks[1].description.length).toBeGreaterThan(50);
			expect(tasks[1].description).not.toBe("|");
		});

		it("Task 3 description is real multi-line content, not literal '|'", () => {
			const tasks = parseTaskBlock(fixtureContent)!;
			expect(tasks[2].description.length).toBeGreaterThan(50);
			expect(tasks[2].description).not.toBe("|");
		});

		it("Task 2 files include src/app.ts, src/index.ts, src/app.test.ts", () => {
			const tasks = parseTaskBlock(fixtureContent)!;
			expect(tasks[1].files).toContain("src/app.ts");
			expect(tasks[1].files).toContain("src/index.ts");
			expect(tasks[1].files).toContain("src/app.test.ts");
		});
	});

	describe("AT-2: synthetic block with embedded code fences", () => {
		const syntheticPlan = `# Some plan

\`\`\`superteam-tasks
- title: First task
  description: Simple task
  files: [src/a.ts]
- title: Second task with code
  description: |
    Do the following:
    \`\`\`typescript
    const x = 1;
    \`\`\`
    Then verify it works.
  files: [src/b.ts]
- title: Third task
  description: Another simple task
  files: [src/c.ts]
\`\`\`
`;

		it("returns exactly 3 tasks", () => {
			const tasks = parseTaskBlock(syntheticPlan);
			expect(tasks).not.toBeNull();
			expect(tasks).toHaveLength(3);
		});

		it("Task 2 description contains 'typescript' and 'const x = 1'", () => {
			const tasks = parseTaskBlock(syntheticPlan)!;
			expect(tasks[1].description).toContain("typescript");
			expect(tasks[1].description).toContain("const x = 1");
		});

		it("Task 2 description does NOT equal '|'", () => {
			const tasks = parseTaskBlock(syntheticPlan)!;
			expect(tasks[1].description).not.toBe("|");
		});

		it("Task 3 title is 'Third task'", () => {
			const tasks = parseTaskBlock(syntheticPlan)!;
			expect(tasks[2].title).toBe("Third task");
		});
	});
});
