/**
 * Pure git utility functions — no imports from other superteam modules.
 * All functions are async and gracefully handle errors (return empty values).
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

function splitLines(output: string): string[] {
	return output
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/**
 * List tracked files in the repo at `cwd`.
 * Returns empty array if git fails (e.g. not a repo).
 */
export async function getTrackedFiles(cwd: string): Promise<string[]> {
	try {
		const { stdout } = await execFile("git", ["ls-files"], { cwd, timeout: 5000 });
		return splitLines(stdout);
	} catch {
		return [];
	}
}

/**
 * Compute changed files.
 * If `baseSha` is provided, returns `git diff --name-only baseSha HEAD`.
 * Otherwise returns `git diff --name-only` (unstaged changes).
 * Returns empty array on error.
 */
export async function computeChangedFiles(cwd: string, baseSha?: string): Promise<string[]> {
	try {
		const args = baseSha
			? ["diff", "--name-only", baseSha, "HEAD"]
			: ["diff", "--name-only"];
		const { stdout } = await execFile("git", args, { cwd, timeout: 5000 });
		return splitLines(stdout);
	} catch {
		return [];
	}
}

/**
 * Get current HEAD SHA. Returns trimmed 40-char hex string.
 * Returns empty string on error.
 */
export async function getCurrentSha(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 });
		return stdout.trim();
	} catch {
		return "";
	}
}

/**
 * Hard-reset the repo at `cwd` to the given SHA.
 * Returns true on success, false on any failure.
 */
export async function resetToSha(cwd: string, sha: string): Promise<boolean> {
	if (!sha) return false;
	try {
		await execFile("git", ["reset", "--hard", sha], { cwd, timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Squash all commits since `baseSha` into a single commit with the given message.
 * If baseSha equals HEAD (no new commits), this is a no-op returning true.
 * Returns false on any failure.
 */
export async function squashCommitsSince(cwd: string, baseSha: string, message: string): Promise<boolean> {
	try {
		const currentSha = await getCurrentSha(cwd);
		if (!currentSha) return false;
		if (currentSha === baseSha) return true;

		await execFile("git", ["reset", "--soft", baseSha], { cwd, timeout: 5000 });
		await execFile("git", ["commit", "-m", message], { cwd, timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}
