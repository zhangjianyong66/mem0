import { describe, expect, it, vi } from "vitest";
import type { Mem0Provider, MemoryItem } from "../types.ts";
import {
  recall,
  sanitizeQuery,
  shouldRecallLongTermMemory,
} from "../recall.ts";

function makeProvider(results: MemoryItem[]): Mem0Provider {
  return {
    add: vi.fn(),
    search: vi.fn().mockResolvedValue(results),
    get: vi.fn(),
    getAll: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteAll: vi.fn(),
    history: vi.fn(),
  } as unknown as Mem0Provider;
}

describe("sanitizeQuery", () => {
  it("removes sender metadata blocks", () => {
    const query = sanitizeQuery(
      'Sender (untrusted metadata): ```json\n{"name":"x"}\n```\n继续分析这个配置',
    );
    expect(query).toBe("继续分析这个配置");
  });
});

describe("shouldRecallLongTermMemory", () => {
  it("skips short continuation queries", () => {
    expect(shouldRecallLongTermMemory("继续", {})).toEqual({
      decision: "skip",
      reason: "short_query",
    });
  });

  it("skips current-task requests when present context should be enough", () => {
    expect(shouldRecallLongTermMemory("帮我看看这个文件的报错", {})).toEqual({
      decision: "skip",
      reason: "current_task_context",
    });
  });

  it("recalls long-term + session memories when history intent is explicit", () => {
    expect(shouldRecallLongTermMemory("我之前怎么配的飞书 replyMode", {})).toEqual({
      decision: "long_term_plus_session",
    });
  });

  it("recalls long-term + session memories for a meaningful continuation", () => {
    expect(shouldRecallLongTermMemory("继续分析这个配置", {})).toEqual({
      decision: "long_term_plus_session",
    });
  });
});

describe("recall", () => {
  it("deduplicates same-topic memories and emits summarized sections", async () => {
    const provider = makeProvider([
      {
        id: "1",
        memory: "As of 2026-04-10, user changed Feishu replyMode to final while investigating delay.",
        score: 0.92,
        metadata: {
          category: "configuration",
          topicKey: "feishu-delay",
          entityKey: "feishu-delay",
        },
      },
      {
        id: "2",
        memory: "As of 2026-04-10, user is investigating Feishu delay and focusing on debounceMs.",
        score: 0.9,
        metadata: {
          category: "configuration",
          topicKey: "feishu-delay",
          entityKey: "feishu-delay",
        },
      },
      {
        id: "3",
        memory: "User prefers direct code-first answers.",
        score: 0.89,
        metadata: { category: "preference", topicKey: "pref:direct" },
      },
      {
        id: "4",
        memory: "User rule: verify current config before recommending changes.",
        score: 0.88,
        metadata: { category: "rule", topicKey: "rule:verify-config" },
      },
    ]);

    const result = await recall(provider, "我之前怎么配的飞书延迟问题", "zhangjianyong", {
      recall: {
        summaryEnabled: true,
        dedupeEnabled: true,
        rawTopK: 8,
        finalMaxMemories: 4,
        threshold: 0.6,
        relativeScoreThreshold: 0.72,
      },
    });

    expect(result.memories).toHaveLength(3);
    expect(result.debug.rawCandidateCount).toBe(4);
    expect(result.debug.postThresholdCount).toBe(4);
    expect(result.debug.postDedupeCount).toBe(3);
    expect(result.context).toContain("Rules:");
    expect(result.context).toContain("Preferences:");
    expect(result.context).toContain("Decisions / Config:");
    expect(result.context).not.toContain("(92%)");
  });

  it("drops identity memories for non-identity queries when identityMode is on-demand", async () => {
    const provider = makeProvider([
      {
        id: "1",
        memory: "User is based in Asia/Shanghai timezone.",
        score: 0.95,
        metadata: { category: "identity", topicKey: "identity:timezone" },
      },
      {
        id: "2",
        memory: "User rule: verify config before recommending changes.",
        score: 0.91,
        metadata: { category: "rule", topicKey: "rule:verify-config" },
      },
    ]);

    const result = await recall(provider, "我之前定过什么规则", "zhangjianyong", {
      recall: {
        identityMode: "on-demand",
      },
    });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.id).toBe("2");
  });
});
