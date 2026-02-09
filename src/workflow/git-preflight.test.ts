import { describe, it, expect, vi } from "vitest";
import { runGitPreflight, type GitPreflightResult } from "./git-preflight.ts";

describe("runGitPreflight", () => {
  it("returns clean=true, branch name, and sha for clean non-main repo", async () => {
    const mockExec = vi.fn()
      .mockResolvedValueOnce({ stdout: "" })            // git status --porcelain → clean
      .mockResolvedValueOnce({ stdout: "feat/my-work\n" }) // git branch --show-current
      .mockResolvedValueOnce({ stdout: "abc123def456\n" }); // git rev-parse HEAD

    const result = await runGitPreflight("/fake", mockExec as any);
    expect(result.clean).toBe(true);
    expect(result.branch).toBe("feat/my-work");
    expect(result.isMainBranch).toBe(false);
    expect(result.sha).toBe("abc123def456");
    expect(result.uncommittedFiles).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("returns clean=false with uncommitted files for dirty repo", async () => {
    const mockExec = vi.fn()
      .mockResolvedValueOnce({ stdout: " M src/a.ts\n?? new.ts\n" }) // dirty
      .mockResolvedValueOnce({ stdout: "feat/work\n" })
      .mockResolvedValueOnce({ stdout: "abc123\n" });

    const result = await runGitPreflight("/fake", mockExec as any);
    expect(result.clean).toBe(false);
    expect(result.uncommittedFiles).toEqual(["src/a.ts", "new.ts"]);
  });

  it("detects main branch", async () => {
    const mockExec = vi.fn()
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "main\n" })
      .mockResolvedValueOnce({ stdout: "abc123\n" });

    const result = await runGitPreflight("/fake", mockExec as any);
    expect(result.isMainBranch).toBe(true);
    expect(result.warnings).toContain("On main branch");
  });

  it("detects master branch", async () => {
    const mockExec = vi.fn()
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "master\n" })
      .mockResolvedValueOnce({ stdout: "abc123\n" });

    const result = await runGitPreflight("/fake", mockExec as any);
    expect(result.isMainBranch).toBe(true);
  });
});
