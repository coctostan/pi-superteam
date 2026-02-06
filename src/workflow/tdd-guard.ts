/**
 * TDD Guard — enforce test-driven development via tool_call interception.
 *
 * Modes:
 *   off  — no enforcement
 *   tdd  — block writes to impl files without test + run
 *   atdd — like tdd, but also warns when no acceptance test exists
 *
 * Guard enforces the mechanical minimum:
 *   1. Test file must exist for the target module
 *   2. Tests must have been run at least once
 *
 * RED→GREEN→REFACTOR discipline is taught by skills and rules, not the guard.
 * REFACTOR phase (tests passing) is never blocked.
 */

import * as path from "node:path";
import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
} from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { type SuperteamConfig, getConfig } from "../config.js";

// --- State ---

interface TestFileState {
	exists: boolean;
	lastRun?: number;
	lastPassed?: boolean;
	hasEverRun: boolean;
}

interface ImplFileState {
	mappedTestFile: string | null;
	lastWrite?: number;
}

interface BashWriteAllowance {
	reason: string;
	grantedAt: number;
	consumed: boolean;
}

export interface TddState {
	testFiles: Record<string, TestFileState>;
	implFiles: Record<string, ImplFileState>;
	acceptanceTests: Record<string, TestFileState>;
	bashWriteAllowance?: BashWriteAllowance;
}

function defaultTddState(): TddState {
	return {
		testFiles: {},
		implFiles: {},
		acceptanceTests: {},
	};
}

let tddState: TddState = defaultTddState();

export function getTddState(): TddState {
	return tddState;
}

export function resetTddState(): void {
	tddState = defaultTddState();
}

export function restoreTddState(state: TddState): void {
	tddState = state;
}

// --- File classification ---

/**
 * Check if a file matches any glob-like pattern.
 * Supports: *.ext, dir/*, prefix*.suffix
 */
function matchesPattern(filePath: string, patterns: string[]): boolean {
	const basename = path.basename(filePath);
	const relPath = filePath; // Already relative in most cases

	for (const pattern of patterns) {
		if (pattern.includes("/")) {
			// Path pattern — match against full relative path
			if (simpleGlobMatch(relPath, pattern)) return true;
		} else {
			// Basename pattern
			if (simpleGlobMatch(basename, pattern)) return true;
		}
	}
	return false;
}

function simpleGlobMatch(str: string, pattern: string): boolean {
	// Convert simple glob to regex: * → .*, ? → .
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`).test(str);
}

export function isTestFile(filePath: string, config: SuperteamConfig): boolean {
	return matchesPattern(filePath, config.testFilePatterns);
}

export function isAcceptanceTestFile(filePath: string, config: SuperteamConfig): boolean {
	return matchesPattern(filePath, config.acceptanceTestPatterns);
}

export function isExemptFile(filePath: string, config: SuperteamConfig): boolean {
	return matchesPattern(filePath, config.exemptPaths);
}

// --- Impl → Test file mapping ---

/**
 * Given an implementation file, find its expected test file using mapping strategies.
 */
export function mapImplToTest(implPath: string, config: SuperteamConfig): string | null {
	// Check explicit overrides first
	if (config.testFileMapping.overrides[implPath]) {
		return config.testFileMapping.overrides[implPath];
	}

	const dir = path.dirname(implPath);
	const basename = path.basename(implPath);
	const ext = path.extname(implPath);
	const stem = basename.slice(0, -ext.length);

	for (const strategy of config.testFileMapping.strategies) {
		switch (strategy.type) {
			case "suffix": {
				if (strategy.implSuffix && strategy.testSuffix && basename.endsWith(strategy.implSuffix)) {
					const testName = stem + strategy.testSuffix;
					return path.join(dir, testName);
				}
				break;
			}
			case "directory": {
				if (strategy.testDir) {
					const testDir = path.join(dir, strategy.testDir);
					// Use first suffix strategy's test suffix, or default
					const testSuffix = config.testFileMapping.strategies.find((s) => s.type === "suffix")?.testSuffix || ".test.ts";
					const testName = stem + testSuffix;
					return path.join(testDir, testName);
				}
				break;
			}
			case "mirror": {
				if (strategy.srcRoot && strategy.testRoot) {
					const relative = path.relative(strategy.srcRoot, implPath);
					if (!relative.startsWith("..")) {
						const testSuffix = config.testFileMapping.strategies.find((s) => s.type === "suffix")?.testSuffix || ".test.ts";
						const testName = stem + testSuffix;
						return path.join(strategy.testRoot, path.dirname(relative), testName);
					}
				}
				break;
			}
		}
	}

	return null;
}

/**
 * Reverse: given a test file, derive the impl file it covers.
 */
export function mapTestToImpl(testPath: string, config: SuperteamConfig): string | null {
	// Check reverse overrides
	for (const [impl, test] of Object.entries(config.testFileMapping.overrides)) {
		if (test === testPath) return impl;
	}

	const dir = path.dirname(testPath);
	const basename = path.basename(testPath);

	for (const strategy of config.testFileMapping.strategies) {
		if (strategy.type === "suffix" && strategy.testSuffix && strategy.implSuffix) {
			if (basename.endsWith(strategy.testSuffix)) {
				const stem = basename.slice(0, -strategy.testSuffix.length);
				return path.join(dir, stem + strategy.implSuffix);
			}
		}
		if (strategy.type === "directory" && strategy.testDir) {
			const testDirSuffix = `/${strategy.testDir}/`;
			if (testPath.includes(testDirSuffix)) {
				const parentDir = dir.replace(new RegExp(`/${strategy.testDir}$`), "");
				// Strip test suffix
				const suffixStrategy = config.testFileMapping.strategies.find((s) => s.type === "suffix");
				if (suffixStrategy?.testSuffix && basename.endsWith(suffixStrategy.testSuffix)) {
					const stem = basename.slice(0, -suffixStrategy.testSuffix.length);
					return path.join(parentDir, stem + (suffixStrategy.implSuffix || ".ts"));
				}
			}
		}
	}

	return null;
}

// --- Bash heuristics ---

/**
 * Patterns that indicate file mutation in bash commands.
 * Returns the target file path if detected, or null.
 */
export function detectBashFileMutation(command: string): string[] {
	const targets: string[] = [];

	// Redirect: > file, >> file
	const redirects = command.match(/[12]?\s*>{1,2}\s*([^\s;|&]+)/g);
	if (redirects) {
		for (const r of redirects) {
			const file = r.replace(/^[12]?\s*>{1,2}\s*/, "").trim();
			if (file && !file.startsWith("/dev/")) targets.push(file);
		}
	}

	// sed -i
	const sedMatch = command.match(/sed\s+(?:-[a-zA-Z]*i[a-zA-Z]*|-i(?:\s+(?:'[^']*'|"[^"]*"|[^\s]+))?\s)/);
	if (sedMatch) {
		// Extract file targets after sed -i expression
		const sedFiles = command.match(/sed\s+.*?\s+([^\s;|&]+\.[a-zA-Z]+)/);
		if (sedFiles) targets.push(sedFiles[1]);
	}

	// tee (writes to file)
	const teeMatch = command.match(/tee\s+(?:-a\s+)?([^\s;|&]+)/);
	if (teeMatch) targets.push(teeMatch[1]);

	// mv, cp (destination)
	const mvCpMatch = command.match(/(?:mv|cp)\s+(?:-[a-zA-Z]+\s+)*[^\s]+\s+([^\s;|&]+)/);
	if (mvCpMatch) targets.push(mvCpMatch[1]);

	// Heredoc: cat > file << EOF / cat << EOF > file
	const heredocMatch = command.match(/cat\s+(?:>+\s*([^\s<]+)|.*?>\s*([^\s<]+))/);
	if (heredocMatch) {
		const file = heredocMatch[1] || heredocMatch[2];
		if (file) targets.push(file);
	}

	return [...new Set(targets)];
}

// --- Test command detection ---

function isTestCommand(command: string, config: SuperteamConfig): boolean {
	const trimmed = command.trim();
	return config.testCommands.some((tc) => {
		// Match exact command or command with args
		return trimmed === tc || trimmed.startsWith(`${tc} `) || trimmed.startsWith(`${tc}\n`);
	});
}

// --- Guard event handlers ---

/**
 * Handle tool_call events. Returns block result if TDD violation detected.
 */
export function handleToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
): ToolCallEventResult | undefined {
	const config = getConfig(ctx.cwd);
	const mode = config.tddMode;
	if (mode === "off") return undefined;

	// --- Write tool ---
	if (isToolCallEventType("write", event)) {
		return checkImplWrite(event.input.path, config, mode);
	}

	// --- Edit tool ---
	if (isToolCallEventType("edit", event)) {
		return checkImplWrite(event.input.path, config, mode);
	}

	// --- Bash tool ---
	if (isToolCallEventType("bash", event)) {
		return checkBashCommand(event.input.command, config, mode);
	}

	return undefined;
}

/** Pending ATDD warnings to inject into next tool_result */
let pendingAtddWarning: string | null = null;

export function consumeAtddWarning(): string | null {
	const w = pendingAtddWarning;
	pendingAtddWarning = null;
	return w;
}

function checkImplWrite(filePath: string, config: SuperteamConfig, mode: string): ToolCallEventResult | undefined {
	// Test files always allowed
	if (isTestFile(filePath, config)) {
		// Track that this test file exists
		ensureTestFileState(filePath).exists = true;

		// If it's an acceptance test, track that too
		if (isAcceptanceTestFile(filePath, config)) {
			ensureAcceptanceTestState(filePath).exists = true;
		}

		// ATDD: warn if writing unit test without acceptance test
		if (mode === "atdd" && !isAcceptanceTestFile(filePath, config)) {
			const hasAcceptance = Object.values(tddState.acceptanceTests).some((a) => a.exists);
			if (!hasAcceptance) {
				pendingAtddWarning = `ATDD Warning: No acceptance test exists yet. Consider writing an acceptance test (e.g., *.acceptance.test.ts or *.e2e.test.ts) before unit tests to ensure you're building the right thing.`;
			}
		}

		return undefined; // ALLOW
	}

	// Exempt files always allowed
	if (isExemptFile(filePath, config)) return undefined;

	// Find mapped test file
	const testFile = mapImplToTest(filePath, config);

	if (!testFile) {
		// No mapping found → allow with warning (don't block on mapping uncertainty)
		return undefined;
	}

	// Track impl file mapping
	if (!tddState.implFiles[filePath]) {
		tddState.implFiles[filePath] = { mappedTestFile: testFile };
	}

	const testState = tddState.testFiles[testFile];

	// Does test file exist?
	if (!testState?.exists) {
		return {
			block: true,
			reason: `TDD: Create a test file first. Expected: ${testFile}\nWrite a failing test, run it, then implement.`,
		};
	}

	// Has test been run?
	if (!testState.hasEverRun) {
		return {
			block: true,
			reason: `TDD: Run your tests first. Test file exists (${testFile}) but has never been executed.\nRun tests to verify your RED→GREEN cycle.`,
		};
	}

	// ATDD: warn if no acceptance test (don't block)
	if (mode === "atdd") {
		const hasAcceptance = Object.values(tddState.acceptanceTests).some((a) => a.exists);
		if (!hasAcceptance) {
			// Warning only — return undefined to allow, but log
			// The ATDD enforcement is softer: skills teach the discipline
		}
	}

	// ALLOW — tests exist and have been run
	return undefined;
}

function checkBashCommand(command: string, config: SuperteamConfig, mode: string): ToolCallEventResult | undefined {
	const targets = detectBashFileMutation(command);
	if (targets.length === 0) return undefined; // No file mutation detected

	// Check if any target is an impl file that should be guarded
	for (const target of targets) {
		if (isTestFile(target, config)) continue; // Test file writes ok
		if (isExemptFile(target, config)) continue; // Exempt files ok

		const testFile = mapImplToTest(target, config);
		if (!testFile) continue; // Unmapped files ok

		// Check bash write allowance
		if (tddState.bashWriteAllowance && !tddState.bashWriteAllowance.consumed) {
			tddState.bashWriteAllowance.consumed = true;
			return undefined; // Allowed by one-time override
		}

		return {
			block: true,
			reason: `TDD: Use write/edit tool instead of bash file mutation for ${target}.\nThis ensures TDD enforcement can track your changes.\nUse /tdd allow-bash-write once "<reason>" for a one-time exception.`,
		};
	}

	return undefined;
}

// --- Tool result handler (track test runs) ---

export function handleToolResult(
	event: ToolResultEvent,
	ctx: ExtensionContext,
): ToolResultEventResult | undefined {
	const config = getConfig(ctx.cwd);
	if (config.tddMode === "off") return undefined;

	// Inject ATDD warnings into write/edit results
	if (event.toolName === "write" || event.toolName === "edit") {
		const warning = consumeAtddWarning();
		if (warning && !event.isError) {
			const existingText = event.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			return {
				content: [{ type: "text", text: `${existingText}\n\n⚠️ ${warning}` }],
			};
		}
	}

	// Only care about bash results (test executions)
	if (event.toolName !== "bash") return undefined;

	const command = (event.input as any)?.command;
	if (!command || !isTestCommand(command, config)) return undefined;

	const exitCode = (event.details as any)?.exitCode ?? null;
	const passed = exitCode === 0;
	const now = Date.now();

	// Mark all known test files as run
	for (const [file, state] of Object.entries(tddState.testFiles)) {
		if (state.exists) {
			state.hasEverRun = true;
			state.lastRun = now;
			state.lastPassed = passed;
		}
	}

	// Also mark acceptance tests
	for (const [file, state] of Object.entries(tddState.acceptanceTests)) {
		if (state.exists) {
			state.hasEverRun = true;
			state.lastRun = now;
			state.lastPassed = passed;
		}
	}

	return undefined;
}

// --- User bash handler (pre-execution, no result) ---

export function handleUserBash(
	event: UserBashEvent,
	ctx: ExtensionContext,
): UserBashEventResult | undefined {
	const config = getConfig(ctx.cwd);
	if (config.tddMode === "off") return undefined;

	if (isTestCommand(event.command, config)) {
		// Mark tests as "run attempted" — we can't know pass/fail
		const now = Date.now();
		for (const [file, state] of Object.entries(tddState.testFiles)) {
			if (state.exists) {
				state.hasEverRun = true;
				state.lastRun = now;
				// Don't set lastPassed — unknown
			}
		}
	}

	return undefined;
}

// --- Bash write allowance ---

export function grantBashWriteAllowance(reason: string): void {
	tddState.bashWriteAllowance = {
		reason,
		grantedAt: Date.now(),
		consumed: false,
	};
}

// --- State helpers ---

function ensureTestFileState(filePath: string): TestFileState {
	if (!tddState.testFiles[filePath]) {
		tddState.testFiles[filePath] = { exists: false, hasEverRun: false };
	}
	return tddState.testFiles[filePath];
}

function ensureAcceptanceTestState(filePath: string): TestFileState {
	if (!tddState.acceptanceTests[filePath]) {
		tddState.acceptanceTests[filePath] = { exists: false, hasEverRun: false };
	}
	return tddState.acceptanceTests[filePath];
}

/**
 * Mark a test file as existing (called when we see a write to a test file).
 */
export function markTestFileExists(filePath: string, config: SuperteamConfig): void {
	ensureTestFileState(filePath).exists = true;
	if (isAcceptanceTestFile(filePath, config)) {
		ensureAcceptanceTestState(filePath).exists = true;
	}
}

/**
 * Serialize TDD state for session persistence.
 */
export function serializeTddState(): TddState {
	return { ...tddState };
}
