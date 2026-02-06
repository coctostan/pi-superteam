/**
 * Configuration resolution for .superteam.json
 *
 * Discovers config in project root (walk up from cwd),
 * merges with defaults, validates shape.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// --- Types ---

export interface MappingStrategy {
	type: "suffix" | "directory" | "mirror";
	implSuffix?: string;
	testSuffix?: string;
	testDir?: string;
	srcRoot?: string;
	testRoot?: string;
}

export interface TestFileMapping {
	strategies: MappingStrategy[];
	overrides: Record<string, string>;
}

export interface ReviewConfig {
	maxIterations: number;
	required: string[];
	optional: string[];
	parallelOptional: boolean;
	escalateOnMaxIterations: boolean;
}

export interface AgentConfig {
	defaultModel: string;
	scoutModel: string;
	modelOverrides: Record<string, string>;
}

export interface CostConfig {
	warnAtUsd: number;
	hardLimitUsd: number;
}

export interface SuperteamConfig {
	configVersion: number;
	tddMode: "off" | "tdd" | "atdd";
	testFilePatterns: string[];
	acceptanceTestPatterns: string[];
	testCommands: string[];
	exemptPaths: string[];
	testFileMapping: TestFileMapping;
	review: ReviewConfig;
	agents: AgentConfig;
	costs: CostConfig;
}

// --- Defaults ---

const DEFAULT_CONFIG: SuperteamConfig = {
	configVersion: 1,
	tddMode: "off",
	testFilePatterns: ["*.test.ts", "*.spec.ts", "__tests__/*.ts"],
	acceptanceTestPatterns: ["*.acceptance.test.ts", "*.e2e.test.ts"],
	testCommands: ["npm test", "bun test", "npx jest", "npx vitest"],
	exemptPaths: ["*.d.ts", "*.config.*", "migrations/*"],
	testFileMapping: {
		strategies: [
			{ type: "suffix", implSuffix: ".ts", testSuffix: ".test.ts" },
			{ type: "suffix", implSuffix: ".ts", testSuffix: ".spec.ts" },
			{ type: "directory", testDir: "__tests__" },
		],
		overrides: {},
	},
	review: {
		maxIterations: 3,
		required: ["spec", "quality"],
		optional: ["security", "performance"],
		parallelOptional: true,
		escalateOnMaxIterations: true,
	},
	agents: {
		defaultModel: "claude-sonnet-4-5",
		scoutModel: "claude-haiku-4-5",
		modelOverrides: {},
	},
	costs: {
		warnAtUsd: 5.0,
		hardLimitUsd: 20.0,
	},
};

// --- Discovery ---

function findConfigFile(startDir: string): string | null {
	let dir = path.resolve(startDir);
	while (true) {
		const candidate = path.join(dir, ".superteam.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// --- Deep merge (simple: objects merge, arrays replace, primitives replace) ---

function deepMerge(defaults: any, overrides: any): any {
	if (overrides === undefined || overrides === null) return defaults;
	if (typeof defaults !== "object" || Array.isArray(defaults)) return overrides;
	if (typeof overrides !== "object" || Array.isArray(overrides)) return overrides;

	const result: any = { ...defaults };
	for (const key of Object.keys(overrides)) {
		if (key in defaults && typeof defaults[key] === "object" && !Array.isArray(defaults[key])) {
			result[key] = deepMerge(defaults[key], overrides[key]);
		} else {
			result[key] = overrides[key];
		}
	}
	return result;
}

// --- Public API ---

let cachedConfig: SuperteamConfig | null = null;
let cachedConfigPath: string | null = null;

/**
 * Load and return the superteam config.
 * Caches after first load. Pass `force: true` to reload.
 */
export function getConfig(cwd: string, force = false): SuperteamConfig {
	if (cachedConfig && !force) return cachedConfig;

	const configPath = findConfigFile(cwd);
	cachedConfigPath = configPath;

	if (!configPath) {
		cachedConfig = { ...DEFAULT_CONFIG };
		return cachedConfig;
	}

	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		cachedConfig = deepMerge(DEFAULT_CONFIG, parsed) as SuperteamConfig;
		return cachedConfig;
	} catch {
		// Invalid JSON or read error — use defaults
		cachedConfig = { ...DEFAULT_CONFIG };
		return cachedConfig;
	}
}

/**
 * Get the path to the config file, or null if using defaults.
 */
export function getConfigPath(): string | null {
	return cachedConfigPath;
}

/**
 * Get the package root directory (where package.json lives).
 * Used for resolving agent profiles, skill paths, and extension self-reference.
 */
export function getPackageDir(): string {
	// import.meta.dirname gives us the directory of this file (src/)
	// Walk up to find package.json
	let dir = path.dirname(new URL(import.meta.url).pathname);
	while (true) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) {
			// Fallback: assume one level up from src/
			return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
		}
		dir = parent;
	}
}
