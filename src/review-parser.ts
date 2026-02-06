/**
 * Review parser — extract and validate structured reviewer JSON output.
 *
 * Single module, single schema. All reviewers use the same output format.
 * Inconclusive → escalate, never crash, never guess.
 */

// --- Types ---

export interface ReviewFinding {
	severity: "critical" | "high" | "medium" | "low";
	file: string;
	line?: number;
	issue: string;
	suggestion?: string;
}

export interface ReviewFindings {
	passed: boolean;
	findings: ReviewFinding[];
	mustFix: string[];
	summary: string;
}

export type ParseResult =
	| { status: "pass"; findings: ReviewFindings }
	| { status: "fail"; findings: ReviewFindings }
	| { status: "inconclusive"; rawOutput: string; parseError: string };

// --- Extraction ---

/**
 * Extract structured review JSON from reviewer output text.
 *
 * Strategy:
 * 1. Look for ```superteam-json fenced block (preferred)
 * 2. Fallback: last {...} brace-matched block
 * 3. If neither: inconclusive
 */
export function parseReviewOutput(rawOutput: string): ParseResult {
	// Try fenced block first
	const fenced = extractFencedBlock(rawOutput);
	if (fenced) {
		return parseAndValidate(fenced, rawOutput);
	}

	// Fallback: last brace-matched block
	const braceMatch = extractLastBraceBlock(rawOutput);
	if (braceMatch) {
		return parseAndValidate(braceMatch, rawOutput);
	}

	return {
		status: "inconclusive",
		rawOutput,
		parseError: "No ```superteam-json block or JSON object found in reviewer output",
	};
}

function extractFencedBlock(text: string): string | null {
	// Match ```superteam-json ... ``` with flexible whitespace
	const regex = /```superteam-json\s*\n([\s\S]*?)```/;
	const match = text.match(regex);
	return match ? match[1].trim() : null;
}

function extractLastBraceBlock(text: string): string | null {
	// Find the last top-level {...} block
	let depth = 0;
	let lastStart = -1;
	let lastEnd = -1;
	let inString = false;
	let escape = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;

		if (ch === "{") {
			if (depth === 0) lastStart = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && lastStart >= 0) {
				lastEnd = i;
			}
		}
	}

	if (lastStart >= 0 && lastEnd > lastStart) {
		return text.slice(lastStart, lastEnd + 1);
	}
	return null;
}

function parseAndValidate(jsonStr: string, rawOutput: string): ParseResult {
	let parsed: any;
	try {
		parsed = JSON.parse(jsonStr);
	} catch (e: any) {
		return {
			status: "inconclusive",
			rawOutput,
			parseError: `JSON parse error: ${e.message}`,
		};
	}

	// Validate shape
	if (typeof parsed !== "object" || parsed === null) {
		return {
			status: "inconclusive",
			rawOutput,
			parseError: "Parsed JSON is not an object",
		};
	}

	if (typeof parsed.passed !== "boolean") {
		return {
			status: "inconclusive",
			rawOutput,
			parseError: "Missing or invalid 'passed' field (expected boolean)",
		};
	}

	if (!Array.isArray(parsed.findings)) {
		// Tolerate missing findings — default to empty array
		parsed.findings = [];
	}

	if (!Array.isArray(parsed.mustFix)) {
		parsed.mustFix = [];
	}

	if (typeof parsed.summary !== "string") {
		parsed.summary = "";
	}

	// Validate findings entries
	const validFindings: ReviewFinding[] = [];
	for (const f of parsed.findings) {
		if (typeof f === "object" && f !== null && typeof f.issue === "string") {
			validFindings.push({
				severity: ["critical", "high", "medium", "low"].includes(f.severity) ? f.severity : "medium",
				file: typeof f.file === "string" ? f.file : "unknown",
				line: typeof f.line === "number" ? f.line : undefined,
				issue: f.issue,
				suggestion: typeof f.suggestion === "string" ? f.suggestion : undefined,
			});
		}
	}

	const findings: ReviewFindings = {
		passed: parsed.passed,
		findings: validFindings,
		mustFix: parsed.mustFix.filter((m: unknown) => typeof m === "string"),
		summary: parsed.summary,
	};

	return {
		status: findings.passed ? "pass" : "fail",
		findings,
	};
}

/**
 * Check if review findings contain critical issues that require immediate fix.
 */
export function hasCriticalFindings(findings: ReviewFindings): boolean {
	return findings.findings.some((f) => f.severity === "critical");
}

/**
 * Format findings for display to human or for passing to implementer.
 */
export function formatFindings(findings: ReviewFindings, reviewType: string): string {
	const lines: string[] = [`Review: ${reviewType} — ${findings.passed ? "PASSED" : "FAILED"}`];

	if (findings.summary) {
		lines.push(`Summary: ${findings.summary}`);
	}

	if (findings.mustFix.length > 0) {
		lines.push(`\nMust fix:`);
		for (const ref of findings.mustFix) {
			lines.push(`  - ${ref}`);
		}
	}

	if (findings.findings.length > 0) {
		lines.push(`\nFindings (${findings.findings.length}):`);
		for (const f of findings.findings) {
			const loc = f.line ? `${f.file}:${f.line}` : f.file;
			lines.push(`  [${f.severity.toUpperCase()}] ${loc}: ${f.issue}`);
			if (f.suggestion) lines.push(`    → ${f.suggestion}`);
		}
	}

	return lines.join("\n");
}
