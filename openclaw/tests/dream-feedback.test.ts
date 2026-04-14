import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../fs-safe.ts", () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
  mkdirp: vi.fn(),
}));

import { mkdirp, readText, writeText } from "../fs-safe.ts";
import {
  buildDreamFeedbackRun,
  extractDreamWriteActionsFromAssistant,
  getCandidateFeedbackTuning,
  recordDreamFeedback,
} from "../dream-feedback.ts";

const mockReadText = readText as ReturnType<typeof vi.fn>;
const mockWriteText = writeText as ReturnType<typeof vi.fn>;
const mockMkdirp = mkdirp as ReturnType<typeof vi.fn>;
const STATE_DIR = "/tmp/test-state";

beforeEach(() => {
  vi.resetAllMocks();
  mockMkdirp.mockReturnValue(undefined);
});

describe("dream-feedback", () => {
  it("extracts write actions from assistant tool_use blocks", () => {
    const assistant = {
      content: [
        {
          type: "tool_use",
          name: "memory_update",
          input: {
            memoryId: "m1",
            text: "Updated text",
          },
        },
        {
          type: "tool_use",
          name: "memory_delete",
          input: {
            memoryId: "m2",
          },
        },
        {
          type: "tool_use",
          name: "memory_add",
          input: {
            facts: ["As of 2026-04-14, user is migrating the gateway."],
            category: "project",
            metadata: {
              topicKey: "project:gateway",
              entityKey: "project:gateway",
            },
          },
        },
      ],
    };

    const extracted = extractDreamWriteActionsFromAssistant(assistant);

    expect(extracted.parseComplete).toBe(true);
    expect(extracted.actions).toHaveLength(3);
    expect(extracted.actions[0]?.type).toBe("rewrite_or_merge");
    expect(extracted.actions[1]?.type).toBe("delete");
    expect(extracted.actions[2]?.topicKey).toBe("project:gateway");
  });

  it("records topic and memory outcomes into local feedback state", () => {
    mockReadText.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const run = buildDreamFeedbackRun(
      {
        content: [
          {
            type: "tool_use",
            name: "memory_delete",
            input: { memoryId: "m-old" },
          },
          {
            type: "tool_use",
            name: "memory_add",
            input: {
              facts: ["As of 2026-04-14, user consolidated gateway migration notes."],
              category: "project",
              metadata: {
                topicKey: "project:gateway",
                entityKey: "project:gateway",
              },
            },
          },
        ],
      },
      1712000000000,
    );

    const state = recordDreamFeedback(STATE_DIR, run, {
      "m-old": {
        id: "m-old",
        memory: "Old gateway note",
        metadata: {
          category: "project",
          topicKey: "project:gateway",
          entityKey: "project:gateway",
        },
      },
    });

    expect(state.recentDreamRuns).toHaveLength(1);
    expect(state.topicOutcomes["project:gateway"]?.duplicateDeletes).toBe(1);
    expect(state.topicOutcomes["project:gateway"]?.consolidatedReplacements).toBe(1);
    expect(state.writeOutcomeByMemoryId["m-old"]?.duplicateDeletes).toBe(1);
    expect(mockWriteText).toHaveBeenCalled();
  });

  it("returns tuning signals for candidates with recent feedback", () => {
    mockReadText.mockReturnValue(
      JSON.stringify({
        lastUpdatedAt: 1712000000000,
        recentDreamRuns: [],
        topicOutcomes: {},
        writeOutcomeByMemoryId: {
          m1: {
            memoryId: "m1",
            mergeFixups: 1,
            rewriteFixups: 0,
            duplicateDeletes: 1,
            consolidatedReplacements: 0,
            lastUpdatedAt: Date.now(),
            lastDreamRunId: "dream-1",
          },
        },
        dedupeTuning: {
          "project:gateway": {
            duplicateDeleteBias: 0.08,
            mergeFixupBias: 0.1,
            rewriteFixupBias: 0,
            consolidatedReplacementBias: 0.06,
            lastUpdatedAt: Date.now(),
          },
        },
      }),
    );

    const tuning = getCandidateFeedbackTuning(STATE_DIR, {
      id: "m1",
      memory: "Gateway migration note",
      metadata: {
        category: "project",
        topicKey: "project:gateway",
        entityKey: "project:gateway",
      },
    });

    expect(tuning.feedbackApplied).toBe(true);
    expect(tuning.feedbackTopicHit).toBe(true);
    expect(tuning.dynamicThresholdDelta).toBeGreaterThan(0.1);
  });
});
