/**
 * Review parser — extract and validate structured reviewer JSON output.
 *
 * Single module, single schema. All reviewers use the same output format.
 * Inconclusive → escalate, never crash, never guess.
 */

import {
	extractFencedBlock,
	extractLastBraceBlock,
	sanitizeJsonNewlines,
} from "./parse-utils.js";

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
	const fenced = extractFencedBlock(rawOutput, "superteam-json");
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

function parseAndValidate(jsonStr: string, rawOutput: string): ParseResult {
	const sanitized = sanitizeJsonNewlines(jsonStr);
	let parsed: any;
	try {
		parsed = JSON.parse(sanitized);
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
