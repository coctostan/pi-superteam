import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("security-reviewer agent", () => {
  it("includes bash in tools", () => {
    const content = fs.readFileSync(path.resolve(import.meta.dirname, "../security-reviewer.md"), "utf-8");
    expect(content).toMatch(/^tools:.*bash/m);
  });
});
