import { randomUUID } from "node:crypto";
import * as path from "node:path";

import { exists, mkdirp, readText, writeText } from "./fs-safe.ts";

export type DreamJobStatus = "pending" | "running" | "completed" | "failed";

export interface DreamQueueJob {
  id: string;
  userId: string;
  sessionId?: string;
  stateDir: string;
  stateSource: "session" | "plugin" | "runtime" | "none";
  reason: string;
  priority: number;
  status: DreamJobStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
  completedAt?: number;
  failedAt?: number;
  nextAttemptAt?: number;
  lastError?: string;
}

interface DreamQueueState {
  version: 1;
  updatedAt: number;
  jobs: DreamQueueJob[];
}

const QUEUE_FILE = "dream-queue.json";
const MAX_RETAINED_JOBS = 200;
const RETAIN_COMPLETED_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_RUNNING_MS = 60 * 60 * 1000;

function queuePath(stateDir: string): string {
  return path.join(stateDir, QUEUE_FILE);
}

function defaultQueueState(now = Date.now()): DreamQueueState {
  return {
    version: 1,
    updatedAt: now,
    jobs: [],
  };
}

function readQueueState(stateDir: string): DreamQueueState {
  try {
    const raw = readText(queuePath(stateDir));
    const parsed = JSON.parse(raw) as Partial<DreamQueueState>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      jobs: Array.isArray(parsed.jobs) ? (parsed.jobs as DreamQueueJob[]) : [],
    };
  } catch {
    return defaultQueueState();
  }
}

function writeQueueState(stateDir: string, state: DreamQueueState): void {
  mkdirp(stateDir);
  writeText(queuePath(stateDir), JSON.stringify(state, null, 2));
}

function trimQueueState(state: DreamQueueState, now = Date.now()): DreamQueueState {
  const retained = state.jobs.filter((job) => {
    if (job.status === "completed" || job.status === "failed") {
      return now - job.updatedAt <= RETAIN_COMPLETED_MS;
    }
    if (job.status === "running") {
      return now - job.updatedAt <= STALE_RUNNING_MS;
    }
    return true;
  });

  retained.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });

  state.jobs = retained.slice(0, MAX_RETAINED_JOBS);
  state.updatedAt = now;
  return state;
}

function latestRelevantJob(
  jobs: DreamQueueJob[],
  stateDir: string,
  sessionId?: string,
): DreamQueueJob | undefined {
  const activeJobs = jobs.filter(
    (job) =>
      job.stateDir === stateDir &&
      (job.status === "pending" || job.status === "running"),
  );

  if (activeJobs.length === 0) return undefined;
  if (sessionId) {
    const sessionJob = activeJobs.find((job) => job.sessionId === sessionId);
    if (sessionJob) return sessionJob;
  }
  return activeJobs[0];
}

export interface EnqueueDreamJobInput {
  userId: string;
  sessionId?: string;
  stateDir: string;
  stateSource: "session" | "plugin" | "runtime" | "none";
  reason: string;
  priority: number;
}

export interface EnqueueDreamJobResult {
  enqueued: boolean;
  skippedReason?: string;
  job?: DreamQueueJob;
}

export function enqueueDreamJob(
  stateDir: string,
  input: EnqueueDreamJobInput,
): EnqueueDreamJobResult {
  const now = Date.now();
  const state = trimQueueState(readQueueState(stateDir), now);
  const existing = latestRelevantJob(state.jobs, input.stateDir, input.sessionId);
  if (existing) {
    return {
      enqueued: false,
      skippedReason: "duplicate_pending_or_running_job",
      job: existing,
    };
  }

  const job: DreamQueueJob = {
    id: randomUUID(),
    userId: input.userId,
    sessionId: input.sessionId,
    stateDir: input.stateDir,
    stateSource: input.stateSource,
    reason: input.reason,
    priority: input.priority,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  state.jobs.push(job);
  trimQueueState(state, now);
  writeQueueState(stateDir, state);
  return { enqueued: true, job };
}

export function claimNextDreamJob(
  stateDir: string,
  now = Date.now(),
): DreamQueueJob | undefined {
  const state = trimQueueState(readQueueState(stateDir), now);
  const candidate = state.jobs
    .filter(
      (job) =>
        job.status === "pending" &&
        (job.nextAttemptAt === undefined || job.nextAttemptAt <= now),
    )
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    })[0];

  if (!candidate) return undefined;

  candidate.status = "running";
  candidate.attempts += 1;
  candidate.claimedAt = now;
  candidate.updatedAt = now;
  candidate.lastError = undefined;
  candidate.nextAttemptAt = undefined;
  writeQueueState(stateDir, state);
  return candidate;
}

export function completeDreamJob(
  stateDir: string,
  jobId: string,
): DreamQueueJob | undefined {
  const now = Date.now();
  const state = trimQueueState(readQueueState(stateDir), now);
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return undefined;
  job.status = "completed";
  job.completedAt = now;
  job.updatedAt = now;
  writeQueueState(stateDir, state);
  return job;
}

export function failDreamJob(
  stateDir: string,
  jobId: string,
  error: string,
  retryDelayMs = 60_000,
  maxAttempts = 3,
): DreamQueueJob | undefined {
  const now = Date.now();
  const state = trimQueueState(readQueueState(stateDir), now);
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return undefined;

  job.lastError = error;
  job.updatedAt = now;
  if (job.attempts >= maxAttempts) {
    job.status = "failed";
    job.failedAt = now;
    job.completedAt = now;
    job.nextAttemptAt = undefined;
  } else {
    job.status = "pending";
    job.nextAttemptAt = now + retryDelayMs;
  }

  writeQueueState(stateDir, state);
  return job;
}

export function listDreamJobs(stateDir: string): DreamQueueJob[] {
  return trimQueueState(readQueueState(stateDir)).jobs;
}

export function hasDreamQueue(stateDir: string): boolean {
  return exists(queuePath(stateDir));
}
