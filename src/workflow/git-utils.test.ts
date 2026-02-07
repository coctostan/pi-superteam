import { describe, it, expect } from "vitest";
import { getTrackedFiles, computeChangedFiles, getCurrentSha } from "./git-utils.ts";
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
