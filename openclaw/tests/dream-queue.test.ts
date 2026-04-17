import { beforeEach, describe, expect, it, vi } from "vitest";

const fileStore = new Map<string, string>();

vi.mock("../fs-safe.ts", () => ({
  exists: vi.fn((filePath: string) => fileStore.has(filePath)),
  mkdirp: vi.fn(),
  readText: vi.fn((filePath: string) => {
    const content = fileStore.get(filePath);
    if (content === undefined) throw new Error("ENOENT");
    return content;
  }),
  writeText: vi.fn((filePath: string, content: string) => {
    fileStore.set(filePath, content);
  }),
}));

import { exists, mkdirp, readText, writeText } from "../fs-safe.ts";
import {
  claimNextDreamJob,
  completeDreamJob,
  enqueueDreamJob,
  failDreamJob,
  listDreamJobs,
} from "../dream-queue.ts";

const mockExists = exists as ReturnType<typeof vi.fn>;
const mockMkdirp = mkdirp as ReturnType<typeof vi.fn>;
const mockReadText = readText as ReturnType<typeof vi.fn>;
const mockWriteText = writeText as ReturnType<typeof vi.fn>;

const STATE_DIR = "/tmp/test-state";

beforeEach(() => {
  vi.resetAllMocks();
  fileStore.clear();
  mockMkdirp.mockReturnValue(undefined);
  mockExists.mockImplementation((filePath: string) => fileStore.has(filePath));
  mockReadText.mockImplementation((filePath: string) => {
    const content = fileStore.get(filePath);
    if (content === undefined) throw new Error("ENOENT");
    return content;
  });
  mockWriteText.mockImplementation((filePath: string, content: string) => {
    fileStore.set(filePath, content);
  });
});

describe("dream-queue", () => {
  it("enqueues jobs and deduplicates active work in the same state dir", () => {
    const first = enqueueDreamJob(STATE_DIR, {
      userId: "user-1",
      sessionId: "session-1",
      stateDir: STATE_DIR,
      stateSource: "session",
      reason: "sessions_since=5",
      priority: 5,
    });

    const duplicate = enqueueDreamJob(STATE_DIR, {
      userId: "user-1",
      sessionId: "session-1",
      stateDir: STATE_DIR,
      stateSource: "session",
      reason: "sessions_since=6",
      priority: 6,
    });

    expect(first.enqueued).toBe(true);
    expect(first.job?.status).toBe("pending");
    expect(duplicate.enqueued).toBe(false);
    expect(duplicate.skippedReason).toBe("duplicate_pending_or_running_job");
    expect(listDreamJobs(STATE_DIR)).toHaveLength(1);
  });

  it("claims the highest priority job and marks it running", () => {
    fileStore.set(
      `${STATE_DIR}/dream-queue.json`,
      JSON.stringify(
        {
          version: 1,
          updatedAt: Date.now(),
          jobs: [
            {
              id: "job-low",
              userId: "user-1",
              stateDir: STATE_DIR,
              stateSource: "plugin",
              reason: "sessions_since=5",
              priority: 1,
              status: "pending",
              attempts: 0,
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: "job-high",
              userId: "user-1",
              stateDir: STATE_DIR,
              stateSource: "plugin",
              reason: "sessions_since=6",
              priority: 9,
              status: "pending",
              attempts: 0,
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        },
        null,
        2,
      ),
    );

    const claimed = claimNextDreamJob(STATE_DIR);
    expect(claimed?.priority).toBe(9);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);

    const completed = completeDreamJob(STATE_DIR, claimed!.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeDefined();
  });

  it("retries failed jobs and eventually marks them failed", () => {
    const first = enqueueDreamJob(STATE_DIR, {
      userId: "user-1",
      stateDir: STATE_DIR,
      stateSource: "runtime",
      reason: "sessions_since=7",
      priority: 3,
    });

    const claimed = claimNextDreamJob(STATE_DIR);
    expect(claimed?.id).toBe(first.job?.id);

    const retry = failDreamJob(STATE_DIR, claimed!.id, "temporary failure", 10, 3);
    expect(retry?.status).toBe("pending");
    expect(retry?.nextAttemptAt).toBeDefined();

    const failed = failDreamJob(STATE_DIR, claimed!.id, "permanent failure", 10, 1);
    expect(failed?.status).toBe("failed");
    expect(failed?.failedAt).toBeDefined();
  });
});
