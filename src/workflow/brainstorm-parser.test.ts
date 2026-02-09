// src/workflow/brainstorm-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseBrainstormOutput, sanitizeJsonNewlines } from "./brainstorm-parser.js";
import { extractFencedBlock, extractLastBraceBlock, sanitizeJsonNewlines as sharedSanitize } from "../parse-utils.js";

describe("parseBrainstormOutput", () => {
  it("parses questions response from superteam-brainstorm block", () => {
    const raw = `Some preamble text\n\`\`\`superteam-brainstorm\n${JSON.stringify({
      type: "questions",
      questions: [
        { id: "q1", text: "What auth?", type: "choice", options: ["OAuth", "SAML"] },
        { id: "q2", text: "Performance target?", type: "input" },
      ],
    })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.type).toBe("questions");
      expect(result.data.questions).toHaveLength(2);
      expect(result.data.questions![0].options).toEqual(["OAuth", "SAML"]);
    }
  });

  it("parses approaches response", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({
      type: "approaches",
      approaches: [
        { id: "a1", title: "State machine", summary: "Clean", tradeoffs: "Boilerplate", taskEstimate: 5 },
      ],
      recommendation: "a1",
      reasoning: "Best fit",
    })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.type).toBe("approaches");
      expect(result.data.approaches).toHaveLength(1);
      expect(result.data.recommendation).toBe("a1");
    }
  });

  it("parses design response with sections", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({
      type: "design",
      sections: [
        { id: "s1", title: "Architecture", content: "The system uses..." },
        { id: "s2", title: "Data Flow", content: "User input flows..." },
      ],
    })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.type).toBe("design");
      expect(result.data.sections).toHaveLength(2);
    }
  });

  it("returns error when no fenced block found and no fallback JSON", () => {
    const result = parseBrainstormOutput("No structured output here");
    expect(result.status).toBe("error");
  });

  it("returns error for malformed JSON in fenced block", () => {
    const result = parseBrainstormOutput("```superteam-brainstorm\n{bad json\n```");
    expect(result.status).toBe("error");
  });

  it("returns error when type field is missing", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({ noType: true })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("error");
  });

  it("returns error for unknown type value", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({ type: "unknown_thing" })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("error");
  });

  it("falls back to last JSON brace block when no fenced block", () => {
    const raw = `Text before ${JSON.stringify({
      type: "questions",
      questions: [{ id: "q1", text: "Q?", type: "input" }],
    })} text after`;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
  });
});

describe("sanitizeJsonNewlines", () => {
  it("returns unchanged string when no literal newlines in JSON strings", () => {
    const input = '{"type":"questions","text":"hello"}';
    expect(sanitizeJsonNewlines(input)).toBe(input);
  });

  it("replaces literal newline inside a JSON string with escaped \\n", () => {
    const input = '{"text":"line1\nline2"}';
    const expected = '{"text":"line1\\nline2"}';
    expect(sanitizeJsonNewlines(input)).toBe(expected);
  });

  it("does not replace newlines outside of JSON strings", () => {
    const input = '{\n"text": "hello"\n}';
    expect(sanitizeJsonNewlines(input)).toBe(input);
  });

  it("handles escaped quotes correctly (does not toggle inString on escaped quote)", () => {
    // A string containing an escaped quote: "say \"hi\"\nbye"
    const input = '{"text":"say \\"hi\\"\\nbye"}';
    // The \\n here is already properly escaped (it's two chars: \ and n), no literal newline
    expect(sanitizeJsonNewlines(input)).toBe(input);
  });

  it("handles multiple literal newlines in multiple strings", () => {
    const input = '{"a":"x\ny","b":"p\nq"}';
    const expected = '{"a":"x\\ny","b":"p\\nq"}';
    expect(sanitizeJsonNewlines(input)).toBe(expected);
  });
});

describe("brainstorm-parser uses shared parse-utils", () => {
  it("sanitizeJsonNewlines re-exported from brainstorm-parser matches shared implementation", () => {
    const input = '{"a":"x\ny"}';
    expect(sanitizeJsonNewlines(input)).toBe(sharedSanitize(input));
  });

  it("parseBrainstormOutput uses shared extractFencedBlock for superteam-brainstorm blocks", () => {
    const obj = { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] };
    const raw = "```superteam-brainstorm\n" + JSON.stringify(obj) + "\n```";
    // Verify shared extractFencedBlock finds the same content
    const extracted = extractFencedBlock(raw, "superteam-brainstorm");
    expect(extracted).toBe(JSON.stringify(obj));
    // And parseBrainstormOutput still works
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
  });
});

describe("extractFencedBlock (via parseBrainstormOutput)", () => {
  it("handles inner triple-backtick inside a JSON string value", () => {
    const obj = {
      type: "design",
      sections: [{ id: "s1", title: "Guide", content: "Use a ```code``` block." }],
    };
    const raw = "```superteam-brainstorm\n" + JSON.stringify(obj) + "\n```";
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.type).toBe("design");
    }
  });

  it("handles fenced block with literal newlines in string values", () => {
    const jsonStr = '{"type":"questions","questions":[{"id":"q1","text":"a\nb","type":"input"}]}';
    const raw = "```superteam-brainstorm\n" + jsonStr + "\n```";
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
  });

  it("handles opening fence with leading whitespace (up to 3 spaces)", () => {
    const obj = { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] };
    const raw = "   ```superteam-brainstorm\n" + JSON.stringify(obj) + "\n```";
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
  });

  it("parses triage response", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({
      type: "triage",
      level: "straightforward",
      reasoning: "This is a focused change to one file.",
      suggestedSkips: ["questions", "approaches"],
    })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.type).toBe("triage");
      expect((result.data as any).level).toBe("straightforward");
      expect((result.data as any).reasoning).toBeTruthy();
      expect((result.data as any).suggestedSkips).toEqual(["questions", "approaches"]);
    }
  });

  it("parses triage response with batches for chunking", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({
      type: "triage",
      level: "complex",
      reasoning: "Broad change touching multiple systems.",
      batches: [
        { title: "Infrastructure", description: "Set up base types and validation" },
        { title: "Wiring", description: "Connect to orchestrator" },
      ],
    })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.type).toBe("triage");
      expect((result.data as any).batches).toHaveLength(2);
    }
  });

  it("parses triage response with splits for independent workflows", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({
      type: "triage",
      level: "exploration",
      reasoning: "Two independent concerns.",
      splits: [
        { title: "API endpoint", description: "New REST endpoint" },
        { title: "CLI refactor", description: "Refactor CLI help" },
      ],
    })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.type).toBe("triage");
      expect((result.data as any).splits).toHaveLength(2);
    }
  });

  it("triage with missing level defaults gracefully", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({
      type: "triage",
      reasoning: "No level specified.",
    })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect((result.data as any).level).toBe("exploration"); // default
    }
  });
});
