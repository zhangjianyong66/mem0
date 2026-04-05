import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock better-sqlite3 for audit logger tests
vi.mock("better-sqlite3", () => {
  const mockDb = {
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      run: vi.fn(),
      all: vi.fn(() => []),
    })),
    close: vi.fn(),
  };
  return {
    default: vi.fn(() => mockDb),
  };
});

describe("AuditLogger", () => {
  let AuditLogger: typeof import("./providers.ts").AuditLogger;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./providers.ts");
    AuditLogger = mod.AuditLogger;
  });

  it("does nothing when disabled", async () => {
    const logger = new AuditLogger("/tmp/test.db", false);
    await logger.log({ operation: "search", user_id: "u1" });
    // Should not throw
  });

  it("does nothing when dbPath is undefined", async () => {
    const logger = new AuditLogger(undefined, true);
    await logger.log({ operation: "search", user_id: "u1" });
    // Should not throw
  });

  it("returns empty array when getRecent called without dbPath", async () => {
    const logger = new AuditLogger(undefined, true);
    const logs = await logger.getRecent();
    expect(logs).toEqual([]);
  });
});

describe("ConversationMemoryManager", () => {
  let ConversationMemoryManager: typeof import("./providers.ts").ConversationMemoryManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./providers.ts");
    ConversationMemoryManager = mod.ConversationMemoryManager;
  });

  it("stores and retrieves conversation memory", () => {
    const manager = new ConversationMemoryManager(60000);
    manager.set("conv-1", "test content");
    expect(manager.get("conv-1")).toBe("test content");
  });

  it("returns undefined for non-existent conversation", () => {
    const manager = new ConversationMemoryManager(60000);
    expect(manager.get("non-existent")).toBeUndefined();
  });

  it("clears specific conversation memory", () => {
    const manager = new ConversationMemoryManager(60000);
    manager.set("conv-1", "test content");
    manager.clear("conv-1");
    expect(manager.get("conv-1")).toBeUndefined();
  });

  it("clears all conversation memories", () => {
    const manager = new ConversationMemoryManager(60000);
    manager.set("conv-1", "content 1");
    manager.set("conv-2", "content 2");
    manager.clearAll();
    expect(manager.get("conv-1")).toBeUndefined();
    expect(manager.get("conv-2")).toBeUndefined();
  });

  it("expires memories after TTL", async () => {
    const manager = new ConversationMemoryManager(10); // 10ms TTL
    manager.set("conv-1", "test content");

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(manager.get("conv-1")).toBeUndefined();
  });

  it("getAll returns all active memories", () => {
    const manager = new ConversationMemoryManager(60000);
    manager.set("conv-1", "content 1");
    manager.set("conv-2", "content 2");

    const all = manager.getAll();
    expect(all.length).toBe(2);
  });
});