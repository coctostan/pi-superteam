import { describe, it, expect } from "vitest";
import { parseReviewOutput } from "./review-parser.js";

describe("parseReviewOutput with ANSI codes (D7)", () => {
	it("parses JSON correctly when output contains ANSI color codes", () => {
		const raw = '\x1b[1m```superteam-json\x1b[0m\n\x1b[32m{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\x1b[0m\n\x1b[1m```\x1b[0m';
		const result = parseReviewOutput(raw);
		expect(result.status).toBe("pass");
	});

	it("parses JSON from ANSI-wrapped fenced block", () => {
		const raw = 'Review output:\n\x1b[33m```superteam-json\x1b[0m\n{"passed":false,"findings":[{"severity":"high","file":"a.ts","issue":"bad"}],"mustFix":[],"summary":"issues found"}\n\x1b[33m```\x1b[0m';
		const result = parseReviewOutput(raw);
		expect(result.status).toBe("fail");
		if (result.status === "fail") {
			expect(result.findings.findings).toHaveLength(1);
		}
	});

	it("parses fallback brace-match when ANSI codes wrap JSON object", () => {
		const raw = 'Output: \x1b[36m{"passed":true,"findings":[],"mustFix":[],"summary":"clean"}\x1b[0m';
		const result = parseReviewOutput(raw);
		expect(result.status).toBe("pass");
	});
});

describe("parseReviewOutput with sanitizeJsonNewlines (hardened)", () => {
	it("handles literal newlines inside JSON string values in superteam-json block", () => {
		const raw = '```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"line1\nline2"}\n```';
		const result = parseReviewOutput(raw);
		expect(result.status).toBe("pass");
		if (result.status === "pass") {
			expect(result.findings.summary).toBe("line1\nline2");
		}
	});

	it("handles triple-backtick inside JSON string values (quote-aware fence)", () => {
		const json = JSON.stringify({
			passed: false,
			findings: [{ severity: "medium", file: "a.ts", issue: "Use ```code``` formatting" }],
			mustFix: [],
			summary: "Minor",
		});
		const raw = "```superteam-json\n" + json + "\n```";
		const result = parseReviewOutput(raw);
		expect(result.status).toBe("fail");
	});

	it("previously inconclusive output now parses correctly", () => {
		const raw = '```superteam-json\n{"passed":false,"findings":[{"severity":"high","file":"src/a.ts","issue":"Missing\nerror handling"}],"mustFix":["src/a.ts"],"summary":"Needs\nfixes"}\n```';
		const result = parseReviewOutput(raw);
		expect(result.status).toBe("fail");
		if (result.status === "fail") {
			expect(result.findings.findings[0].issue).toContain("Missing");
			expect(result.findings.findings[0].issue).toContain("error handling");
		}
	});
});
