import { describe, it, expect } from "vitest";
import {
  askReviewMode,
  askExecutionMode,
  askBatchSize,
  confirmPlanApproval,
  confirmTaskEscalation,
  formatInteractionForAgent,
  parseUserResponse,
} from "./interaction.ts";
import type { PendingInteraction } from "./orchestrator-state.ts";

describe("askReviewMode", () => {
  it("returns a choice interaction with id review-mode", () => {
    const result = askReviewMode();
    expect(result.id).toBe("review-mode");
    expect(result.type).toBe("choice");
    expect(result.options).toHaveLength(2);
  });

  it("has single-pass and iterative options", () => {
    const result = askReviewMode();
    const keys = result.options!.map((o) => o.key);
    expect(keys).toContain("single-pass");
    expect(keys).toContain("iterative");
  });

  it("includes descriptions for each option", () => {
    const result = askReviewMode();
    for (const opt of result.options!) {
      expect(opt.description).toBeTruthy();
    }
  });
});

describe("askExecutionMode", () => {
  it("returns a choice interaction with id execution-mode", () => {
    const result = askExecutionMode();
    expect(result.id).toBe("execution-mode");
    expect(result.type).toBe("choice");
    expect(result.options).toHaveLength(3);
  });

  it("has auto, checkpoint, and batch options", () => {
    const result = askExecutionMode();
    const keys = result.options!.map((o) => o.key);
    expect(keys).toContain("auto");
    expect(keys).toContain("checkpoint");
    expect(keys).toContain("batch");
  });
});

describe("askBatchSize", () => {
  it("returns an input interaction with id batch-size", () => {
    const result = askBatchSize();
    expect(result.id).toBe("batch-size");
    expect(result.type).toBe("input");
    expect(result.question).toBe("How many tasks per batch?");
    expect(result.default).toBe("3");
  });
});

describe("confirmPlanApproval", () => {
  it("returns a choice interaction with id plan-approval", () => {
    const result = confirmPlanApproval(2, ["Task A", "Task B"]);
    expect(result.id).toBe("plan-approval");
    expect(result.type).toBe("choice");
  });

  it("includes task count and titles in question", () => {
    const result = confirmPlanApproval(2, ["Task A", "Task B"]);
    expect(result.question).toContain("2");
    expect(result.question).toContain("Task A");
    expect(result.question).toContain("Task B");
  });

  it("has approve and revise options", () => {
    const result = confirmPlanApproval(1, ["Only task"]);
    const keys = result.options!.map((o) => o.key);
    expect(keys).toContain("approve");
    expect(keys).toContain("revise");
  });
});

describe("confirmTaskEscalation", () => {
  it("returns a choice interaction with id task-escalation", () => {
    const result = confirmTaskEscalation("Build API", "Tests failing");
    expect(result.id).toBe("task-escalation");
    expect(result.type).toBe("choice");
  });

  it("includes task title and reason in question", () => {
    const result = confirmTaskEscalation("Build API", "Tests failing");
    expect(result.question).toContain("Build API");
    expect(result.question).toContain("Tests failing");
  });

  it("has continue, skip, and abort options", () => {
    const result = confirmTaskEscalation("X", "Y");
    const keys = result.options!.map((o) => o.key);
    expect(keys).toContain("continue");
    expect(keys).toContain("skip");
    expect(keys).toContain("abort");
  });
});

describe("formatInteractionForAgent", () => {
  it("formats choice type with numbered options", () => {
    const interaction: PendingInteraction = {
      id: "test",
      type: "choice",
      question: "Pick one",
      options: [
        { key: "a", label: "Option A", description: "First option" },
        { key: "b", label: "Option B", description: "Second option" },
      ],
    };
    const text = formatInteractionForAgent(interaction);
    expect(text).toContain("Pick one");
    expect(text).toContain("1)");
    expect(text).toContain("2)");
    expect(text).toContain("Option A");
    expect(text).toContain("First option");
  });

  it("formats confirm type with yes/no", () => {
    const interaction: PendingInteraction = {
      id: "test",
      type: "confirm",
      question: "Are you sure?",
    };
    const text = formatInteractionForAgent(interaction);
    expect(text).toContain("Are you sure?");
    expect(text).toMatch(/yes/i);
    expect(text).toMatch(/no/i);
  });

  it("formats input type with default value", () => {
    const interaction: PendingInteraction = {
      id: "test",
      type: "input",
      question: "Enter value",
      default: "42",
    };
    const text = formatInteractionForAgent(interaction);
    expect(text).toContain("Enter value");
    expect(text).toContain("42");
  });

  it("formats input type without default", () => {
    const interaction: PendingInteraction = {
      id: "test",
      type: "input",
      question: "Enter value",
    };
    const text = formatInteractionForAgent(interaction);
    expect(text).toContain("Enter value");
  });
});

describe("parseUserResponse", () => {
  const choiceInteraction: PendingInteraction = {
    id: "test",
    type: "choice",
    question: "Pick one",
    options: [
      { key: "alpha", label: "Alpha Option" },
      { key: "beta", label: "Beta Option" },
    ],
  };

  describe("choice type", () => {
    it("accepts option key", () => {
      expect(parseUserResponse(choiceInteraction, "alpha")).toBe("alpha");
    });

    it("accepts option key case-insensitively", () => {
      expect(parseUserResponse(choiceInteraction, "ALPHA")).toBe("alpha");
    });

    it("accepts 1-based number", () => {
      expect(parseUserResponse(choiceInteraction, "1")).toBe("alpha");
      expect(parseUserResponse(choiceInteraction, "2")).toBe("beta");
    });

    it("accepts label", () => {
      expect(parseUserResponse(choiceInteraction, "Alpha Option")).toBe("alpha");
    });

    it("accepts label case-insensitively", () => {
      expect(parseUserResponse(choiceInteraction, "alpha option")).toBe("alpha");
    });

    it("trims whitespace", () => {
      expect(parseUserResponse(choiceInteraction, "  alpha  ")).toBe("alpha");
    });

    it("throws on invalid choice", () => {
      expect(() => parseUserResponse(choiceInteraction, "gamma")).toThrow();
    });

    it("throws on out-of-range number", () => {
      expect(() => parseUserResponse(choiceInteraction, "0")).toThrow();
      expect(() => parseUserResponse(choiceInteraction, "3")).toThrow();
    });

    it("error message is helpful", () => {
      expect(() => parseUserResponse(choiceInteraction, "bad")).toThrow(
        /alpha|beta/i
      );
    });
  });

  describe("input type", () => {
    const inputInteraction: PendingInteraction = {
      id: "test",
      type: "input",
      question: "Enter value",
      default: "42",
    };

    it("returns trimmed input", () => {
      expect(parseUserResponse(inputInteraction, "  hello  ")).toBe("hello");
    });

    it("returns default when empty", () => {
      expect(parseUserResponse(inputInteraction, "")).toBe("42");
      expect(parseUserResponse(inputInteraction, "   ")).toBe("42");
    });

    it("returns empty string when no default and empty input", () => {
      const noDefault: PendingInteraction = {
        id: "test",
        type: "input",
        question: "Enter value",
      };
      expect(parseUserResponse(noDefault, "")).toBe("");
    });
  });

  describe("confirm type", () => {
    const confirmInteraction: PendingInteraction = {
      id: "test",
      type: "confirm",
      question: "Are you sure?",
    };

    it("accepts y and returns yes", () => {
      expect(parseUserResponse(confirmInteraction, "y")).toBe("yes");
    });

    it("accepts yes and returns yes", () => {
      expect(parseUserResponse(confirmInteraction, "yes")).toBe("yes");
    });

    it("accepts n and returns no", () => {
      expect(parseUserResponse(confirmInteraction, "n")).toBe("no");
    });

    it("accepts no and returns no", () => {
      expect(parseUserResponse(confirmInteraction, "no")).toBe("no");
    });

    it("is case-insensitive", () => {
      expect(parseUserResponse(confirmInteraction, "YES")).toBe("yes");
      expect(parseUserResponse(confirmInteraction, "No")).toBe("no");
    });

    it("trims whitespace", () => {
      expect(parseUserResponse(confirmInteraction, "  yes  ")).toBe("yes");
    });

    it("throws on invalid input", () => {
      expect(() => parseUserResponse(confirmInteraction, "maybe")).toThrow();
    });
  });
});
