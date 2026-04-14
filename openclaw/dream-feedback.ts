import * as path from "node:path";
import { mkdirp, readText, writeText } from "./fs-safe.ts";
import type { MemoryItem } from "./types.ts";
import { getEntityKey, getTopicKey } from "./tools/topic-match.ts";

const MAX_RUNS = 50;
const MAX_TOPICS = 200;
const MAX_MEMORYS = 400;
const FEEDBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

type DreamActionType =
  | "rewrite_or_merge"
  | "delete"
  | "new_consolidated_memory";

export interface DreamWriteAction {
  tool: "memory_add" | "memory_update" | "memory_delete";
  type: DreamActionType;
  memoryId?: string;
  text?: string;
  topicKey?: string;
  entityKey?: string;
  category?: string;
}

export interface DreamFeedbackRun {
  id: string;
  timestamp: number;
  parsedWriteActions: number;
  feedbackTopicsCount: number;
  parseComplete: boolean;
  actions: DreamWriteAction[];
}

interface TopicOutcome {
  topicKey: string;
  mergeFixups: number;
  rewriteFixups: number;
  duplicateDeletes: number;
  consolidatedReplacements: number;
  lastUpdatedAt: number;
  lastDreamRunId: string;
}

interface MemoryOutcome {
  memoryId: string;
  mergeFixups: number;
  rewriteFixups: number;
  duplicateDeletes: number;
  consolidatedReplacements: number;
  lastUpdatedAt: number;
  lastDreamRunId: string;
}

interface DedupeTopicTuning {
  duplicateDeleteBias: number;
  mergeFixupBias: number;
  rewriteFixupBias: number;
  consolidatedReplacementBias: number;
  lastUpdatedAt: number;
}

export interface DreamFeedbackState {
  lastUpdatedAt: number;
  recentDreamRuns: DreamFeedbackRun[];
  topicOutcomes: Record<string, TopicOutcome>;
  writeOutcomeByMemoryId: Record<string, MemoryOutcome>;
  dedupeTuning: Record<string, DedupeTopicTuning>;
}

export interface CandidateFeedbackTuning {
  feedbackApplied: boolean;
  feedbackTopicHit: boolean;
  dynamicThresholdDelta: number;
  duplicateDeleteBias: number;
  mergeFixupBias: number;
  rewriteFixupBias: number;
  consolidatedReplacementBias: number;
}

function feedbackPath(stateDir: string): string {
  return path.join(stateDir, "dream-feedback.json");
}

function defaultState(): DreamFeedbackState {
  return {
    lastUpdatedAt: 0,
    recentDreamRuns: [],
    topicOutcomes: {},
    writeOutcomeByMemoryId: {},
    dedupeTuning: {},
  };
}

export function readDreamFeedbackState(stateDir?: string): DreamFeedbackState {
  if (!stateDir) return defaultState();
  try {
    return JSON.parse(readText(feedbackPath(stateDir))) as DreamFeedbackState;
  } catch {
    return defaultState();
  }
}

function writeDreamFeedbackState(
  stateDir: string,
  state: DreamFeedbackState,
): void {
  mkdirp(stateDir);
  writeText(feedbackPath(stateDir), JSON.stringify(state, null, 2));
}

function trimState(state: DreamFeedbackState, now: number): DreamFeedbackState {
  const minTimestamp = now - FEEDBACK_WINDOW_MS;
  state.recentDreamRuns = state.recentDreamRuns
    .filter((run) => run.timestamp >= minTimestamp)
    .slice(-MAX_RUNS);

  const topicEntries = Object.entries(state.topicOutcomes)
    .filter(([, value]) => value.lastUpdatedAt >= minTimestamp)
    .sort((a, b) => b[1].lastUpdatedAt - a[1].lastUpdatedAt)
    .slice(0, MAX_TOPICS);
  state.topicOutcomes = Object.fromEntries(topicEntries);

  const memoryEntries = Object.entries(state.writeOutcomeByMemoryId)
    .filter(([, value]) => value.lastUpdatedAt >= minTimestamp)
    .sort((a, b) => b[1].lastUpdatedAt - a[1].lastUpdatedAt)
    .slice(0, MAX_MEMORYS);
  state.writeOutcomeByMemoryId = Object.fromEntries(memoryEntries);

  const tuningEntries = Object.entries(state.dedupeTuning)
    .filter(([, value]) => value.lastUpdatedAt >= minTimestamp)
    .sort((a, b) => b[1].lastUpdatedAt - a[1].lastUpdatedAt)
    .slice(0, MAX_TOPICS);
  state.dedupeTuning = Object.fromEntries(tuningEntries);

  return state;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeTopicTuning(topic: TopicOutcome): DedupeTopicTuning {
  return {
    duplicateDeleteBias: clamp(topic.duplicateDeletes * 0.08, 0, 0.2),
    mergeFixupBias: clamp(topic.mergeFixups * 0.05, 0, 0.15),
    rewriteFixupBias: clamp(topic.rewriteFixups * 0.04, 0, 0.12),
    consolidatedReplacementBias: clamp(
      topic.consolidatedReplacements * 0.06,
      0,
      0.18,
    ),
    lastUpdatedAt: topic.lastUpdatedAt,
  };
}

function getTopicIdentity(action: DreamWriteAction): string | undefined {
  return action.topicKey || action.entityKey;
}

function updateTopicOutcome(
  state: DreamFeedbackState,
  action: DreamWriteAction,
  now: number,
  runId: string,
): void {
  const topicIdentity = getTopicIdentity(action);
  if (!topicIdentity) return;

  const existing = state.topicOutcomes[topicIdentity] ?? {
    topicKey: topicIdentity,
    mergeFixups: 0,
    rewriteFixups: 0,
    duplicateDeletes: 0,
    consolidatedReplacements: 0,
    lastUpdatedAt: now,
    lastDreamRunId: runId,
  };

  if (action.type === "rewrite_or_merge") existing.mergeFixups += 1;
  if (action.type === "delete") existing.duplicateDeletes += 1;
  if (action.type === "new_consolidated_memory") {
    existing.consolidatedReplacements += 1;
  }

  existing.lastUpdatedAt = now;
  existing.lastDreamRunId = runId;
  state.topicOutcomes[topicIdentity] = existing;
  state.dedupeTuning[topicIdentity] = computeTopicTuning(existing);
}

function updateMemoryOutcome(
  state: DreamFeedbackState,
  action: DreamWriteAction,
  now: number,
  runId: string,
): void {
  if (!action.memoryId) return;
  const existing = state.writeOutcomeByMemoryId[action.memoryId] ?? {
    memoryId: action.memoryId,
    mergeFixups: 0,
    rewriteFixups: 0,
    duplicateDeletes: 0,
    consolidatedReplacements: 0,
    lastUpdatedAt: now,
    lastDreamRunId: runId,
  };

  if (action.type === "rewrite_or_merge") existing.mergeFixups += 1;
  if (action.type === "delete") existing.duplicateDeletes += 1;
  if (action.type === "new_consolidated_memory") {
    existing.consolidatedReplacements += 1;
  }
  existing.lastUpdatedAt = now;
  existing.lastDreamRunId = runId;
  state.writeOutcomeByMemoryId[action.memoryId] = existing;
}

function parseToolInput(block: any): Record<string, unknown> {
  const input = block?.input ?? block?.arguments ?? {};
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (input && typeof input === "object") return input;
  return {};
}

function normalizeFacts(input: Record<string, unknown>): string[] {
  const facts = Array.isArray(input.facts)
    ? input.facts.filter((v): v is string => typeof v === "string")
    : [];
  if (facts.length > 0) return facts;
  if (typeof input.text === "string" && input.text.trim()) return [input.text];
  return [];
}

function actionFromMemory(memory: MemoryItem | undefined): {
  topicKey?: string;
  entityKey?: string;
  category?: string;
} {
  return {
    topicKey: memory ? getTopicKey(memory) : undefined,
    entityKey: memory ? getEntityKey(memory) : undefined,
    category:
      typeof memory?.metadata?.category === "string"
        ? memory.metadata.category
        : memory?.categories?.[0],
  };
}

export function extractDreamWriteActionsFromAssistant(
  assistantMessage: any,
): { actions: DreamWriteAction[]; parseComplete: boolean } {
  const content = assistantMessage?.content;
  if (!Array.isArray(content)) return { actions: [], parseComplete: false };

  const actions: DreamWriteAction[] = [];
  let parseComplete = true;

  for (const block of content) {
    if (block?.type !== "tool_use") continue;
    const input = parseToolInput(block);

    if (block.name === "memory_update") {
      if (typeof input.memoryId === "string" && typeof input.text === "string") {
        actions.push({
          tool: "memory_update",
          type: "rewrite_or_merge",
          memoryId: input.memoryId,
          text: input.text,
        });
      } else {
        parseComplete = false;
      }
      continue;
    }

    if (block.name === "memory_delete") {
      if (typeof input.memoryId === "string") {
        actions.push({
          tool: "memory_delete",
          type: "delete",
          memoryId: input.memoryId,
        });
      } else {
        parseComplete = false;
      }
      continue;
    }

    if (block.name === "memory_add") {
      const facts = normalizeFacts(input);
      const metadata =
        input.metadata && typeof input.metadata === "object"
          ? (input.metadata as Record<string, unknown>)
          : {};
      if (facts.length > 0) {
        actions.push({
          tool: "memory_add",
          type: "new_consolidated_memory",
          text: facts.join(" "),
          topicKey:
            typeof metadata.topicKey === "string" ? metadata.topicKey : undefined,
          entityKey:
            typeof metadata.entityKey === "string"
              ? metadata.entityKey
              : undefined,
          category:
            typeof input.category === "string" ? input.category : undefined,
        });
      } else {
        parseComplete = false;
      }
    }
  }

  return { actions, parseComplete };
}

export function recordDreamFeedback(
  stateDir: string,
  run: DreamFeedbackRun,
  knownMemoriesById: Record<string, MemoryItem> = {},
): DreamFeedbackState {
  const now = run.timestamp;
  const state = readDreamFeedbackState(stateDir);

  for (const action of run.actions) {
    if ((!action.topicKey || !action.entityKey) && action.memoryId) {
      const known = knownMemoriesById[action.memoryId];
      const inferred = actionFromMemory(known);
      action.topicKey = action.topicKey ?? inferred.topicKey;
      action.entityKey = action.entityKey ?? inferred.entityKey;
      action.category = action.category ?? inferred.category;
    }
    updateTopicOutcome(state, action, now, run.id);
    updateMemoryOutcome(state, action, now, run.id);
  }

  state.lastUpdatedAt = now;
  state.recentDreamRuns.push(run);
  trimState(state, now);
  writeDreamFeedbackState(stateDir, state);
  return state;
}

export function buildDreamFeedbackRun(
  assistantMessage: any,
  now = Date.now(),
): DreamFeedbackRun {
  const extracted = extractDreamWriteActionsFromAssistant(assistantMessage);
  const topics = new Set(
    extracted.actions
      .map((action) => getTopicIdentity(action))
      .filter((value): value is string => Boolean(value)),
  );

  return {
    id: `dream-${now}`,
    timestamp: now,
    parsedWriteActions: extracted.actions.length,
    feedbackTopicsCount: topics.size,
    parseComplete: extracted.parseComplete,
    actions: extracted.actions,
  };
}

function decayBias(value: number, ageMs: number): number {
  if (ageMs <= 0) return value;
  const factor = clamp(1 - ageMs / FEEDBACK_WINDOW_MS, 0, 1);
  return value * factor;
}

export function getCandidateFeedbackTuning(
  stateDir: string | undefined,
  candidate: MemoryItem,
): CandidateFeedbackTuning {
  const state = readDreamFeedbackState(stateDir);
  const now = Date.now();
  const topicKey = getTopicKey(candidate);
  const entityKey = getEntityKey(candidate);
  const topicTuning =
    (topicKey && state.dedupeTuning[topicKey]) ||
    (entityKey && state.dedupeTuning[entityKey]);
  const memoryOutcome =
    candidate.id ? state.writeOutcomeByMemoryId[candidate.id] : undefined;

  const topicAge = topicTuning ? now - topicTuning.lastUpdatedAt : FEEDBACK_WINDOW_MS;
  const memoryAge = memoryOutcome
    ? now - memoryOutcome.lastUpdatedAt
    : FEEDBACK_WINDOW_MS;

  const duplicateDeleteBias = clamp(
    decayBias(topicTuning?.duplicateDeleteBias ?? 0, topicAge) +
      decayBias((memoryOutcome?.duplicateDeletes ?? 0) * 0.05, memoryAge),
    0,
    0.25,
  );
  const mergeFixupBias = clamp(
    decayBias(topicTuning?.mergeFixupBias ?? 0, topicAge) +
      decayBias((memoryOutcome?.mergeFixups ?? 0) * 0.04, memoryAge),
    0,
    0.18,
  );
  const rewriteFixupBias = clamp(
    decayBias(topicTuning?.rewriteFixupBias ?? 0, topicAge) +
      decayBias((memoryOutcome?.rewriteFixups ?? 0) * 0.03, memoryAge),
    0,
    0.14,
  );
  const consolidatedReplacementBias = clamp(
    decayBias(topicTuning?.consolidatedReplacementBias ?? 0, topicAge) +
      decayBias((memoryOutcome?.consolidatedReplacements ?? 0) * 0.04, memoryAge),
    0,
    0.2,
  );

  const dynamicThresholdDelta = clamp(
    duplicateDeleteBias + mergeFixupBias + rewriteFixupBias + consolidatedReplacementBias,
    0,
    0.35,
  );

  return {
    feedbackApplied: dynamicThresholdDelta > 0,
    feedbackTopicHit: Boolean(topicTuning),
    dynamicThresholdDelta,
    duplicateDeleteBias,
    mergeFixupBias,
    rewriteFixupBias,
    consolidatedReplacementBias,
  };
}
