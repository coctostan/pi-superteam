/**
 * Agent dispatcher — spawn isolated pi subprocesses.
 *
 * Task 1: single dispatch only. Parallel + chain added in Task 2.
 *
 * Based on pi's subagent example (MIT), adapted for superteam's
 * deterministic isolation and TDD guard loading.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { getConfig, getPackageDir } from "./config.js";

// --- Types ---

export type AgentSource = "package" | "user" | "project";

export interface AgentProfile {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	/** Extra subprocess flags (e.g., -e, --skill) */
	extraFlags?: string[];
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface DispatchResult {
	agent: string;
	agentSource: AgentSource;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface DispatchDetails {
	mode: "single" | "parallel" | "chain";
	results: DispatchResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<DispatchDetails>) => void;

// --- Agent discovery ---

function loadAgentsFromDir(dir: string, source: AgentSource): AgentProfile[] {
	const agents: AgentProfile[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

/**
 * Discover agents from package, user, and optionally project directories.
 * Package agents are always included. Project agents require explicit opt-in.
 */
export function discoverAgents(
	cwd: string,
	includeProject: boolean,
): { agents: AgentProfile[]; projectAgentsDir: string | null } {
	const packageDir = getPackageDir();
	const packageAgentsDir = path.join(packageDir, "agents");
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");

	// Find project agents dir
	let projectAgentsDir: string | null = null;
	let searchDir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(searchDir, ".pi", "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) {
				projectAgentsDir = candidate;
				break;
			}
		} catch {
			/* not found */
		}
		const parent = path.dirname(searchDir);
		if (parent === searchDir) break;
		searchDir = parent;
	}

	const agentMap = new Map<string, AgentProfile>();

	// Package agents first (lowest priority — overridable)
	for (const a of loadAgentsFromDir(packageAgentsDir, "package")) agentMap.set(a.name, a);
	// User agents override package
	for (const a of loadAgentsFromDir(userDir, "user")) agentMap.set(a.name, a);
	// Project agents override all (if enabled)
	if (includeProject && projectAgentsDir) {
		for (const a of loadAgentsFromDir(projectAgentsDir, "project")) agentMap.set(a.name, a);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

// --- Subprocess management ---

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "superteam-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Build subprocess args for an agent dispatch.
 * Applies deterministic isolation then explicit add-backs.
 */
function buildSubprocessArgs(agent: AgentProfile, cwd: string): string[] {
	const config = getConfig(cwd);
	const packageDir = getPackageDir();

	// Resolve model: agent profile → config override → config default
	const model =
		config.agents.modelOverrides[agent.name] ||
		agent.model ||
		(agent.name === "scout" ? config.agents.scoutModel : config.agents.defaultModel);

	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		// Deterministic isolation
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
	];

	if (model) args.push("--model", model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	// Explicit add-backs based on agent type
	if (agent.extraFlags) {
		args.push(...agent.extraFlags);
	}

	// Implementer gets: guard extension + TDD skill
	if (agent.name === "implementer") {
		const extensionPath = path.join(packageDir, "src", "index.ts");
		const skillPath = path.join(packageDir, "skills", "test-driven-development", "SKILL.md");

		if (fs.existsSync(extensionPath)) {
			args.push("-e", extensionPath);
		}
		if (fs.existsSync(skillPath)) {
			args.push("--skill", skillPath);
		}
	}

	return args;
}

/**
 * Dispatch a single agent. Returns structured result.
 */
export async function dispatchAgent(
	agent: AgentProfile,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	onUpdate?: OnUpdateCallback,
): Promise<DispatchResult> {
	const args = buildSubprocessArgs(agent, cwd);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const result: DispatchResult = {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
				details: { mode: "single", results: [result] },
			});
		}
	};

	try {
		// Write system prompt to temp file
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// Task goes last
		args.push(`Task: ${task}`);

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// message_end: assistant turn complete
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				// tool_result_end: tool finished
				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code: number | null) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) {
			result.exitCode = 1;
			result.errorMessage = "Subagent was aborted";
		}
		return result;
	} finally {
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}

// --- Utility exports ---

export { getFinalOutput };

/**
 * Format token count for display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Format usage stats for display.
 */
export function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}
