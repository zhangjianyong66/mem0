import type { Mem0Provider, MemoryItem, SearchOptions } from "../types.ts";
import { getCandidateFeedbackTuning } from "../dream-feedback.ts";
import {
  getEntityKey,
  getMemoryCategory,
  getTopicKey,
  normalizeMemoryText,
  overlapScore,
} from "./topic-match.ts";

export interface MemoryWritePlan {
  action: "add" | "update" | "noop";
  reason:
    | "no_match"
    | "same_topic_update"
    | "semantic_duplicate"
    | "ambiguous_candidates"
    | "immutable_target";
  text: string;
  candidateCount: number;
  target?: MemoryItem;
  feedbackApplied?: boolean;
  feedbackTopicHit?: boolean;
  dynamicThresholdDelta?: number;
}

interface WritePlanInput {
  provider: Mem0Provider;
  text: string;
  category?: string;
  metadata: Record<string, unknown>;
  searchOptions: SearchOptions;
  stateDir?: string;
}

interface CandidateScore {
  memory: MemoryItem;
  exactTopic: boolean;
  exactEntity: boolean;
  sameCategory: boolean;
  textOverlap: number;
  retrievalScore: number;
  confidence: number;
  feedbackApplied: boolean;
  feedbackTopicHit: boolean;
  dynamicThresholdDelta: number;
  duplicateDeleteBias: number;
  mergeFixupBias: number;
  rewriteFixupBias: number;
  consolidatedReplacementBias: number;
}

function makeIncomingMemory(
  text: string,
  category: string | undefined,
  metadata: Record<string, unknown>,
): MemoryItem {
  return {
    id: "incoming",
    memory: text,
    metadata: {
      ...metadata,
      ...(category && { category }),
    },
    categories: category ? [category] : [],
  };
}

function hasTemporalAnchor(text: string): boolean {
  return (
    /\bAs of \d{4}-\d{2}-\d{2}\b/i.test(text) ||
    /截至\s*\d{4}-\d{2}-\d{2}/.test(text)
  );
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasMeaningfulImprovement(current: string, incoming: string): boolean {
  const currentNorm = normalizeMemoryText(current);
  const incomingNorm = normalizeMemoryText(incoming);
  if (!currentNorm || !incomingNorm) return incomingNorm !== currentNorm;
  if (currentNorm === incomingNorm) return false;

  const currentTerms = new Set(currentNorm.split(" ").filter(Boolean));
  const incomingTerms = new Set(incomingNorm.split(" ").filter(Boolean));
  let newTerms = 0;
  for (const term of incomingTerms) {
    if (!currentTerms.has(term)) newTerms += 1;
  }

  if (newTerms >= 2) return true;
  if (hasTemporalAnchor(incoming) && !hasTemporalAnchor(current)) return true;
  if (incoming.length >= current.length + 16) return true;
  return false;
}

function mergeMemoryText(current: string, incoming: string): string {
  const currentTrimmed = current.trim();
  const incomingTrimmed = incoming.trim();
  const currentNorm = normalizeMemoryText(currentTrimmed);
  const incomingNorm = normalizeMemoryText(incomingTrimmed);

  if (!incomingNorm) return currentTrimmed;
  if (!currentNorm) return incomingTrimmed;
  if (currentNorm === incomingNorm) return currentTrimmed;
  if (currentNorm.includes(incomingNorm)) return currentTrimmed;
  if (incomingNorm.includes(currentNorm)) return incomingTrimmed;

  const preferIncoming =
    hasTemporalAnchor(incomingTrimmed) && !hasTemporalAnchor(currentTrimmed);
  if (!hasMeaningfulImprovement(currentTrimmed, incomingTrimmed)) {
    return currentTrimmed;
  }
  if (preferIncoming) return incomingTrimmed;
  if (incomingTrimmed.length > currentTrimmed.length) return incomingTrimmed;
  return `${currentTrimmed} ${incomingTrimmed}`.replace(/\s+/g, " ").trim();
}

function scoreCandidate(
  candidate: MemoryItem,
  incoming: MemoryItem,
  stateDir?: string,
): CandidateScore {
  const candidateTopic = getTopicKey(candidate);
  const incomingTopic = getTopicKey(incoming);
  const candidateEntity = getEntityKey(candidate);
  const incomingEntity = getEntityKey(incoming);
  const candidateCategory = getMemoryCategory(candidate);
  const incomingCategory = getMemoryCategory(incoming);
  const textOverlap = overlapScore(
    normalizeMemoryText(candidate.memory),
    normalizeMemoryText(incoming.memory),
  );
  const retrievalScore = candidate.score ?? 0;

  const exactTopic =
    Boolean(candidateTopic) &&
    Boolean(incomingTopic) &&
    candidateTopic === incomingTopic;
  const exactEntity =
    Boolean(candidateEntity) &&
    Boolean(incomingEntity) &&
    candidateEntity === incomingEntity;
  const sameCategory = candidateCategory === incomingCategory;

  let confidence = 0;
  if (exactTopic) confidence += 2;
  if (exactEntity) confidence += 1.5;
  if (sameCategory) confidence += 0.4;
  confidence += textOverlap;
  confidence += retrievalScore * 0.8;
  const tuning = getCandidateFeedbackTuning(stateDir, candidate);
  confidence += tuning.duplicateDeleteBias;
  confidence += tuning.mergeFixupBias;
  confidence += tuning.rewriteFixupBias * 0.5;
  confidence += tuning.consolidatedReplacementBias;

  return {
    memory: candidate,
    exactTopic,
    exactEntity,
    sameCategory,
    textOverlap,
    retrievalScore,
    confidence,
    ...tuning,
  };
}

function isHighConfidenceMatch(candidate: CandidateScore): boolean {
  if (candidate.exactTopic) return true;
  if (candidate.exactEntity && candidate.sameCategory) return true;
  return (
    candidate.sameCategory &&
    candidate.textOverlap >= 0.72 &&
    candidate.retrievalScore >= 0.82
  );
}

function isImmutable(memory: MemoryItem): boolean {
  return memory.metadata?.immutable === true;
}

export async function planMemoryWrite(
  input: WritePlanInput,
): Promise<MemoryWritePlan> {
  const incoming = makeIncomingMemory(input.text, input.category, input.metadata);
  const query = input.text.slice(0, 240);
  const candidates = await input.provider.search(query, input.searchOptions);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      action: "add",
      reason: "no_match",
      text: input.text,
      candidateCount: 0,
      feedbackApplied: false,
      feedbackTopicHit: false,
      dynamicThresholdDelta: 0,
    };
  }

  const scored = candidates
    .map((candidate) => scoreCandidate(candidate, incoming, input.stateDir))
    .sort((a, b) => b.confidence - a.confidence);
  const highConfidence = scored.filter(isHighConfidenceMatch);
  const best = highConfidence[0];

  if (!best) {
    return {
      action: "add",
      reason: "no_match",
      text: input.text,
      candidateCount: candidates.length,
      feedbackApplied: false,
      feedbackTopicHit: false,
      dynamicThresholdDelta: 0,
    };
  }

  if (highConfidence.length > 1) {
    const second = highConfidence[1];
    if (
      second &&
      Math.abs(best.confidence - second.confidence) < 0.35 &&
      (second.exactTopic || second.exactEntity || second.textOverlap >= 0.78)
    ) {
      return {
        action: "add",
        reason: "ambiguous_candidates",
        text: input.text,
        candidateCount: candidates.length,
        feedbackApplied: best.feedbackApplied,
        feedbackTopicHit: best.feedbackTopicHit,
        dynamicThresholdDelta: best.dynamicThresholdDelta,
      };
    }
  }

  if (isImmutable(best.memory)) {
    return {
      action: "add",
      reason: "immutable_target",
      text: input.text,
      candidateCount: candidates.length,
      target: best.memory,
      feedbackApplied: best.feedbackApplied,
      feedbackTopicHit: best.feedbackTopicHit,
      dynamicThresholdDelta: best.dynamicThresholdDelta,
    };
  }

  const mergedText = mergeMemoryText(best.memory.memory, input.text);
  const currentNorm = normalizeMemoryText(best.memory.memory);
  const mergedNorm = normalizeMemoryText(mergedText);
  const incomingNorm = normalizeMemoryText(input.text);

  const noopOverlapThreshold = Math.max(
    0.8,
    0.92 - best.duplicateDeleteBias * 0.4,
  );
  if (
    mergedNorm === currentNorm ||
    incomingNorm === currentNorm ||
    best.textOverlap >= noopOverlapThreshold ||
    (!hasMeaningfulImprovement(best.memory.memory, input.text) &&
      countWords(input.text) <= countWords(best.memory.memory))
  ) {
    return {
      action: "noop",
      reason: "semantic_duplicate",
      text: best.memory.memory,
      candidateCount: candidates.length,
      target: best.memory,
      feedbackApplied: best.feedbackApplied,
      feedbackTopicHit: best.feedbackTopicHit,
      dynamicThresholdDelta: best.dynamicThresholdDelta,
    };
  }

  return {
    action: "update",
    reason: "same_topic_update",
    text: mergedText,
    candidateCount: candidates.length,
    target: best.memory,
    feedbackApplied: best.feedbackApplied,
    feedbackTopicHit: best.feedbackTopicHit,
    dynamicThresholdDelta: best.dynamicThresholdDelta,
  };
}
