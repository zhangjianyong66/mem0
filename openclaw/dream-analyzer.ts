import { createHash } from "node:crypto";
import type { DreamFeedbackState } from "./dream-feedback.ts";
import type { MemoryItem } from "./types.ts";
import {
  getMemoryCategory,
  getTopicKey,
  getEntityKey,
  normalizeMemoryText,
} from "./tools/topic-match.ts";

const TEMPORAL_CATEGORIES = new Set([
  "project",
  "configuration",
  "decision",
  "operational",
]);

const DELETE_PATTERNS = [
  /sk-/i,
  /m0-/i,
  /ghp_/i,
  /AKIA/,
  /Bearer /i,
  /password=/i,
  /token=/i,
  /secret=/i,
  /^Current time:/i,
  /HEARTBEAT_OK/i,
  /NO_REPLY/i,
  /tool output/i,
];

const NOISE_PATTERNS = [
  /^(ok|okay|sure|got it|thanks|done)$/i,
  /^System:/i,
];

const FIRST_PERSON_PATTERNS = [
  /\bI\b/,
  /\bmy\b/i,
  /\bme\b/i,
  /我(喜欢|偏好|正在|决定|配置)/,
];

function getSourceKind(memory: MemoryItem): string {
  if (
    memory.metadata?.sourceKind &&
    typeof memory.metadata.sourceKind === "string"
  ) {
    return memory.metadata.sourceKind;
  }
  return getMemoryCategory(memory);
}

function getTemporalScope(memory: MemoryItem): string {
  if (
    memory.metadata?.temporalScope &&
    typeof memory.metadata.temporalScope === "string"
  ) {
    return memory.metadata.temporalScope;
  }
  return "historical";
}

function stableHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 10);
}

function hasTemporalAnchor(memory: MemoryItem): boolean {
  return (
    /\bAs of \d{4}-\d{2}-\d{2}\b/i.test(memory.memory) ||
    /截至\s*\d{4}-\d{2}-\d{2}/.test(memory.memory)
  );
}

function isDeleteCandidate(memory: MemoryItem): boolean {
  return (
    DELETE_PATTERNS.some((pattern) => pattern.test(memory.memory)) ||
    NOISE_PATTERNS.some((pattern) => pattern.test(memory.memory.trim()))
  );
}

function isRewriteCandidate(memory: MemoryItem): boolean {
  const category = getMemoryCategory(memory);
  const wordCount = memory.memory.trim().split(/\s+/).length;
  return (
    (TEMPORAL_CATEGORIES.has(category) && !hasTemporalAnchor(memory)) ||
    FIRST_PERSON_PATTERNS.some((pattern) => pattern.test(memory.memory)) ||
    wordCount > 50
  );
}

function isStaleCandidate(memory: MemoryItem, now: Date): boolean {
  const category = getMemoryCategory(memory);
  const temporalScope = getTemporalScope(memory);
  const timestamp = memory.updated_at ?? memory.created_at;
  if (!timestamp) return false;
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return false;
  const daysOld = (now.getTime() - then.getTime()) / 86_400_000;
  if (category === "operational") return daysOld > 7;
  if (category === "project") return daysOld > 90;
  if (temporalScope === "ongoing") return daysOld > 30;
  return false;
}

export interface DreamGroup {
  groupKey: string;
  category: string;
  sourceKind: string;
  temporalScope: string;
  count: number;
  oldest: string;
  newest: string;
  candidateActions: string[];
  representativeMemories: MemoryItem[];
  feedbackPriority: number;
  feedbackSignals: {
    duplicateDeletes: number;
    mergeFixups: number;
    consolidatedReplacements: number;
  };
  actionSources: Partial<Record<"merge" | "delete", "static" | "feedback" | "both">>;
}

export interface DreamAnalysis {
  totalCount: number;
  categoryCounts: Record<string, number>;
  groupCount: number;
  mergeCandidateGroups: number;
  rewriteCandidateCount: number;
  deleteCandidateCount: number;
  staleCandidateCount: number;
  feedbackPriorityGroupCount: number;
  feedbackBoostedMergeGroups: number;
  feedbackBoostedDeleteGroups: number;
  feedbackUpgradedMergeGroups: number;
  feedbackUpgradedDeleteGroups: number;
  groups: DreamGroup[];
}

function getStaticSeverity(candidateActions: string[]): number {
  if (candidateActions.includes("delete")) return 4;
  if (candidateActions.includes("merge")) return 3;
  if (candidateActions.includes("stale")) return 2;
  if (candidateActions.includes("rewrite")) return 1;
  return 0;
}

function getFeedbackSignals(
  feedbackState: DreamFeedbackState | undefined,
  groupKey: string,
): DreamGroup["feedbackSignals"] {
  const outcome = feedbackState?.topicOutcomes[groupKey];
  return {
    duplicateDeletes: outcome?.duplicateDeletes ?? 0,
    mergeFixups: outcome?.mergeFixups ?? 0,
    consolidatedReplacements: outcome?.consolidatedReplacements ?? 0,
  };
}

function getFeedbackPriority(signals: DreamGroup["feedbackSignals"]): number {
  return (
    signals.duplicateDeletes * 4 +
    signals.mergeFixups * 3 +
    signals.consolidatedReplacements * 2
  );
}

function hasDuplicateLikeContent(members: MemoryItem[]): boolean {
  if (members.length < 2) return false;
  const normalized = members.map((member) => normalizeMemoryText(member.memory));
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (!normalized[i] || !normalized[j]) continue;
      if (
        normalized[i] === normalized[j] ||
        normalized[i].includes(normalized[j]) ||
        normalized[j].includes(normalized[i])
      ) {
        return true;
      }
    }
  }
  return false;
}

function buildGroupKey(memory: MemoryItem): string {
  const topicKey = getTopicKey(memory);
  if (topicKey) return topicKey;
  const entityKey = getEntityKey(memory);
  if (entityKey) return entityKey;
  const category = getMemoryCategory(memory);
  return `${category}:${stableHash(normalizeMemoryText(memory.memory))}`;
}

export function analyzeMemoryInventory(
  memories: MemoryItem[],
  now = new Date(),
  feedbackState?: DreamFeedbackState,
): DreamAnalysis {
  const categoryCounts: Record<string, number> = {};
  const grouped = new Map<string, MemoryItem[]>();

  for (const memory of memories) {
    const category = getMemoryCategory(memory);
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    const groupKey = buildGroupKey(memory);
    const existing = grouped.get(groupKey) ?? [];
    existing.push(memory);
    grouped.set(groupKey, existing);
  }

  const groups: DreamGroup[] = [];
  let mergeCandidateGroups = 0;
  let rewriteCandidateCount = 0;
  let deleteCandidateCount = 0;
  let staleCandidateCount = 0;
  let feedbackPriorityGroupCount = 0;
  let feedbackBoostedMergeGroups = 0;
  let feedbackBoostedDeleteGroups = 0;
  let feedbackUpgradedMergeGroups = 0;
  let feedbackUpgradedDeleteGroups = 0;

  for (const [groupKey, members] of grouped.entries()) {
    const sorted = [...members].sort((a, b) =>
      (a.created_at ?? "").localeCompare(b.created_at ?? ""),
    );
    const category = getMemoryCategory(sorted[0]);
    const sourceKind = getSourceKind(sorted[0]);
    const temporalScope = getTemporalScope(sorted[0]);
    const candidateActions = new Set<string>();
    const actionSources: DreamGroup["actionSources"] = {};

    if (sorted.length >= 2) {
      candidateActions.add("merge");
      mergeCandidateGroups += 1;
      actionSources.merge = "static";
    }

    for (const member of sorted) {
      if (isDeleteCandidate(member)) {
        candidateActions.add("delete");
        deleteCandidateCount += 1;
        actionSources.delete = "static";
      }
      if (isRewriteCandidate(member)) {
        candidateActions.add("rewrite");
        rewriteCandidateCount += 1;
      }
      if (isStaleCandidate(member, now)) {
        candidateActions.add("stale");
        staleCandidateCount += 1;
      }
    }

    const feedbackSignals = getFeedbackSignals(feedbackState, groupKey);
    const feedbackPriority = getFeedbackPriority(feedbackSignals);
    const canUpgradeMerge =
      !candidateActions.has("merge") &&
      feedbackSignals.mergeFixups + feedbackSignals.consolidatedReplacements >= 2;
    if (canUpgradeMerge) {
      candidateActions.add("merge");
      mergeCandidateGroups += 1;
      feedbackUpgradedMergeGroups += 1;
      actionSources.merge = "feedback";
    } else if (candidateActions.has("merge") && feedbackPriority > 0) {
      feedbackBoostedMergeGroups += 1;
      actionSources.merge = "both";
    }

    const canUpgradeDelete =
      !candidateActions.has("delete") &&
      feedbackSignals.duplicateDeletes >= 2 &&
      (sorted.length >= 2 ||
        hasDuplicateLikeContent(sorted) ||
        candidateActions.has("merge"));
    if (canUpgradeDelete) {
      candidateActions.add("delete");
      deleteCandidateCount += 1;
      feedbackUpgradedDeleteGroups += 1;
      actionSources.delete = "feedback";
    } else if (candidateActions.has("delete") && feedbackPriority > 0) {
      feedbackBoostedDeleteGroups += 1;
      actionSources.delete = actionSources.delete === "static" ? "both" : "feedback";
    }

    if (feedbackPriority > 0) {
      feedbackPriorityGroupCount += 1;
    }

    groups.push({
      groupKey,
      category,
      sourceKind,
      temporalScope,
      count: sorted.length,
      oldest: sorted[0]?.created_at ?? "unknown",
      newest: sorted[sorted.length - 1]?.updated_at ??
        sorted[sorted.length - 1]?.created_at ??
        "unknown",
      candidateActions: [...candidateActions],
      representativeMemories: sorted.slice(0, 3),
      feedbackPriority,
      feedbackSignals,
      actionSources,
    });
  }

  groups.sort((a, b) => {
    if (b.feedbackPriority !== a.feedbackPriority) {
      return b.feedbackPriority - a.feedbackPriority;
    }
    const severityDelta =
      getStaticSeverity(b.candidateActions) - getStaticSeverity(a.candidateActions);
    if (severityDelta !== 0) return severityDelta;
    if (b.count !== a.count) return b.count - a.count;
    if (b.newest !== a.newest) return b.newest.localeCompare(a.newest);
    return a.groupKey.localeCompare(b.groupKey);
  });

  return {
    totalCount: memories.length,
    categoryCounts,
    groupCount: groups.length,
    mergeCandidateGroups,
    rewriteCandidateCount,
    deleteCandidateCount,
    staleCandidateCount,
    feedbackPriorityGroupCount,
    feedbackBoostedMergeGroups,
    feedbackBoostedDeleteGroups,
    feedbackUpgradedMergeGroups,
    feedbackUpgradedDeleteGroups,
    groups,
  };
}

export function formatDreamSummary(analysis: DreamAnalysis): string {
  const lines = [
    `<dream-summary total="${analysis.totalCount}" groups="${analysis.groupCount}">`,
    `merge_candidate_groups=${analysis.mergeCandidateGroups}`,
    `rewrite_candidates=${analysis.rewriteCandidateCount}`,
    `delete_candidates=${analysis.deleteCandidateCount}`,
    `stale_candidates=${analysis.staleCandidateCount}`,
    `feedback_priority_groups=${analysis.feedbackPriorityGroupCount}`,
    `feedback_boosted_merge_groups=${analysis.feedbackBoostedMergeGroups}`,
    `feedback_boosted_delete_groups=${analysis.feedbackBoostedDeleteGroups}`,
    `feedback_upgraded_merge_groups=${analysis.feedbackUpgradedMergeGroups}`,
    `feedback_upgraded_delete_groups=${analysis.feedbackUpgradedDeleteGroups}`,
    `</dream-summary>`,
  ];
  return lines.join("\n");
}

export function formatDreamGroups(analysis: DreamAnalysis): string {
  const lines = [`<memory-groups total="${analysis.groupCount}">`];
  for (const group of analysis.groups) {
    lines.push(
      `<group key="${group.groupKey}" category="${group.category}" sourceKind="${group.sourceKind}" temporalScope="${group.temporalScope}" count="${group.count}" oldest="${group.oldest}" newest="${group.newest}" actions="${group.candidateActions.join(",") || "none"}">`,
    );
    for (const memory of group.representativeMemories) {
      lines.push(`- [${memory.id}] ${memory.memory}`);
    }
    lines.push(`</group>`);
  }
  lines.push(`</memory-groups>`);
  return lines.join("\n");
}
