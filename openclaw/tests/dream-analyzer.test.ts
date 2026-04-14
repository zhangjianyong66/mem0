import { describe, expect, it } from "vitest";
import {
  analyzeMemoryInventory,
  formatDreamGroups,
  formatDreamSummary,
} from "../dream-analyzer.ts";
import type { DreamFeedbackState } from "../dream-feedback.ts";
import type { MemoryItem } from "../types.ts";

describe("dream-analyzer", () => {
  it("groups related memories and flags merge/rewrite/stale/delete candidates", () => {
    const memories: MemoryItem[] = [
      {
        id: "m1",
        memory: "As of 2026-01-01, User uses Claude Code for local coding tasks.",
        metadata: {
          category: "tooling",
          topicKey: "tooling:claude-code",
          sourceKind: "fact",
          temporalScope: "ongoing",
        },
        categories: ["tooling"],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "m2",
        memory: "I use Claude Code for local coding tasks.",
        metadata: {
          category: "tooling",
          topicKey: "tooling:claude-code",
          sourceKind: "fact",
          temporalScope: "ongoing",
        },
        categories: ["tooling"],
        created_at: "2026-02-01T00:00:00.000Z",
        updated_at: "2026-02-01T00:00:00.000Z",
      },
      {
        id: "m3",
        memory: "password=super-secret",
        metadata: {
          category: "operational",
          sourceKind: "log",
          temporalScope: "historical",
        },
        categories: ["operational"],
        created_at: "2026-01-15T00:00:00.000Z",
        updated_at: "2026-01-15T00:00:00.000Z",
      },
      {
        id: "m4",
        memory: "Service heartbeat completed successfully.",
        metadata: {
          category: "operational",
          sourceKind: "log",
          temporalScope: "historical",
        },
        categories: ["operational"],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "m5",
        memory: "User is migrating the gateway to the new host.",
        metadata: {
          category: "project",
          sourceKind: "fact",
          temporalScope: "ongoing",
        },
        categories: ["project"],
        created_at: "2025-12-01T00:00:00.000Z",
        updated_at: "2025-12-01T00:00:00.000Z",
      },
    ];

    const analysis = analyzeMemoryInventory(
      memories,
      new Date("2026-04-13T00:00:00.000Z"),
    );

    expect(analysis.totalCount).toBe(5);
    expect(analysis.groupCount).toBe(4);
    expect(analysis.mergeCandidateGroups).toBe(1);
    expect(analysis.deleteCandidateCount).toBe(1);
    expect(analysis.rewriteCandidateCount).toBe(4);
    expect(analysis.staleCandidateCount).toBe(5);

    const grouped = analysis.groups.find((group) => group.groupKey === "tooling:claude-code");
    expect(grouped).toBeDefined();
    expect(grouped?.count).toBe(2);
    expect(grouped?.candidateActions).toEqual(
      expect.arrayContaining(["merge", "rewrite", "stale"]),
    );
  });

  it("formats summary and grouped inventory for dream prompts", () => {
    const analysis = analyzeMemoryInventory(
      [
        {
          id: "m1",
          memory: "As of 2026-03-01, User prefers zsh.",
          metadata: {
            category: "preference",
            topicKey: "pref:shell",
            sourceKind: "fact",
            temporalScope: "current",
          },
          categories: ["preference"],
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-01T00:00:00.000Z",
        },
      ] as MemoryItem[],
      new Date("2026-04-13T00:00:00.000Z"),
    );

    const summary = formatDreamSummary(analysis);
    const groups = formatDreamGroups(analysis);

    expect(summary).toContain('<dream-summary total="1" groups="1">');
    expect(summary).toContain("merge_candidate_groups=0");
    expect(summary).toContain("feedback_priority_groups=0");
    expect(groups).toContain('<memory-groups total="1">');
    expect(groups).toContain('key="pref:shell"');
    expect(groups).toContain("- [m1] As of 2026-03-01, User prefers zsh.");
  });

  it("prioritizes groups with delete and merge feedback over static count alone", () => {
    const memories: MemoryItem[] = [
      {
        id: "m1",
        memory: "As of 2026-04-10, user is migrating the gateway to the new host.",
        metadata: {
          category: "project",
          topicKey: "project:gateway",
          entityKey: "project:gateway",
          sourceKind: "fact",
          temporalScope: "ongoing",
        },
        categories: ["project"],
        created_at: "2026-04-10T00:00:00.000Z",
        updated_at: "2026-04-10T00:00:00.000Z",
      },
      {
        id: "m2",
        memory: "As of 2026-04-11, user is migrating the gateway to the new host and validating nginx.",
        metadata: {
          category: "project",
          topicKey: "project:gateway",
          entityKey: "project:gateway",
          sourceKind: "fact",
          temporalScope: "ongoing",
        },
        categories: ["project"],
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
      },
      {
        id: "m3",
        memory: "User prefers zsh.",
        metadata: {
          category: "preference",
          topicKey: "pref:shell",
          entityKey: "pref:shell",
          sourceKind: "fact",
          temporalScope: "stable",
        },
        categories: ["preference"],
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
      },
      {
        id: "m4",
        memory: "As of 2026-04-12, user changed shell aliases.",
        metadata: {
          category: "configuration",
          topicKey: "config:shell-aliases",
          entityKey: "config:shell-aliases",
          sourceKind: "config",
          temporalScope: "ongoing",
        },
        categories: ["configuration"],
        created_at: "2026-04-12T00:00:00.000Z",
        updated_at: "2026-04-12T00:00:00.000Z",
      },
    ];

    const feedbackState: DreamFeedbackState = {
      lastUpdatedAt: 1713000000000,
      recentDreamRuns: [],
      topicOutcomes: {
        "project:gateway": {
          topicKey: "project:gateway",
          mergeFixups: 2,
          rewriteFixups: 4,
          duplicateDeletes: 1,
          consolidatedReplacements: 1,
          lastUpdatedAt: 1713000000000,
          lastDreamRunId: "dream-1",
        },
      },
      writeOutcomeByMemoryId: {},
      dedupeTuning: {},
    };

    const analysis = analyzeMemoryInventory(
      memories,
      new Date("2026-04-13T00:00:00.000Z"),
      feedbackState,
    );

    expect(analysis.feedbackPriorityGroupCount).toBe(1);
    expect(analysis.feedbackBoostedMergeGroups).toBe(1);
    expect(analysis.feedbackBoostedDeleteGroups).toBe(0);
    expect(analysis.groups[0]?.groupKey).toBe("project:gateway");
    expect(analysis.groups[0]?.feedbackPriority).toBe(12);
    expect(analysis.groups[0]?.feedbackSignals.duplicateDeletes).toBe(1);
  });

  it("upgrades merge for single-memory groups with repeated merge feedback", () => {
    const feedbackState: DreamFeedbackState = {
      lastUpdatedAt: 1713000000000,
      recentDreamRuns: [],
      topicOutcomes: {
        "project:gateway": {
          topicKey: "project:gateway",
          mergeFixups: 1,
          rewriteFixups: 0,
          duplicateDeletes: 0,
          consolidatedReplacements: 1,
          lastUpdatedAt: 1713000000000,
          lastDreamRunId: "dream-1",
        },
      },
      writeOutcomeByMemoryId: {},
      dedupeTuning: {},
    };

    const analysis = analyzeMemoryInventory(
      [
        {
          id: "m1",
          memory: "As of 2026-04-14, user is migrating the gateway to the new host.",
          metadata: {
            category: "project",
            topicKey: "project:gateway",
            entityKey: "project:gateway",
            temporalScope: "ongoing",
          },
          categories: ["project"],
          created_at: "2026-04-14T00:00:00.000Z",
          updated_at: "2026-04-14T00:00:00.000Z",
        },
      ],
      new Date("2026-04-14T00:00:00.000Z"),
      feedbackState,
    );

    expect(analysis.feedbackUpgradedMergeGroups).toBe(1);
    expect(analysis.feedbackUpgradedDeleteGroups).toBe(0);
    expect(analysis.feedbackBoostedMergeGroups).toBe(0);
    expect(analysis.groups[0]?.candidateActions).toContain("merge");
    expect(analysis.groups[0]?.actionSources.merge).toBe("feedback");
  });

  it("upgrades delete for repeated duplicate-delete feedback only when a group is duplicate-like", () => {
    const feedbackState: DreamFeedbackState = {
      lastUpdatedAt: 1713000000000,
      recentDreamRuns: [],
      topicOutcomes: {
        "project:gateway": {
          topicKey: "project:gateway",
          mergeFixups: 0,
          rewriteFixups: 5,
          duplicateDeletes: 2,
          consolidatedReplacements: 0,
          lastUpdatedAt: 1713000000000,
          lastDreamRunId: "dream-1",
        },
      },
      writeOutcomeByMemoryId: {},
      dedupeTuning: {},
    };

    const analysis = analyzeMemoryInventory(
      [
        {
          id: "m1",
          memory: "As of 2026-04-10, user is migrating the gateway to the new host.",
          metadata: {
            category: "project",
            topicKey: "project:gateway",
            entityKey: "project:gateway",
            temporalScope: "ongoing",
          },
          categories: ["project"],
          created_at: "2026-04-10T00:00:00.000Z",
          updated_at: "2026-04-10T00:00:00.000Z",
        },
        {
          id: "m2",
          memory: "As of 2026-04-10, user is migrating the gateway to the new host.",
          metadata: {
            category: "project",
            topicKey: "project:gateway",
            entityKey: "project:gateway",
            temporalScope: "ongoing",
          },
          categories: ["project"],
          created_at: "2026-04-11T00:00:00.000Z",
          updated_at: "2026-04-11T00:00:00.000Z",
        },
      ],
      new Date("2026-04-14T00:00:00.000Z"),
      feedbackState,
    );

    expect(analysis.feedbackUpgradedDeleteGroups).toBe(1);
    expect(analysis.groups[0]?.candidateActions).toEqual(
      expect.arrayContaining(["merge", "delete"]),
    );
    expect(analysis.groups[0]?.actionSources.delete).toBe("feedback");
  });

  it("does not upgrade merge or delete from rewrite feedback alone", () => {
    const feedbackState: DreamFeedbackState = {
      lastUpdatedAt: 1713000000000,
      recentDreamRuns: [],
      topicOutcomes: {
        "pref:shell": {
          topicKey: "pref:shell",
          mergeFixups: 0,
          rewriteFixups: 8,
          duplicateDeletes: 0,
          consolidatedReplacements: 0,
          lastUpdatedAt: 1713000000000,
          lastDreamRunId: "dream-1",
        },
      },
      writeOutcomeByMemoryId: {},
      dedupeTuning: {},
    };

    const analysis = analyzeMemoryInventory(
      [
        {
          id: "m1",
          memory: "User prefers zsh.",
          metadata: {
            category: "preference",
            topicKey: "pref:shell",
            entityKey: "pref:shell",
            temporalScope: "stable",
          },
          categories: ["preference"],
          created_at: "2026-04-10T00:00:00.000Z",
          updated_at: "2026-04-10T00:00:00.000Z",
        },
      ],
      new Date("2026-04-14T00:00:00.000Z"),
      feedbackState,
    );

    expect(analysis.feedbackUpgradedMergeGroups).toBe(0);
    expect(analysis.feedbackUpgradedDeleteGroups).toBe(0);
    expect(analysis.groups[0]?.candidateActions).not.toContain("merge");
    expect(analysis.groups[0]?.candidateActions).not.toContain("delete");
  });
});
