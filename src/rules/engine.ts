/**
 * Rule Engine — TTSR-like context-aware rule injection.
 *
 * Loads markdown rules with trigger patterns (regex).
 * On context event, scans recent assistant output for matches.
 * Injects matched rule content as user message for high recency weight.
 *
 * Inspired by can1357/oh-my-pi TTSR concept (MIT).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { ContextEvent, ContextEventResult } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { getPackageDir } from "../config.js";

// --- Types ---

export type RuleFrequency = "once" | "per-turn" | `cooldown:${number}`;

export interface Rule {
	name: string;
	trigger: RegExp;
	content: string;
	priority: "high" | "medium" | "low";
	frequency: RuleFrequency;
	filePath: string;
}

interface RuleState {
	firedCount: number;
	lastFiredTurn: number;
}

// --- State ---

let rules: Rule[] = [];
let ruleStates: Record<string, RuleState> = {};
let currentTurn = 0;
const SCAN_CHARS = 2000;

// --- Rule loading ---

function loadRulesFromDir(dir: string): Rule[] {
	const loaded: Rule[] = [];
	if (!fs.existsSync(dir)) return loaded;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return loaded;
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
		if (!frontmatter.name || !frontmatter.trigger || !body.trim()) continue;

		let trigger: RegExp;
		try {
			trigger = new RegExp(frontmatter.trigger, "i");
		} catch {
			continue; // Invalid regex — skip
		}

		loaded.push({
			name: frontmatter.name,
			trigger,
			content: body.trim(),
			priority: (frontmatter.priority as Rule["priority"]) || "medium",
			frequency: (frontmatter.frequency as RuleFrequency) || "per-turn",
			filePath,
		});
	}

	return loaded;
}

/**
 * Load rules from package rules/ directory and optional project rules.
 */
export function loadRules(projectRulesDir?: string): void {
	const packageDir = getPackageDir();
	const packageRulesDir = path.join(packageDir, "rules");

	rules = [];
	ruleStates = {};
	currentTurn = 0;

	rules.push(...loadRulesFromDir(packageRulesDir));

	if (projectRulesDir) {
		rules.push(...loadRulesFromDir(projectRulesDir));
	}

	// Sort by priority (high first)
	const priorityOrder = { high: 0, medium: 1, low: 2 };
	rules.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

export function getRules(): Rule[] {
	return rules;
}

export function resetRuleStates(): void {
	ruleStates = {};
	currentTurn = 0;
}

// --- Context event handler ---

/**
 * Extract recent assistant text from messages (last SCAN_CHARS).
 */
function getRecentAssistantText(messages: AgentMessage[]): string {
	const chunks: string[] = [];
	let totalLen = 0;

	// Walk backwards through messages
	for (let i = messages.length - 1; i >= 0 && totalLen < SCAN_CHARS; i--) {
		const msg = messages[i] as Message;
		if (msg.role !== "assistant") continue;

		for (const part of msg.content || []) {
			if ("text" in part && part.text) {
				chunks.unshift(part.text);
				totalLen += part.text.length;
			}
		}
	}

	const fullText = chunks.join("\n");
	return fullText.length > SCAN_CHARS ? fullText.slice(-SCAN_CHARS) : fullText;
}

/**
 * Check if a rule should fire based on frequency.
 */
function shouldFire(rule: Rule): boolean {
	const state = ruleStates[rule.name];
	if (!state) return true; // Never fired

	if (rule.frequency === "once") return false;
	if (rule.frequency === "per-turn") return true;

	// cooldown:N
	const match = rule.frequency.match(/^cooldown:(\d+)$/);
	if (match) {
		const cooldown = parseInt(match[1], 10);
		return currentTurn - state.lastFiredTurn >= cooldown;
	}

	return true;
}

function markFired(rule: Rule): void {
	if (!ruleStates[rule.name]) {
		ruleStates[rule.name] = { firedCount: 0, lastFiredTurn: 0 };
	}
	ruleStates[rule.name].firedCount++;
	ruleStates[rule.name].lastFiredTurn = currentTurn;
}

/**
 * Handle context event: scan recent output, inject matching rules.
 */
export function handleContext(
	event: ContextEvent,
): ContextEventResult | undefined {
	if (rules.length === 0) return undefined;

	currentTurn++;
	const recentText = getRecentAssistantText(event.messages);
	if (!recentText) return undefined;

	const injections: { rule: Rule; content: string }[] = [];

	for (const rule of rules) {
		if (!shouldFire(rule)) continue;
		if (rule.trigger.test(recentText)) {
			injections.push({ rule, content: rule.content });
			markFired(rule);
		}
	}

	if (injections.length === 0) return undefined;

	// Inject as user messages at the end of the context
	const ruleMessages: Message[] = injections.map(({ rule, content }) => ({
		role: "user" as const,
		content: [
			{
				type: "text" as const,
				text: `[superteam rule: ${rule.name}] ${content}`,
			},
		],
	}));

	return {
		messages: [...event.messages, ...ruleMessages],
	};
}
