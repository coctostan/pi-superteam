// src/workflow/brainstorm-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseBrainstormOutput } from "./brainstorm-parser.js";

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
