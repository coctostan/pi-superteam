import { describe, it, expect } from "vitest";
import { getTrackedFiles, computeChangedFiles, getCurrentSha, resetToSha, squashCommitsSince, squashTaskCommits } from "./git-utils.ts";

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// Helper to create a temp dir that is NOT a git repo
function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "git-utils-test-"));
}

// Helper to create a temp git repo with an initial commit
async function makeTempRepo(): Promise<string> {
	const dir = makeTempDir();
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const run = promisify(execFile);
	await run("git", ["init"], { cwd: dir });
	await run("git", ["config", "user.email", "test@test.com"], { cwd: dir });
	await run("git", ["config", "user.name", "Test"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "file1.txt"), "hello");
	await run("git", ["add", "."], { cwd: dir });
	await run("git", ["commit", "-m", "initial"], { cwd: dir });
	return dir;
}

describe("getTrackedFiles", () => {
	it("returns tracked files in a git repo", async () => {
		const dir = await makeTempRepo();
		const files = await getTrackedFiles(dir);
		expect(files).toContain("file1.txt");
	});

	it("returns empty array for non-repo directory", async () => {
		const dir = makeTempDir();
		const files = await getTrackedFiles(dir);
		expect(files).toEqual([]);
	});

	it("returns empty array for nonexistent directory", async () => {
		const files = await getTrackedFiles("/nonexistent-dir-abc123");
		expect(files).toEqual([]);
	});
});

describe("computeChangedFiles", () => {
	it("returns changed files with no baseSha (unstaged changes)", async () => {
		const dir = await makeTempRepo();
		// Modify tracked file
		fs.writeFileSync(path.join(dir, "file1.txt"), "modified");
		const changed = await computeChangedFiles(dir);
		expect(changed).toContain("file1.txt");
	});

	it("returns changed files between baseSha and HEAD", async () => {
		const dir = await makeTempRepo();
		const baseSha = (await getCurrentSha(dir));
		// Create a new commit
		fs.writeFileSync(path.join(dir, "file2.txt"), "new file");
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const run = promisify(execFile);
		await run("git", ["add", "."], { cwd: dir });
		await run("git", ["commit", "-m", "second"], { cwd: dir });
		const changed = await computeChangedFiles(dir, baseSha);
		expect(changed).toContain("file2.txt");
		expect(changed).not.toContain("file1.txt");
	});

	it("returns empty array for non-repo directory", async () => {
		const dir = makeTempDir();
		const changed = await computeChangedFiles(dir);
		expect(changed).toEqual([]);
	});

	it("returns empty array for nonexistent directory", async () => {
		const changed = await computeChangedFiles("/nonexistent-dir-abc123");
		expect(changed).toEqual([]);
	});
});

describe("getCurrentSha", () => {
	it("returns a 40-char hex SHA in a git repo", async () => {
		const dir = await makeTempRepo();
		const sha = await getCurrentSha(dir);
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("returns empty string for non-repo directory", async () => {
		const dir = makeTempDir();
		const sha = await getCurrentSha(dir);
		expect(sha).toBe("");
	});

	it("returns empty string for nonexistent directory", async () => {
		const sha = await getCurrentSha("/nonexistent-dir-abc123");
		expect(sha).toBe("");
	});
});

// Shared helper for new tests
const { execFile: execFileCb } = await import("node:child_process");
const { promisify } = await import("node:util");
const run = promisify(execFileCb);

describe("resetToSha", () => {
	it("resets to a previous commit SHA", async () => {
		const dir = await makeTempRepo();
		const baseSha = await getCurrentSha(dir);

		fs.writeFileSync(path.join(dir, "file2.txt"), "new");
		await run("git", ["add", "."], { cwd: dir });
		await run("git", ["commit", "-m", "second"], { cwd: dir });

		const headBefore = await getCurrentSha(dir);
		expect(headBefore).not.toBe(baseSha);

		const success = await resetToSha(dir, baseSha);
		expect(success).toBe(true);

		const headAfter = await getCurrentSha(dir);
		expect(headAfter).toBe(baseSha);
		expect(fs.existsSync(path.join(dir, "file2.txt"))).toBe(false);
	});

	it("returns false for empty SHA", async () => {
		const dir = await makeTempRepo();
		const result = await resetToSha(dir, "");
		expect(result).toBe(false);
	});

	it("returns false for invalid SHA", async () => {
		const dir = await makeTempRepo();
		const result = await resetToSha(dir, "0000000000000000000000000000000000000000");
		expect(result).toBe(false);
	});

	it("returns false for non-repo directory", async () => {
		const dir = makeTempDir();
		const result = await resetToSha(dir, "abc123");
		expect(result).toBe(false);
	});
});

describe("squashCommitsSince", () => {
	it("squashes multiple commits into one", async () => {
		const dir = await makeTempRepo();
		const baseSha = await getCurrentSha(dir);

		fs.writeFileSync(path.join(dir, "file2.txt"), "new");
		await run("git", ["add", "."], { cwd: dir });
		await run("git", ["commit", "-m", "second"], { cwd: dir });

		fs.writeFileSync(path.join(dir, "file3.txt"), "another");
		await run("git", ["add", "."], { cwd: dir });
		await run("git", ["commit", "-m", "third"], { cwd: dir });

		const success = await squashCommitsSince(dir, baseSha, "feat: squashed");
		expect(success).toBe(true);

		const { stdout } = await run("git", ["log", "--oneline"], { cwd: dir });
		const lines = stdout.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("feat: squashed");

		expect(fs.existsSync(path.join(dir, "file2.txt"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "file3.txt"))).toBe(true);
	});

	it("is a no-op when baseSha equals HEAD (no new commits)", async () => {
		const dir = await makeTempRepo();
		const sha = await getCurrentSha(dir);

		const success = await squashCommitsSince(dir, sha, "feat: nothing");
		expect(success).toBe(true);

		const headAfter = await getCurrentSha(dir);
		expect(headAfter).toBe(sha);
	});

	it("returns false for non-repo directory", async () => {
		const dir = makeTempDir();
		const result = await squashCommitsSince(dir, "abc123", "msg");
		expect(result).toBe(false);
	});
});

describe("squashTaskCommits", () => {
	it("stages unstaged changes, squashes commits, returns new SHA", async () => {
		const dir = await makeTempRepo();
		const baseSha = await getCurrentSha(dir);

		// Make two commits (simulating implementer TDD cycles)
		fs.writeFileSync(path.join(dir, "src.ts"), "impl");
		await run("git", ["add", "."], { cwd: dir });
		await run("git", ["commit", "-m", "wip: red"], { cwd: dir });

		fs.writeFileSync(path.join(dir, "test.ts"), "test");
		await run("git", ["add", "."], { cwd: dir });
		await run("git", ["commit", "-m", "wip: green"], { cwd: dir });

		const result = await squashTaskCommits(dir, baseSha, 1, "Add widget");
		expect(result.success).toBe(true);
		expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

		// Verify single squashed commit on top of initial
		const { stdout } = await run("git", ["log", "--oneline"], { cwd: dir });
		const lines = stdout.trim().split("\n");
		expect(lines).toHaveLength(2); // initial + squashed
		expect(lines[0]).toContain("workflow: task 1");
		expect(lines[0]).toContain("Add widget");

		// Files still exist
		expect(fs.existsSync(path.join(dir, "src.ts"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "test.ts"))).toBe(true);
	});

	it("handles unstaged changes by committing them before squash", async () => {
		const dir = await makeTempRepo();
		const baseSha = await getCurrentSha(dir);

		fs.writeFileSync(path.join(dir, "a.ts"), "committed");
		await run("git", ["add", "."], { cwd: dir });
		await run("git", ["commit", "-m", "wip"], { cwd: dir });

		// Leave an unstaged file
		fs.writeFileSync(path.join(dir, "b.ts"), "unstaged");

		const result = await squashTaskCommits(dir, baseSha, 2, "Another task");
		expect(result.success).toBe(true);

		// Both files present after squash
		expect(fs.existsSync(path.join(dir, "a.ts"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "b.ts"))).toBe(true);
	});

	it("returns success with current SHA when no changes since baseSha", async () => {
		const dir = await makeTempRepo();
		const sha = await getCurrentSha(dir);

		const result = await squashTaskCommits(dir, sha, 3, "No changes");
		expect(result.success).toBe(true);
		expect(result.sha).toBe(sha);
	});

	it("returns error for non-repo directory", async () => {
		const dir = makeTempDir();
		const result = await squashTaskCommits(dir, "abc", 1, "Test");
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});
});
