/**
 * Recall gating + compressed memory injection.
 *
 * This replaces naive "search every turn and dump ranked results" with:
 * 1. Query sanitization
 * 2. Recall gating for short continuations / current-task requests
 * 3. Search with stricter thresholds
 * 4. Topic-aware deduplication
 * 5. Structured summary formatting for injection
 */

import type {
  Mem0Provider,
  MemoryItem,
  SkillsConfig,
  SearchOptions,
} from "./types.ts";
import {
  chooseBetterMemory,
  getMemoryCategory,
  isSameTopic,
} from "./tools/topic-match.ts";

const DEFAULT_TOKEN_BUDGET = 400;
const DEFAULT_RAW_TOP_K = 8;
const DEFAULT_FINAL_MAX_MEMORIES = 4;
const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_RELATIVE_SCORE_THRESHOLD = 0.72;
const DEFAULT_SHORT_QUERY_CHARS = 12;
const DEFAULT_CATEGORY_ORDER = [
  "rule",
  "configuration",
  "decision",
  "preference",
  "project",
  "technical",
  "relationship",
  "operational",
  "identity",
];

const DEFAULT_CONTINUATION_PATTERNS = [
  "继续",
  "展开",
  "展开说说",
  "详细说说",
  "然后呢",
  "接着",
  "接着说",
  "为什么",
  "还有呢",
  "嗯",
  "好",
  "行",
];

const DEFAULT_HISTORY_PATTERNS = [
  "之前",
  "上次",
  "以前",
  "还记得",
  "默认",
  "长期",
  "我一般",
  "我的偏好",
  "我之前怎么",
  "我上次怎么",
];

const CURRENT_TASK_PATTERNS = [
  "这个文件",
  "这段日志",
  "这个配置",
  "这个报错",
  "这篇文档",
  "这段内容",
  "这个输出",
  "这个结果",
  "这张图",
  "summarize this",
  "this file",
  "this config",
  "this log",
  "this error",
  "this document",
];

const CURRENT_TASK_VERBS = [
  "帮我查",
  "看看",
  "总结",
  "改下",
  "修改",
  "解释",
  "分析",
  "排查",
  "修复",
  "生成",
  "review",
  "summarize",
  "fix",
  "debug",
  "analyze",
];

const IDENTITY_QUERY_PATTERNS = [
  "我是谁",
  "我叫什么",
  "我的时区",
  "timezone",
  "location",
  "name",
  "称呼",
];

const CHARS_PER_TOKEN = 4;

export interface RecallResult {
  context: string;
  memories: MemoryItem[];
  tokenEstimate: number;
  debug: {
    decision: "skip" | "long_term" | "long_term_plus_session";
    skipReason?: string;
    rawCandidateCount: number;
    postThresholdCount: number;
    postDedupeCount: number;
  };
}

type RecallDecision =
  | { decision: "skip"; reason: string }
  | { decision: "long_term" }
  | { decision: "long_term_plus_session" };

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern.toLowerCase()));
}

function isLikelyCurrentTaskRequest(text: string): boolean {
  return (
    includesAny(text, CURRENT_TASK_PATTERNS) ||
    CURRENT_TASK_VERBS.some((verb) => text.startsWith(verb.toLowerCase()))
  );
}

function wantsIdentityContext(text: string): boolean {
  return includesAny(text, IDENTITY_QUERY_PATTERNS);
}

function getMemoryImportance(memory: MemoryItem): number {
  if (
    memory.metadata?.importance &&
    typeof memory.metadata.importance === "number"
  ) {
    return memory.metadata.importance;
  }

  const cat = getMemoryCategory(memory);
  const defaults: Record<string, number> = {
    rule: 0.95,
    configuration: 0.95,
    decision: 0.9,
    preference: 0.85,
    project: 0.8,
    technical: 0.75,
    relationship: 0.7,
    operational: 0.6,
    identity: 0.55,
  };
  return defaults[cat] ?? 0.5;
}

function rankMemories(
  memories: MemoryItem[],
  categoryOrder: string[],
  identityMode: "always" | "on-demand" | "never",
  wantsIdentity: boolean,
): MemoryItem[] {
  const orderMap = new Map(categoryOrder.map((cat, i) => [cat, i]));

  return [...memories].sort((a, b) => {
    const catA = getMemoryCategory(a);
    const catB = getMemoryCategory(b);
    const orderA = orderMap.get(catA) ?? 999;
    const orderB = orderMap.get(catB) ?? 999;

    let adjustedOrderA = orderA;
    let adjustedOrderB = orderB;
    if (identityMode !== "always" && !wantsIdentity) {
      if (catA === "identity") adjustedOrderA = 999;
      if (catB === "identity") adjustedOrderB = 999;
    }
    if (identityMode === "never") {
      if (catA === "identity") adjustedOrderA = 999;
      if (catB === "identity") adjustedOrderB = 999;
    }

    if (adjustedOrderA !== adjustedOrderB) return adjustedOrderA - adjustedOrderB;

    const impA = getMemoryImportance(a);
    const impB = getMemoryImportance(b);
    if (impA !== impB) return impB - impA;

    return (b.score ?? 0) - (a.score ?? 0);
  });
}

function thresholdMemories(
  memories: MemoryItem[],
  threshold: number,
  relativeScoreThreshold: number,
): MemoryItem[] {
  const absolute = memories.filter((memory) => (memory.score ?? 0) >= threshold);
  if (absolute.length <= 1) return absolute;

  const topScore = absolute[0]?.score ?? 0;
  if (topScore <= 0) return absolute;

  return absolute.filter(
    (memory) => (memory.score ?? 0) >= topScore * relativeScoreThreshold,
  );
}

function dedupeMemories(memories: MemoryItem[]): MemoryItem[] {
  const deduped: MemoryItem[] = [];
  for (const candidate of memories) {
    const existingIndex = deduped.findIndex((memory) =>
      isSameTopic(memory, candidate),
    );
    if (existingIndex === -1) {
      deduped.push(candidate);
      continue;
    }
    deduped[existingIndex] = chooseBetterMemory(deduped[existingIndex], candidate);
  }
  return deduped;
}

function budgetMemories(
  rankedMemories: MemoryItem[],
  tokenBudget: number,
  maxMemories: number,
  identityMode: "always" | "on-demand" | "never",
  wantsIdentity: boolean,
): MemoryItem[] {
  const selected: MemoryItem[] = [];
  let usedTokens = 0;

  for (const memory of rankedMemories) {
    if (selected.length >= maxMemories) break;

    const category = getMemoryCategory(memory);
    if (
      category === "identity" &&
      (identityMode === "never" || (identityMode === "on-demand" && !wantsIdentity))
    ) {
      continue;
    }

    const memTokens = estimateTokens(memory.memory);
    if (usedTokens + memTokens > tokenBudget) continue;

    selected.push(memory);
    usedTokens += memTokens;
  }

  return selected;
}

function summarizeMemory(memory: MemoryItem): string {
  return memory.memory.replace(/\s+/g, " ").trim();
}

function formatRecalledMemories(
  memories: MemoryItem[],
  userId: string,
  summaryEnabled: boolean,
): string {
  if (memories.length === 0) {
    return `<recalled-memories>\nNo stored memories found for "${userId}".\n</recalled-memories>`;
  }

  if (!summaryEnabled) {
    const lines = [`<recalled-memories>`, `Stored memories for "${userId}":`];
    for (const memory of memories) {
      lines.push(`- ${memory.memory}`);
    }
    lines.push(`</recalled-memories>`);
    return lines.join("\n");
  }

  const grouped: Record<string, string[]> = {
    Rules: [],
    Preferences: [],
    "Decisions / Config": [],
    Projects: [],
  };

  for (const memory of memories) {
    const summary = summarizeMemory(memory);
    const category = getMemoryCategory(memory);
    if (category === "rule") grouped.Rules.push(summary);
    else if (category === "preference" || category === "identity")
      grouped.Preferences.push(summary);
    else if (category === "decision" || category === "configuration")
      grouped["Decisions / Config"].push(summary);
    else grouped.Projects.push(summary);
  }

  const lines = [
    `<recalled-memories>`,
    `Relevant stored memories for "${userId}":`,
    "",
  ];

  for (const [section, items] of Object.entries(grouped)) {
    if (items.length === 0) continue;
    lines.push(`${section}:`);
    for (const item of items.slice(0, 2)) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  lines.push(`</recalled-memories>`);
  return lines.join("\n");
}

export function sanitizeQuery(raw: string): string {
  let cleaned = raw.replace(
    /Sender\s*\(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
    "",
  );
  cleaned = cleaned.replace(/^\[.*?\]\s*/g, "");
  cleaned = cleaned.trim();
  return cleaned || raw;
}

export function shouldRecallLongTermMemory(
  rawQuery: string,
  config: SkillsConfig = {},
): RecallDecision {
  const recallConfig = config.recall ?? {};
  if (recallConfig.gateEnabled === false) {
    return { decision: "long_term" };
  }

  const cleanQuery = sanitizeQuery(rawQuery);
  const normalized = normalizeText(cleanQuery);
  const shortQueryChars = recallConfig.shortQueryChars ?? DEFAULT_SHORT_QUERY_CHARS;
  const continuationPatterns =
    recallConfig.continuationPatterns ?? DEFAULT_CONTINUATION_PATTERNS;
  const historyPatterns = recallConfig.historyPatterns ?? DEFAULT_HISTORY_PATTERNS;

  if (!normalized) {
    return { decision: "skip", reason: "empty_query" };
  }
  if (isLikelyCurrentTaskRequest(normalized)) {
    return { decision: "skip", reason: "current_task_context" };
  }
  if (cleanQuery.length <= shortQueryChars) {
    return { decision: "skip", reason: "short_query" };
  }
  if (includesAny(normalized, continuationPatterns)) {
    return { decision: "skip", reason: "continuation" };
  }
  if (includesAny(normalized, historyPatterns)) {
    return { decision: "long_term" };
  }

  return { decision: "long_term" };
}

export async function recall(
  provider: Mem0Provider,
  query: string,
  userId: string,
  config: SkillsConfig = {},
  sessionId?: string,
): Promise<RecallResult> {
  const recallConfig = config.recall ?? {};
  const tokenBudget = recallConfig.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const rawTopK = recallConfig.rawTopK ?? DEFAULT_RAW_TOP_K;
  const maxMemories =
    recallConfig.finalMaxMemories ??
    recallConfig.maxMemories ??
    DEFAULT_FINAL_MAX_MEMORIES;
  const threshold = recallConfig.threshold ?? DEFAULT_THRESHOLD;
  const relativeScoreThreshold =
    recallConfig.relativeScoreThreshold ?? DEFAULT_RELATIVE_SCORE_THRESHOLD;
  const categoryOrder = recallConfig.categoryOrder ?? DEFAULT_CATEGORY_ORDER;
  const summaryEnabled = recallConfig.summaryEnabled !== false;
  const dedupeEnabled = recallConfig.dedupeEnabled !== false;
  const identityMode = recallConfig.identityMode ?? "on-demand";
  const wantsIdentity = wantsIdentityContext(normalizeText(query));

  const searchOpts: SearchOptions = {
    user_id: userId,
    top_k: rawTopK,
    threshold,
    keyword_search: recallConfig.keywordSearch !== false,
    reranking: recallConfig.rerank !== false,
    filter_memories: recallConfig.filterMemories !== false,
  };

  const cleanQuery = sanitizeQuery(query);

  let longTermMemories: MemoryItem[] = [];
  try {
    longTermMemories = await provider.search(cleanQuery, searchOpts);
  } catch (err) {
    console.warn(
      "[mem0] Recall search failed:",
      err instanceof Error ? err.message : err,
    );
  }

  let sessionMemories: MemoryItem[] = [];
  if (sessionId) {
    try {
      sessionMemories = await provider.search(cleanQuery, {
        ...searchOpts,
        run_id: sessionId,
        top_k: Math.min(rawTopK, 5),
      });
    } catch {
      // Session search failure should not block turn execution.
    }
  }

  const rawCandidateCount = longTermMemories.length + sessionMemories.length;
  const longTermIds = new Set(longTermMemories.map((memory) => memory.id));
  const uniqueSession = sessionMemories.filter(
    (memory) => !longTermIds.has(memory.id),
  );

  const allMemories = [...longTermMemories, ...uniqueSession].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  );
  const thresholded = thresholdMemories(
    allMemories,
    threshold,
    relativeScoreThreshold,
  );
  const postThresholdCount = thresholded.length;
  const deduped = dedupeEnabled ? dedupeMemories(thresholded) : thresholded;
  const postDedupeCount = deduped.length;

  const ranked = rankMemories(
    deduped,
    categoryOrder,
    identityMode,
    wantsIdentity,
  );
  const budgeted = budgetMemories(
    ranked,
    tokenBudget,
    maxMemories,
    identityMode,
    wantsIdentity,
  );

  const context = formatRecalledMemories(budgeted, userId, summaryEnabled);
  const tokenEstimate = estimateTokens(context);

  return {
    context,
    memories: budgeted,
    tokenEstimate,
    debug: {
      decision: sessionId ? "long_term_plus_session" : "long_term",
      rawCandidateCount,
      postThresholdCount,
      postDedupeCount,
    },
  };
}
