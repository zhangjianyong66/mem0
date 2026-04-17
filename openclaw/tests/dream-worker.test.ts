import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../dream-gate.ts", () => ({
  acquireDreamLock: vi.fn(),
  checkCheapGates: vi.fn(),
  checkMemoryGate: vi.fn(),
  recordDreamCompletion: vi.fn(),
  releaseDreamLock: vi.fn(),
}));

vi.mock("../dream-feedback.ts", () => ({
  readDreamFeedbackState: vi.fn(() => ({
    lastUpdatedAt: 0,
    recentDreamRuns: [],
    topicOutcomes: {},
    writeOutcomeByMemoryId: {},
    dedupeTuning: {},
  })),
  recordDreamFeedback: vi.fn(),
}));

import {
  acquireDreamLock,
  checkCheapGates,
  checkMemoryGate,
  recordDreamCompletion,
  releaseDreamLock,
} from "../dream-gate.ts";
import { recordDreamFeedback, readDreamFeedbackState } from "../dream-feedback.ts";
import { drainDreamQueue, executeDreamJob } from "../dream-worker.ts";
import type { DreamQueueJob } from "../dream-queue.ts";

const mockAcquireDreamLock = acquireDreamLock as ReturnType<typeof vi.fn>;
const mockCheckCheapGates = checkCheapGates as ReturnType<typeof vi.fn>;
const mockCheckMemoryGate = checkMemoryGate as ReturnType<typeof vi.fn>;
const mockRecordDreamCompletion = recordDreamCompletion as ReturnType<typeof vi.fn>;
const mockReleaseDreamLock = releaseDreamLock as ReturnType<typeof vi.fn>;
const mockRecordDreamFeedback = recordDreamFeedback as ReturnType<typeof vi.fn>;
const mockReadDreamFeedbackState = readDreamFeedbackState as ReturnType<typeof vi.fn>;

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function createMemory(id: string, text: string) {
  return {
    id,
    memory: text,
    metadata: {
      category: "project",
      topicKey: "project:gateway",
      entityKey: "project:gateway",
      temporalScope: "ongoing",
    },
    categories: ["project"],
    created_at: "2026-04-10T00:00:00.000Z",
    updated_at: "2026-04-10T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAcquireDreamLock.mockReturnValue(true);
  mockCheckCheapGates.mockReturnValue({ proceed: true });
  mockCheckMemoryGate.mockReturnValue({ pass: true });
  mockRecordDreamCompletion.mockReturnValue(undefined);
  mockReleaseDreamLock.mockReturnValue(undefined);
  mockRecordDreamFeedback.mockReturnValue(undefined);
  mockReadDreamFeedbackState.mockReturnValue({
    lastUpdatedAt: 0,
    recentDreamRuns: [],
    topicOutcomes: {},
    writeOutcomeByMemoryId: {},
    dedupeTuning: {},
  });
});

describe("dream-worker", () => {
  it("consolidates duplicate memories and records feedback", async () => {
    const update = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const provider = {
      getAll: vi.fn(async () => [
        createMemory("m1", "User uses Claude Code for local coding tasks."),
        createMemory("m2", "User uses Claude Code for local coding tasks."),
        {
          id: "m3",
          memory: "User prefers green tea.",
          metadata: {
            category: "preference",
            topicKey: "preference:tea",
            entityKey: "preference:tea",
            temporalScope: "stable",
          },
          categories: ["preference"],
          created_at: "2026-04-10T00:00:00.000Z",
          updated_at: "2026-04-10T00:00:00.000Z",
        },
      ]),
      update,
      delete: remove,
    };

    const job: DreamQueueJob = {
      id: "job-1",
      userId: "user-1",
      stateDir: "/tmp/test-state",
      stateSource: "session",
      reason: "sessions_since=5",
      priority: 5,
      status: "running",
      attempts: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const logger = createLogger();
    const result = await executeDreamJob(job, {
      api: { logger } as any,
      provider: provider as any,
      cfg: { skills: { dream: { minHours: 0, minSessions: 0, minMemories: 1 } } } as any,
      captureEvent: vi.fn(),
    });

    expect(result.status).toBe("completed");
    expect(result.updatedCount).toBe(0);
    expect(result.deletedCount).toBe(1);
    expect(update).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(mockRecordDreamFeedback).toHaveBeenCalledTimes(1);
    expect(mockRecordDreamCompletion).toHaveBeenCalledTimes(1);
    expect(mockReleaseDreamLock).toHaveBeenCalledTimes(1);
  });

  it("releases the lock and reports busy when another worker is active", async () => {
    mockAcquireDreamLock.mockReturnValue(false);
    const provider = {
      getAll: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    const job: DreamQueueJob = {
      id: "job-2",
      userId: "user-1",
      stateDir: "/tmp/test-state",
      stateSource: "plugin",
      reason: "sessions_since=8",
      priority: 8,
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = await executeDreamJob(job, {
      api: { logger: createLogger() } as any,
      provider: provider as any,
      cfg: { skills: { dream: {} } } as any,
      captureEvent: vi.fn(),
    });

    expect(result.status).toBe("busy");
    expect(mockReleaseDreamLock).not.toHaveBeenCalled();
    expect(provider.getAll).not.toHaveBeenCalled();
  });

  it("drains a queued job through the claim/complete lifecycle", async () => {
    const queueModule = await import("../dream-queue.ts");
    const stateDir = "/tmp/queue-state";
    queueModule.enqueueDreamJob(stateDir, {
      userId: "user-1",
      stateDir,
      stateSource: "runtime",
      reason: "sessions_since=10",
      priority: 10,
    });

    const provider = {
      getAll: vi.fn(async () => [
        createMemory("m1", "User uses Claude Code for local coding tasks."),
        createMemory("m2", "User uses Claude Code for local coding tasks."),
      ]),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    const outcome = await drainDreamQueue(stateDir, {
      api: { logger: createLogger() } as any,
      provider: provider as any,
      cfg: { skills: { dream: { minHours: 0, minSessions: 0, minMemories: 1 } } } as any,
      captureEvent: vi.fn(),
    });

    expect(outcome.processed).toBe(1);
    expect(outcome.result?.status).toBe("completed");
  });
});
