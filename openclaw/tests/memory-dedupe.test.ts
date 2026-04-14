import { describe, expect, it, vi } from "vitest";
import type { Mem0Provider, MemoryItem } from "../types.ts";
import { planMemoryWrite } from "../tools/memory-dedupe.ts";

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

describe("planMemoryWrite", () => {
  it("returns update for a single same-topic high-confidence candidate", async () => {
    const provider = makeProvider([
      {
        id: "m1",
        memory: "As of 2026-04-01, user migrated alerts from Slack to Feishu.",
        score: 0.94,
        metadata: {
          category: "decision",
          topicKey: "decision:alerts-channel",
          entityKey: "project:alerts-channel",
        },
      },
    ]);

    const plan = await planMemoryWrite({
      provider,
      text: "As of 2026-04-13, user migrated alerts from Slack to Feishu and is validating webhook retries.",
      category: "decision",
      metadata: {
        category: "decision",
        topicKey: "decision:alerts-channel",
        entityKey: "project:alerts-channel",
      },
      searchOptions: {
        user_id: "u1",
        top_k: 5,
        threshold: 0.55,
        filter_memories: true,
        source: "OPENCLAW",
      },
    });

    expect(plan.action).toBe("update");
    expect(plan.reason).toBe("same_topic_update");
    expect(plan.target?.id).toBe("m1");
    expect(plan.text).toContain("webhook retries");
  });

  it("returns noop for semantic duplicates", async () => {
    const provider = makeProvider([
      {
        id: "m2",
        memory: "User prefers concise code-first answers.",
        score: 0.96,
        metadata: {
          category: "preference",
          topicKey: "preference:code-first",
        },
      },
    ]);

    const plan = await planMemoryWrite({
      provider,
      text: "User prefers concise code-first answers.",
      category: "preference",
      metadata: {
        category: "preference",
        topicKey: "preference:code-first",
      },
      searchOptions: {
        user_id: "u1",
        top_k: 5,
        threshold: 0.55,
        filter_memories: true,
        source: "OPENCLAW",
      },
    });

    expect(plan.action).toBe("noop");
    expect(plan.reason).toBe("semantic_duplicate");
    expect(plan.target?.id).toBe("m2");
  });

  it("returns add when multiple strong candidates are ambiguous", async () => {
    const provider = makeProvider([
      {
        id: "m3",
        memory: "As of 2026-04-10, user is migrating the gateway to a new host.",
        score: 0.93,
        metadata: {
          category: "project",
          topicKey: "project:gateway-migration",
          entityKey: "project:gateway",
        },
      },
      {
        id: "m4",
        memory: "As of 2026-04-11, user is migrating the gateway to a new host and validating nginx.",
        score: 0.92,
        metadata: {
          category: "project",
          topicKey: "project:gateway-migration",
          entityKey: "project:gateway",
        },
      },
    ]);

    const plan = await planMemoryWrite({
      provider,
      text: "As of 2026-04-13, user is migrating the gateway to a new host and plans cutover tonight.",
      category: "project",
      metadata: {
        category: "project",
        topicKey: "project:gateway-migration",
        entityKey: "project:gateway",
      },
      searchOptions: {
        user_id: "u1",
        top_k: 5,
        threshold: 0.55,
        filter_memories: true,
        source: "OPENCLAW",
      },
    });

    expect(plan.action).toBe("add");
    expect(plan.reason).toBe("ambiguous_candidates");
  });
});
