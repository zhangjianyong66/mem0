import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { chooseBetterMemory, getMemoryCategory, getEntityKey, getTopicKey, normalizeMemoryText } from "./tools/topic-match.ts";
import type { Mem0Config, Mem0Provider, MemoryItem } from "./types.ts";
import { analyzeMemoryInventory, type DreamGroup } from "./dream-analyzer.ts";
import {
  type DreamWriteAction,
  recordDreamFeedback,
  readDreamFeedbackState,
} from "./dream-feedback.ts";
import { acquireDreamLock, checkCheapGates, checkMemoryGate, recordDreamCompletion, releaseDreamLock } from "./dream-gate.ts";
import { claimNextDreamJob, completeDreamJob, failDreamJob } from "./dream-queue.ts";
import type { DreamQueueJob } from "./dream-queue.ts";

const MAX_GROUPS_PER_RUN = 12;
const MAX_WORDS = 50;
const RETRY_DELAY_MS = 60_000;
const MAX_JOB_ATTEMPTS = 3;
const ACTIONABLE_SINGLETON_CATEGORIES = new Set([
  "project",
  "configuration",
  "decision",
  "operational",
]);

export interface DreamWorkerContext {
  api: OpenClawPluginApi;
  provider: Mem0Provider;
  cfg: Mem0Config;
  captureEvent: (event: string, props?: Record<string, unknown>) => void;
}

export interface DreamWorkerResult {
  status: "completed" | "noop" | "skipped" | "busy" | "failed";
  reason?: string;
  error?: string;
  memoryCount?: number;
  groupCount?: number;
  actionCount?: number;
  updatedCount?: number;
  deletedCount?: number;
  addedCount?: number;
}

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function trimToWordLimit(text: string, limit: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= limit) return text.trim();
  return `${words.slice(0, limit).join(" ")}...`;
}

function hasTemporalAnchor(text: string): boolean {
  return (
    /\bAs of \d{4}-\d{2}-\d{2}\b/i.test(text) ||
    /截至\s*\d{4}-\d{2}-\d{2}/.test(text)
  );
}

function isDeleteCandidate(memory: MemoryItem): boolean {
  const text = memory.memory.trim();
  return (
    /sk-/i.test(text) ||
    /m0-/i.test(text) ||
    /ghp_/i.test(text) ||
    /AKIA/.test(text) ||
    /Bearer /i.test(text) ||
    /password=/i.test(text) ||
    /token=/i.test(text) ||
    /secret=/i.test(text) ||
    /^(ok|okay|sure|got it|thanks|done)$/i.test(text) ||
    /^System:/i.test(text) ||
    /HEARTBEAT_OK/i.test(text) ||
    /NO_REPLY/i.test(text) ||
    /tool output/i.test(text)
  );
}

function isStaleCandidate(memory: MemoryItem, now: Date): boolean {
  const category = getMemoryCategory(memory);
  const temporalScope = (memory.metadata?.temporalScope as string | undefined) ?? "historical";
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

function isRewriteCandidate(memory: MemoryItem): boolean {
  const category = getMemoryCategory(memory);
  const wordTotal = wordCount(memory.memory);
  return (
    (["project", "configuration", "decision", "operational"].includes(category) &&
      !hasTemporalAnchor(memory.memory)) ||
    /\bI\b/.test(memory.memory) ||
    /\bmy\b/i.test(memory.memory) ||
    /我(喜欢|偏好|正在|决定|配置)/.test(memory.memory) ||
    wordTotal > 50
  );
}

function normalizeText(text: string): string {
  return normalizeMemoryText(text);
}

function hasDuplicateLikeContent(members: MemoryItem[]): boolean {
  if (members.length < 2) return false;
  const normalized = members.map((member) => normalizeText(member.memory));
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

function replaceFirstPerson(text: string): string {
  let next = text.trim();
  next = next
    .replace(/^我(?!们)/, "用户")
    .replace(/^我的/, "用户的")
    .replace(/\bI am\b/gi, "User is")
    .replace(/\bI'm\b/gi, "User is")
    .replace(/\bI\b/g, "User")
    .replace(/\bmy\b/gi, "user's")
    .replace(/\bme\b/gi, "user");
  return next;
}

function addTemporalAnchor(text: string, now: Date): string {
  if (hasTemporalAnchor(text)) return text.trim();
  const date = now.toISOString().slice(0, 10);
  if (hasChinese(text)) {
    return `截至 ${date}，${text.trim()}`;
  }
  return `As of ${date}, ${text.trim()}`;
}

function rewriteMemoryText(memory: MemoryItem, now: Date): string {
  let next = replaceFirstPerson(memory.memory);
  next = next.replace(/\s+/g, " ").trim();
  next = addTemporalAnchor(next, now);
  if (wordCount(next) > MAX_WORDS) {
    next = trimToWordLimit(next, MAX_WORDS);
  }
  return next;
}

function mergeMemoryText(current: string, incoming: string): string {
  const currentTrimmed = current.trim();
  const incomingTrimmed = incoming.trim();
  const currentNorm = normalizeText(currentTrimmed);
  const incomingNorm = normalizeText(incomingTrimmed);

  if (!incomingNorm) return currentTrimmed;
  if (!currentNorm) return incomingTrimmed;
  if (currentNorm === incomingNorm) return currentTrimmed;
  if (currentNorm.includes(incomingNorm)) return currentTrimmed;
  if (incomingNorm.includes(currentNorm)) return incomingTrimmed;

  if (incomingTrimmed.length > currentTrimmed.length) {
    return `${currentTrimmed} ${incomingTrimmed}`.replace(/\s+/g, " ").trim();
  }
  return `${currentTrimmed} ${incomingTrimmed}`.replace(/\s+/g, " ").trim();
}

function sortMembersForConsolidation(members: MemoryItem[]): MemoryItem[] {
  return [...members].sort((a, b) => {
    const chosen = chooseBetterMemory(a, b);
    if (chosen.id === a.id && chosen.id !== b.id) return -1;
    if (chosen.id === b.id && chosen.id !== a.id) return 1;
    return (b.updated_at ?? b.created_at ?? "").localeCompare(
      a.updated_at ?? a.created_at ?? "",
    );
  });
}

function pickTargetMember(members: MemoryItem[]): MemoryItem | undefined {
  const writable = members.filter((memory) => memory.metadata?.immutable !== true);
  const pool = writable.length > 0 ? writable : [];
  if (pool.length === 0) return undefined;
  return sortMembersForConsolidation(pool)[0];
}

function buildConsolidatedText(members: MemoryItem[], now: Date): string {
  const sorted = sortMembersForConsolidation(members);
  let text = sorted[0]?.memory ?? "";
  for (const member of sorted.slice(1)) {
    const next = mergeMemoryText(text, member.memory);
    if (wordCount(next) <= MAX_WORDS) {
      text = next;
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  text = addTemporalAnchor(replaceFirstPerson(text), now);
  if (wordCount(text) > MAX_WORDS) {
    text = trimToWordLimit(text, MAX_WORDS);
  }
  return text;
}

function buildWriteAction(memory: MemoryItem, kind: "update" | "delete", text?: string): DreamWriteAction {
  const category = getMemoryCategory(memory);
  const topicKey = getTopicKey(memory) ?? undefined;
  const entityKey = getEntityKey(memory) ?? undefined;
  if (kind === "delete") {
    return {
      tool: "memory_delete",
      type: "delete",
      memoryId: memory.id,
      topicKey,
      entityKey,
      category,
    };
  }
  return {
    tool: "memory_update",
    type: "rewrite_or_merge",
    memoryId: memory.id,
    text: text ?? memory.memory,
    topicKey,
    entityKey,
    category,
  };
}

function collectKnownMemories(memories: MemoryItem[]): Record<string, MemoryItem> {
  return Object.fromEntries(memories.map((memory) => [memory.id, memory]));
}

function scoreDreamGroup(group: DreamGroup, members: MemoryItem[]): number {
  let score = group.feedbackPriority;
  if (group.candidateActions.includes("delete")) score += 8;
  if (group.candidateActions.includes("merge") && hasDuplicateLikeContent(members)) {
    score += 6;
  }
  if (group.candidateActions.includes("stale")) score += 4;
  if (group.candidateActions.includes("rewrite")) score += group.count === 1 ? 2 : 1;
  if (group.count > 1) score += 1;
  if (group.count === 1 && ACTIONABLE_SINGLETON_CATEGORIES.has(group.category)) score += 1;
  return score;
}

function shouldProcessDreamGroup(group: DreamGroup, members: MemoryItem[]): boolean {
  const score = scoreDreamGroup(group, members);
  if (group.count > 1) {
    return score >= 6;
  }
  return score >= 3 && group.candidateActions.some((action) => action !== "merge");
}

function selectDreamCandidateGroups(groups: DreamGroup[]): DreamGroup[] {
  return [...groups]
    .filter((group) => {
      const members = group.members ?? group.representativeMemories ?? [];
      return shouldProcessDreamGroup(group, members);
    })
    .sort((a, b) => {
      const aMembers = a.members ?? a.representativeMemories ?? [];
      const bMembers = b.members ?? b.representativeMemories ?? [];
      const scoreDelta = scoreDreamGroup(b, bMembers) - scoreDreamGroup(a, aMembers);
      if (scoreDelta !== 0) return scoreDelta;
      if (b.feedbackPriority !== a.feedbackPriority) return b.feedbackPriority - a.feedbackPriority;
      if (b.count !== a.count) return b.count - a.count;
      return b.newest.localeCompare(a.newest);
    })
    .slice(0, MAX_GROUPS_PER_RUN);
}

export async function executeDreamJob(
  job: DreamQueueJob,
  deps: DreamWorkerContext,
): Promise<DreamWorkerResult> {
  const stateDir = job.stateDir;
  if (!acquireDreamLock(stateDir)) {
    return { status: "busy", reason: "lock_busy" };
  }

  try {
    const cheapGate = checkCheapGates(stateDir, deps.cfg.skills?.dream ?? {});
    if (!cheapGate.proceed) {
      return { status: "skipped", reason: cheapGate.reason ?? "cheap_gate_failed" };
    }

    const memories = await deps.provider.getAll({
      user_id: job.userId,
      source: "OPENCLAW",
      page_size: 500,
    });
    const memoryCount = memories.length;
    const memoryGate = checkMemoryGate(memoryCount, deps.cfg.skills?.dream ?? {});
    if (!memoryGate.pass) {
      return { status: "skipped", reason: memoryGate.reason ?? "memory_gate_failed", memoryCount };
    }

    const feedbackState = readDreamFeedbackState(stateDir);
    const analysis = analyzeMemoryInventory(memories, new Date(), feedbackState);
    const memoryById = collectKnownMemories(memories);
    const now = new Date();
    const candidateGroups = selectDreamCandidateGroups(analysis.groups);
    const writeActions: DreamWriteAction[] = [];
    let updatedCount = 0;
    let deletedCount = 0;
    let addedCount = 0;

    for (const group of candidateGroups) {
      const members = group.members ?? group.representativeMemories ?? [];
      const eligibleMembers = members.filter((memory) => Boolean(memory?.id));
      if (eligibleMembers.length === 0) continue;

      const dangerousMembers = eligibleMembers.filter(isDeleteCandidate);
      const staleMembers = eligibleMembers.filter((memory) => isStaleCandidate(memory, now));
      const rewriteMembers = eligibleMembers.filter(isRewriteCandidate);
      const preserveableMembers = eligibleMembers.filter(
        (memory) => !isDeleteCandidate(memory) && !isStaleCandidate(memory, now),
      );

      const allDangerous = dangerousMembers.length === eligibleMembers.length;
      const allStale = staleMembers.length === eligibleMembers.length;

      if (allDangerous || (allStale && preserveableMembers.length === 0)) {
        for (const memory of eligibleMembers) {
          try {
            await deps.provider.delete(memory.id);
            deletedCount += 1;
            writeActions.push(buildWriteAction(memory, "delete"));
          } catch (err) {
            throw new Error(`delete failed for ${memory.id}: ${String(err)}`);
          }
        }
        continue;
      }

      if (eligibleMembers.length > 1) {
        const target = pickTargetMember(eligibleMembers);
        if (!target) continue;

        const consolidatedText = buildConsolidatedText(
          eligibleMembers,
          now,
        );
        const targetTextNorm = normalizeText(target.memory);
        const consolidatedTextNorm = normalizeText(consolidatedText);

        if (consolidatedTextNorm && consolidatedTextNorm !== targetTextNorm) {
          await deps.provider.update(target.id, consolidatedText);
          updatedCount += 1;
          writeActions.push(buildWriteAction(target, "update", consolidatedText));
        }

        for (const memory of eligibleMembers) {
          if (memory.id === target.id) continue;
          try {
            await deps.provider.delete(memory.id);
            deletedCount += 1;
            writeActions.push(buildWriteAction(memory, "delete"));
          } catch (err) {
            throw new Error(`delete failed for ${memory.id}: ${String(err)}`);
          }
        }
        continue;
      }

      const sole = eligibleMembers[0];
      if (!sole) continue;

      if (isDeleteCandidate(sole)) {
        await deps.provider.delete(sole.id);
        deletedCount += 1;
        writeActions.push(buildWriteAction(sole, "delete"));
        continue;
      }

      if (rewriteMembers.length > 0 || isRewriteCandidate(sole)) {
        const rewritten = rewriteMemoryText(sole, now);
        if (normalizeText(rewritten) !== normalizeText(sole.memory)) {
          await deps.provider.update(sole.id, rewritten);
          updatedCount += 1;
          writeActions.push(buildWriteAction(sole, "update", rewritten));
        }
      }
    }

    if (writeActions.length > 0) {
      const feedbackRun = {
        id: `dream-${job.id}`,
        timestamp: Date.now(),
        parsedWriteActions: writeActions.length,
        feedbackTopicsCount: new Set(
          writeActions
            .map((action) => action.topicKey || action.entityKey)
            .filter((value): value is string => Boolean(value)),
        ).size,
        parseComplete: true,
        actions: writeActions,
      };
      recordDreamFeedback(stateDir, feedbackRun, memoryById);
    }

    recordDreamCompletion(stateDir);
    return {
      status: writeActions.length > 0 ? "completed" : "noop",
      memoryCount,
      groupCount: analysis.groupCount,
      actionCount: writeActions.length,
      updatedCount,
      deletedCount,
      addedCount,
    };
  } catch (error) {
    return {
      status: "failed",
      error: String(error),
      reason: String(error),
    };
  } finally {
    releaseDreamLock(stateDir);
  }
}

export interface DreamDrainOutcome {
  processed: number;
  result?: DreamWorkerResult;
}

export async function drainDreamQueue(
  queueStateDir: string,
  deps: DreamWorkerContext,
): Promise<DreamDrainOutcome> {
  const job = claimNextDreamJob(queueStateDir);
  if (!job) {
    return { processed: 0 };
  }

  deps.api.logger.info(
    `openclaw-mem0: dream worker claimed job ${job.id} (user=${job.userId}, session=${job.sessionId ?? "none"}, reason=${job.reason})`,
  );
  deps.captureEvent("openclaw.hook.dream", {
    phase: "claimed",
    job_id: job.id,
    user_id: job.userId,
    session_id: job.sessionId ?? null,
    reason: job.reason,
    state_dir_source: job.stateSource,
  });

  const result = await executeDreamJob(job, deps);
  if (result.status === "completed" || result.status === "noop" || result.status === "skipped") {
    completeDreamJob(queueStateDir, job.id);
    deps.captureEvent("openclaw.hook.dream", {
      phase: result.status,
      job_id: job.id,
      memory_count: result.memoryCount ?? null,
      group_count: result.groupCount ?? null,
      action_count: result.actionCount ?? null,
      updated_count: result.updatedCount ?? null,
      deleted_count: result.deletedCount ?? null,
      added_count: result.addedCount ?? null,
      reason: result.reason ?? null,
      error: result.error ?? null,
    });
    deps.api.logger.info(
      `openclaw-mem0: dream worker ${result.status} job ${job.id} (${result.reason ?? "ok"})`,
    );
    return { processed: 1, result };
  }

  if (result.status === "busy") {
    failDreamJob(queueStateDir, job.id, result.reason ?? "lock_busy", RETRY_DELAY_MS, MAX_JOB_ATTEMPTS);
  } else {
    failDreamJob(queueStateDir, job.id, result.error ?? result.reason ?? "dream_worker_failed", RETRY_DELAY_MS, MAX_JOB_ATTEMPTS);
  }

  deps.captureEvent("openclaw.hook.dream", {
    phase: "failed",
    job_id: job.id,
    reason: result.reason ?? null,
    error: result.error ?? null,
  });
  deps.api.logger.warn(
    `openclaw-mem0: dream worker failed job ${job.id} (${result.reason ?? result.error ?? "unknown"})`,
  );
  return { processed: 1, result };
}
