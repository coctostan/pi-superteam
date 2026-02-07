import { describe, it, expect } from "vitest";
import { parseBrainstormOutput } from "./brainstorm-parser.js";
import type { QuestionsPayload, DesignPayload, ApproachesPayload } from "./brainstorm-parser.js";

describe("brainstorm-parser acceptance tests (Bug 2)", () => {
	it("AT-3: fenced JSON with literal newline characters (0x0a) in string values parses successfully", () => {
		const obj = {
			type: "questions",
			questions: [{ id: "q1", text: "line1\nline2", type: "input" }],
		};
		const jsonStr = JSON.stringify(obj);
		// Replace escaped \\n with real newline character (simulating what the LLM actually outputs)
		const jsonWithLiteralNewlines = jsonStr.replace(/\\n/g, "\n");
		const raw = "```superteam-brainstorm\n" + jsonWithLiteralNewlines + "\n```";

		const result = parseBrainstormOutput(raw);

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.data.type).toBe("questions");
		const questions = (result.data as QuestionsPayload).questions;
		expect(questions[0].text).toContain("line1");
		expect(questions[0].text).toContain("line2");
	});

	it("AT-3b: literal newlines create inner markdown fences that appear as standalone lines", () => {
		// A design section where content contains code fences, and the LLM outputs literal newlines
		const obj = {
			type: "design",
			sections: [
				{
					id: "s1",
					title: "Architecture",
					content: "Use this pattern:\n```typescript\nconst x = 1;\n```\nDone.",
				},
			],
		};
		const jsonStr = JSON.stringify(obj);
		// Replace \\n with literal newlines (simulating Mode A)
		const jsonWithLiteralNewlines = jsonStr.replace(/\\n/g, "\n");
		const raw = "```superteam-brainstorm\n" + jsonWithLiteralNewlines + "\n```";

		const result = parseBrainstormOutput(raw);

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.data.type).toBe("design");
		const sections = (result.data as DesignPayload).sections;
		expect(sections[0].content).toContain("typescript");
		expect(sections[0].content).toContain("const x = 1");
	});

	it("AT-4: properly escaped JSON strings containing triple-backtick sequences do not truncate extraction", () => {
		const obj = {
			type: "design",
			sections: [
				{
					id: "s1",
					title: "Guide",
					content: "Use a ```code``` block in your markdown.",
				},
			],
		};
		const raw = "```superteam-brainstorm\n" + JSON.stringify(obj) + "\n```";

		const result = parseBrainstormOutput(raw);

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const sections = (result.data as DesignPayload).sections;
		expect(sections[0].content).toContain("code");
	});

	it("AT-5: fenced JSON parse fails, parser falls back to brace-matching and recovers from later valid JSON", () => {
		// Fenced block has garbage, but there's valid JSON later in the output
		const raw =
			"```superteam-brainstorm\n{invalid json here\n```\n\nSome text\n" +
			JSON.stringify({
				type: "questions",
				questions: [{ id: "q1", text: "fallback?", type: "input" }],
			});

		const result = parseBrainstormOutput(raw);

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const questions = (result.data as QuestionsPayload).questions;
		expect(questions[0].text).toBe("fallback?");
	});

	it("AT-6: no fenced block — bare JSON with literal newlines parses via brace-matching + sanitization", () => {
		// No fenced block at all, just raw JSON with literal newlines in string values
		const obj = {
			type: "approaches",
			approaches: [
				{
					id: "a1",
					title: "Direct",
					summary: "line1\nline2",
					tradeoffs: "none",
					taskEstimate: 3,
				},
			],
		};
		const jsonStr = JSON.stringify(obj).replace(/\\n/g, "\n");
		const raw = "Here is my analysis:\n" + jsonStr;

		const result = parseBrainstormOutput(raw);

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.data.type).toBe("approaches");
		const approaches = (result.data as ApproachesPayload).approaches;
		expect(approaches[0].summary).toContain("line1");
		expect(approaches[0].summary).toContain("line2");
	});
});
