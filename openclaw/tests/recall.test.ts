import { describe, expect, it, vi } from "vitest";
import type { Mem0Provider, MemoryItem } from "../types.ts";
import {
  getAdaptiveSearchThreshold,
  recall,
  sanitizeQuery,
  rewriteMemoryQuery,
  shouldRecallLongTermMemory,
} from "../recall.ts";
import { getMemoryCategory } from "../tools/topic-match.ts";

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

describe("rewriteMemoryQuery", () => {
  it("keeps the query close to the user's wording", () => {
    expect(rewriteMemoryQuery("还记得我喜欢吃什么吗")).toBe(
      "还记得我喜欢吃什么吗",
    );
  });
});

describe("getAdaptiveSearchThreshold", () => {
  it("returns the provided baseline threshold", () => {
    expect(getAdaptiveSearchThreshold("还记得我喜欢吃什么吗", 0.5)).toBe(0.5);
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
  it("uses the cleaned raw query and the provided threshold baseline", async () => {
    const provider = makeProvider([
      {
        id: "1",
        memory: "用户喜欢吃芒果、凤梨和哈密瓜，其中芒果是心头好。",
        score: 0.48,
        metadata: { category: "preference" },
      },
    ]);

    const result = await recall(
      provider,
      "还记得我喜欢吃什么吗",
      "zhangjianyong",
      {
        recall: {
          threshold: 0.5,
        },
      },
    );

    expect(provider.search).toHaveBeenCalledWith(
      "还记得我喜欢吃什么吗",
      expect.objectContaining({
        threshold: 0.5,
      }),
    );
    expect(result.debug.searchQuery).toBe("还记得我喜欢吃什么吗");
    expect(result.debug.threshold).toBe(0.5);
    expect(result.debug.rawTopK).toBe(8);
    expect(result.debug.sessionSearchEnabled).toBe(false);
    expect(result.memories).toHaveLength(0);
  });

  it("reports session search diagnostics when session recall is enabled", async () => {
    const provider = makeProvider([]);

    const result = await recall(
      provider,
      "  Sender (untrusted metadata): ```json\n{\"name\":\"x\"}\n```\n还记得我喜欢吃什么吗  ",
      "zhangjianyong",
      {
        recall: {
          rawTopK: 6,
          threshold: 0.55,
        },
      },
      "agent:main:feishu:direct:user",
    );

    expect(provider.search).toHaveBeenNthCalledWith(
      1,
      "还记得我喜欢吃什么吗",
      expect.objectContaining({
        threshold: 0.55,
        top_k: 6,
      }),
    );
    expect(provider.search).toHaveBeenNthCalledWith(
      2,
      "还记得我喜欢吃什么吗",
      expect.objectContaining({
        threshold: 0.55,
        top_k: 5,
        run_id: "agent:main:feishu:direct:user",
      }),
    );
    expect(result.debug.searchQuery).toBe("还记得我喜欢吃什么吗");
    expect(result.debug.threshold).toBe(0.55);
    expect(result.debug.rawTopK).toBe(6);
    expect(result.debug.sessionSearchEnabled).toBe(true);
  });

  it("uses the lower default threshold when no recall threshold is configured", async () => {
    const provider = makeProvider([
      {
        id: "1",
        memory: "用户喜欢吃芒果、凤梨和哈密瓜，其中芒果是心头好。",
        score: 0.53,
        metadata: { category: "preference" },
      },
    ]);

    const result = await recall(
      provider,
      "你还记得我喜欢吃什么食物吗",
      "zhangjianyong",
      {},
    );

    expect(provider.search).toHaveBeenCalledWith(
      "你还记得我喜欢吃什么食物吗",
      expect.objectContaining({
        threshold: 0.5,
      }),
    );
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.id).toBe("1");
  });

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
        threshold: 0.5,
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

  it("does not truncate recalled items within the same summary section", async () => {
    const provider = makeProvider([
      {
        id: "1",
        memory: "用户喜欢吃芒果、凤梨和哈密瓜，其中芒果是心头好。",
        score: 0.62,
        metadata: { category: "preference" },
      },
      {
        id: "2",
        memory: "用户喜欢吃榴莲。",
        score: 0.59,
        metadata: { category: "preference" },
      },
      {
        id: "3",
        memory: "用户喜欢吃西瓜。",
        score: 0.57,
        metadata: { category: "preference" },
      },
    ]);

    const result = await recall(
      provider,
      "你还记得我喜欢吃什么食物吗",
      "zhangjianyong",
      {
        recall: {
          summaryEnabled: true,
          dedupeEnabled: false,
          threshold: 0.5,
          relativeScoreThreshold: 0.5,
          finalMaxMemories: 3,
        },
      },
    );

    expect(result.memories).toHaveLength(3);
    expect(result.context).toContain("用户喜欢吃芒果、凤梨和哈密瓜，其中芒果是心头好。");
    expect(result.context).toContain("用户喜欢吃榴莲。");
    expect(result.context).toContain("用户喜欢吃西瓜。");
  });

  it("promotes memories with direct query-term overlap over generic preferences", async () => {
    const provider = makeProvider([
      {
        id: "format-1",
        memory: "用户偏好助手长期记住输出模板，并应用于未来对话中。",
        score: 0.57,
        metadata: { category: "preference" },
      },
      {
        id: "format-2",
        memory: "用户要求助手长期记住其偏好的输出格式，除非当场改口。",
        score: 0.56,
        metadata: { category: "preference" },
      },
      {
        id: "food",
        memory: "用户喜欢吃芒果、凤梨和哈密瓜，其中芒果是心头好。",
        score: 0.53,
        metadata: { category: "preference" },
      },
    ]);

    const result = await recall(provider, "食物 喜欢 吃", "zhangjianyong", {
      recall: {
        summaryEnabled: true,
        dedupeEnabled: false,
        threshold: 0.5,
        relativeScoreThreshold: 0.5,
        finalMaxMemories: 1,
      },
    });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.id).toBe("food");
    expect(result.context).toContain("用户喜欢吃芒果、凤梨和哈密瓜，其中芒果是心头好。");
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

describe("getMemoryCategory", () => {
  it("normalizes plural category aliases", () => {
    const memory = {
      id: "1",
      memory: "User prefers short responses.",
      metadata: { category: "preferences" },
    } as unknown as MemoryItem;
    expect(getMemoryCategory(memory)).toBe("preference");
  });
});
