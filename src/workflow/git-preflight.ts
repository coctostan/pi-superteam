/**
 * Git preflight checks — ensure clean, isolated git state before workflow starts.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const defaultExecFile = promisify(execFileCb);

export interface GitPreflightResult {
	clean: boolean;
	branch: string;
	isMainBranch: boolean;
	sha: string;
	uncommittedFiles: string[];
	warnings: string[];
}

type ExecFn = (cmd: string, args: string[], opts: { cwd: string; timeout?: number }) => Promise<{ stdout: string }>;

const MAIN_BRANCHES = ["main", "master"];

/**
 * Check git state. Returns a pure result object — caller decides what to do.
 * Accepts optional execFn for testability.
 */
export async function runGitPreflight(
	cwd: string,
	execFn: ExecFn = defaultExecFile as unknown as ExecFn,
): Promise<GitPreflightResult> {
	const warnings: string[] = [];

	// 1. Check dirty state
	const { stdout: statusOut } = await execFn("git", ["status", "--porcelain"], { cwd, timeout: 5000 });
	const statusLines = statusOut.split("\n").filter(l => l.trim().length > 0);
	const clean = statusLines.length === 0;
	// Porcelain format: XY <space> filename — first 3 chars are status + separator
	const uncommittedFiles = statusLines.map(line => line.slice(3).trim());

	// 2. Get current branch
	const { stdout: branchOut } = await execFn("git", ["branch", "--show-current"], { cwd, timeout: 5000 });
	const branch = branchOut.trim();
	const isMainBranch = MAIN_BRANCHES.includes(branch);
	if (isMainBranch) {
		warnings.push("On main branch");
	}

	// 3. Get current SHA
	const { stdout: shaOut } = await execFn("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 });
	const sha = shaOut.trim();

	return { clean, branch, isMainBranch, sha, uncommittedFiles, warnings };
}
