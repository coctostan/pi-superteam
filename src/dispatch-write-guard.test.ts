import { describe, it, expect } from "vitest";
import { hasWriteToolCalls } from "./dispatch.ts";
import type { Message } from "@mariozechner/pi-ai";

function makeToolCallMessage(toolName: string, args: Record<string, any> = {}): Message {
	return {
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "call_1",
				name: toolName,
				input: args,
			},
		],
	} as unknown as Message;
}

function makeTextMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as Message;
}

describe("hasWriteToolCalls", () => {
	it("returns false for empty messages array", () => {
		expect(hasWriteToolCalls([])).toBe(false);
	});

	it("returns false for messages with only read tools", () => {
		const messages = [
			makeToolCallMessage("read", { path: "src/index.ts" }),
			makeToolCallMessage("grep", { pattern: "TODO" }),
			makeToolCallMessage("find", { path: "src" }),
			makeToolCallMessage("ls", { path: "." }),
		];
		expect(hasWriteToolCalls(messages)).toBe(false);
	});

	it("returns true for write tool calls", () => {
		const messages = [makeToolCallMessage("write", { path: "src/index.ts", content: "hello" })];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});

	it("returns true for edit tool calls", () => {
		const messages = [makeToolCallMessage("edit", { path: "src/index.ts", oldText: "a", newText: "b" })];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});

	it("returns true for bash commands with redirect >", () => {
		const messages = [makeToolCallMessage("bash", { command: "echo hello > file.txt" })];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});

	it("returns true for bash commands with append >>", () => {
		const messages = [makeToolCallMessage("bash", { command: "cat data >> log.txt" })];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});

	it("returns true for bash commands with tee", () => {
		const messages = [makeToolCallMessage("bash", { command: "echo hello | tee output.txt" })];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});

	it("returns true for bash commands with sed -i", () => {
		const messages = [makeToolCallMessage("bash", { command: "sed -i 's/old/new/g' file.txt" })];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});

	it("returns true for bash commands with mv", () => {
		const messages = [makeToolCallMessage("bash", { command: "mv old.ts new.ts" })];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});

	it("returns true for bash commands with cp", () => {
		const messages = [makeToolCallMessage("bash", { command: "cp src.ts dest.ts" })];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});

	it("returns false for bash read-only commands", () => {
		const messages = [
			makeToolCallMessage("bash", { command: "cat file.txt" }),
			makeToolCallMessage("bash", { command: "ls -la" }),
			makeToolCallMessage("bash", { command: "grep -r pattern src/" }),
		];
		expect(hasWriteToolCalls(messages)).toBe(false);
	});

	it("returns false for text-only messages", () => {
		const messages = [makeTextMessage("I reviewed the code and it looks good.")];
		expect(hasWriteToolCalls(messages)).toBe(false);
	});

	it("detects write tools among mixed messages", () => {
		const messages = [
			makeTextMessage("Let me check the code."),
			makeToolCallMessage("read", { path: "src/index.ts" }),
			makeToolCallMessage("edit", { path: "src/index.ts", oldText: "a", newText: "b" }),
		];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});

	it("returns true for bash commands with rm", () => {
		const messages = [makeToolCallMessage("bash", { command: "rm -rf dist/" })];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});

	it("returns true for bash commands with mkdir", () => {
		const messages = [makeToolCallMessage("bash", { command: "mkdir -p src/new" })];
		expect(hasWriteToolCalls(messages)).toBe(true);
	});
});
