/**
 * Workflow queue — manages a queue of workflow runs (for splits from triage).
 * File-based: reads/writes .superteam-queue.json in the project directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const QUEUE_FILE = ".superteam-queue.json";

export type QueuedWorkflow = {
	title: string;
	description: string;
	parentScoutOutput?: string;
	parentDesignPath?: string;
};

function queuePath(cwd: string): string {
	return path.join(cwd, QUEUE_FILE);
}

function readQueue(cwd: string): QueuedWorkflow[] {
	const p = queuePath(cwd);
	if (!fs.existsSync(p)) return [];
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch {
		return [];
	}
}

function writeQueue(cwd: string, items: QueuedWorkflow[]): void {
	fs.writeFileSync(queuePath(cwd), JSON.stringify(items, null, 2));
}

export function enqueueWorkflow(cwd: string, item: QueuedWorkflow): void {
	const items = readQueue(cwd);
	items.push(item);
	writeQueue(cwd, items);
}

export function dequeueWorkflow(cwd: string): QueuedWorkflow | undefined {
	const items = readQueue(cwd);
	if (items.length === 0) return undefined;
	const first = items.shift()!;
	writeQueue(cwd, items);
	return first;
}

export function peekQueue(cwd: string): QueuedWorkflow[] {
	return readQueue(cwd);
}

export function clearQueue(cwd: string): void {
	const p = queuePath(cwd);
	if (fs.existsSync(p)) fs.unlinkSync(p);
}
