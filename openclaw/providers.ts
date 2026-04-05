/**
 * Mem0 provider implementations: Platform (cloud) and OSS (self-hosted).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  Mem0Config,
  Mem0Provider,
  MemoryItem,
  StoreRequest,
  SearchRequest,
  ListRequest,
  ScopeFilter,
  HistoryEntry,
  StoreResult,
  SearchResult,
} from "./types.ts";

// ============================================================================
// Result Normalizers
// ============================================================================

function normalizeMemoryItem(raw: any): MemoryItem {
  return {
    id: raw.id ?? raw.memory_id ?? "",
    memory: raw.memory ?? raw.text ?? raw.content ?? "",
    userId: raw.user_id ?? raw.userId,
    score: raw.score,
    categories: raw.categories,
    metadata: raw.metadata,
    createdAt: raw.created_at ?? raw.createdAt,
    updatedAt: raw.updated_at ?? raw.updatedAt,
  };
}

function normalizeSearchResults(raw: any): MemoryItem[] {
  if (Array.isArray(raw)) return raw.map(normalizeMemoryItem);
  if (raw?.results && Array.isArray(raw.results))
    return raw.results.map(normalizeMemoryItem);
  return [];
}

function normalizeStoreResult(raw: any): StoreResult {
  if (raw?.results && Array.isArray(raw.results)) {
    return {
      results: raw.results.map((r: any) => ({
        id: r.id ?? r.memory_id ?? "",
        memory: r.memory ?? r.text ?? "",
        event: r.event ?? r.metadata?.event ?? (r.status === "PENDING" ? "ADD" : "ADD"),
      })),
    };
  }
  if (Array.isArray(raw)) {
    return {
      results: raw.map((r: any) => ({
        id: r.id ?? r.memory_id ?? "",
        memory: r.memory ?? r.text ?? "",
        event: r.event ?? r.metadata?.event ?? (r.status === "PENDING" ? "ADD" : "ADD"),
      })),
    };
  }
  return { results: [] };
}

// ============================================================================
// Scope Filter Helpers
// ============================================================================

/**
 * Convert ScopeFilter to provider-specific parameters.
 */
function scopeToParams(scope: ScopeFilter): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  if (scope.userId) params.user_id = scope.userId;
  if (scope.sessionId) params.run_id = scope.sessionId;
  if (scope.orgId) params.org_id = scope.orgId;
  if (scope.appId) params.app_id = scope.appId;
  if (scope.conversationId) params.conversation_id = scope.conversationId;

  return params;
}

// ============================================================================
// Audit Logger
// ============================================================================

interface AuditLogEntry {
  id: string;
  operation: string;
  memoryId?: string;
  userId?: string;
  scopeType?: string;
  query?: string;
  resultCount?: number;
  metadata?: string;
  durationMs?: number;
}

/**
 * Audit logger for recording all memory operations.
 */
export class AuditLogger {
  private dbPath: string | undefined;
  private enabled: boolean;

  constructor(dbPath?: string, enabled: boolean = false) {
    this.dbPath = dbPath;
    this.enabled = enabled;
  }

  async log(entry: Omit<AuditLogEntry, "id">): Promise<void> {
    if (!this.enabled || !this.dbPath) return;

    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(this.dbPath);

      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id           TEXT PRIMARY KEY,
          operation    TEXT NOT NULL,
          memory_id    TEXT,
          user_id      TEXT,
          scope_type   TEXT,
          query        TEXT,
          result_count INTEGER,
          metadata     TEXT,
          created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
          duration_ms  INTEGER
        )
      `);

      const id = crypto.randomUUID();
      const stmt = db.prepare(`
        INSERT INTO audit_log (id, operation, memory_id, user_id, scope_type, query, result_count, metadata, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        entry.operation,
        entry.memoryId ?? null,
        entry.userId ?? null,
        entry.scopeType ?? null,
        entry.query ?? null,
        entry.resultCount ?? null,
        entry.metadata ?? null,
        entry.durationMs ?? null
      );

      db.close();
    } catch (err) {
      console.warn("[mem0] Audit log write failed:", err instanceof Error ? err.message : err);
    }
  }

  async getRecent(limit: number = 100): Promise<AuditLogEntry[]> {
    if (!this.dbPath) return [];

    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(this.dbPath);

      const stmt = db.prepare(`
        SELECT id, operation, memory_id, user_id, scope_type, query, result_count, metadata, created_at, duration_ms
        FROM audit_log
        ORDER BY created_at DESC
        LIMIT ?
      `);

      const rows = stmt.all(limit) as AuditLogEntry[];
      db.close();
      return rows;
    } catch {
      return [];
    }
  }
}

// ============================================================================
// Conversation Memory Manager
// ============================================================================

interface ConversationMemory {
  content: string;
  timestamp: number;
  conversationId: string;
}

/**
 * Manages conversation-scoped temporary memories (in-memory only).
 */
export class ConversationMemoryManager {
  private cache: Map<string, ConversationMemory> = new Map();
  private ttl: number;

  constructor(ttl: number = 60000) {
    this.ttl = ttl;
    setInterval(() => this.cleanup(), ttl);
  }

  set(conversationId: string, content: string): void {
    this.cache.set(conversationId, {
      content,
      timestamp: Date.now(),
      conversationId,
    });
  }

  get(conversationId: string): string | undefined {
    const memory = this.cache.get(conversationId);
    if (!memory) return undefined;

    if (Date.now() - memory.timestamp > this.ttl) {
      this.cache.delete(conversationId);
      return undefined;
    }

    return memory.content;
  }

  clear(conversationId: string): void {
    this.cache.delete(conversationId);
  }

  clearAll(): void {
    this.cache.clear();
  }

  getAll(): ConversationMemory[] {
    this.cleanup();
    return Array.from(this.cache.values());
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, memory] of this.cache.entries()) {
      if (now - memory.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }
}

// ============================================================================
// Platform Provider (Mem0 Cloud)
// ============================================================================

class PlatformProvider implements Mem0Provider {
  private client: any;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly projectId?: string,
  ) {}

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const { default: MemoryClient } = await import("mem0ai");
    const opts: { apiKey: string; project_id?: string } = { apiKey: this.apiKey };
    if (this.projectId) opts.project_id = this.projectId;
    this.client = new MemoryClient(opts);
  }

  async add(request: StoreRequest): Promise<StoreResult> {
    await this.ensureClient();

    const params: Record<string, unknown> = {
      ...scopeToParams(request.scope),
      output_format: "v1.1",
    };

    // Store each fact
    const results: Array<{ id: string; memory: string; event: "ADD" | "UPDATE" | "DELETE" | "NOOP" }> = [];

    for (const fact of request.facts) {
      const result = await this.client.add(
        [{ role: "user", content: fact }],
        params
      );

      if (result?.results) {
        for (const r of result.results) {
          results.push({
            id: r.id ?? r.memory_id ?? "",
            memory: r.memory ?? fact,
            event: r.event ?? "ADD",
          });
        }
      } else if (Array.isArray(result)) {
        for (const r of result) {
          results.push({
            id: r.id ?? r.memory_id ?? "",
            memory: r.memory ?? fact,
            event: r.event ?? "ADD",
          });
        }
      }
    }

    return { results };
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    await this.ensureClient();

    const params: Record<string, unknown> = {
      api_version: "v2",
      filters: scopeToParams(request.scope),
    };

    if (request.options?.limit) params.top_k = request.options.limit;
    if (request.options?.threshold) params.threshold = request.options.threshold;
    if (request.options?.categories) params.categories = request.options.categories;
    if (request.options?.keywordSearch) params.keyword_search = request.options.keywordSearch;
    if (request.options?.rerank) params.rerank = request.options.rerank;

    const results = await this.client.search(request.query, params);
    return { results: normalizeSearchResults(results) };
  }

  async get(id: string): Promise<MemoryItem> {
    await this.ensureClient();
    const result = await this.client.get(id);
    return normalizeMemoryItem(result);
  }

  async update(id: string, data: { text: string; metadata?: Record<string, unknown> }): Promise<void> {
    await this.ensureClient();
    await this.client.update(id, { text: data.text, metadata: data.metadata });
  }

  async delete(id: string): Promise<void> {
    await this.ensureClient();
    await this.client.delete(id);
  }

  async list(request: ListRequest): Promise<MemoryItem[]> {
    await this.ensureClient();

    const params: Record<string, unknown> = {
      ...scopeToParams(request.scope),
    };

    if (request.limit) params.page_size = request.limit;

    const results = await this.client.getAll(params);
    if (Array.isArray(results)) return results.map(normalizeMemoryItem);
    if (results?.results) return results.results.map(normalizeMemoryItem);
    return [];
  }

  async deleteAll(scope: ScopeFilter): Promise<void> {
    await this.ensureClient();
    const params = scopeToParams(scope);
    await this.client.deleteAll(params);
  }

  async history(id: string): Promise<HistoryEntry[]> {
    await this.ensureClient();
    const result = await this.client.history(id);
    return Array.isArray(result) ? result.map((h: any) => ({
      id: h.id,
      oldMemory: h.old_memory,
      newMemory: h.new_memory,
      event: h.event,
      createdAt: h.created_at,
    })) : [];
  }
}

// ============================================================================
// Open-Source Provider (Self-hosted)
// ============================================================================

class OSSProvider implements Mem0Provider {
  private memory: any;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly ossConfig?: Mem0Config["oss"],
    private readonly resolvePath?: (p: string) => string,
  ) {}

  private async ensureMemory(): Promise<void> {
    if (this.memory) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const { Memory } = await import("mem0ai/oss");

    const config: Record<string, unknown> = { version: "v1.1" };

    if (this.ossConfig?.embedder) config.embedder = this.ossConfig.embedder;
    if (this.ossConfig?.vectorStore) config.vectorStore = this.ossConfig.vectorStore;
    if (this.ossConfig?.llm) config.llm = this.ossConfig.llm;

    if (this.ossConfig?.historyDbPath) {
      const dbPath = this.resolvePath
        ? this.resolvePath(this.ossConfig.historyDbPath)
        : this.ossConfig.historyDbPath;
      config.historyDbPath = dbPath;
    }

    if (this.ossConfig?.disableHistory) {
      config.disableHistory = true;
    }

    try {
      this.memory = new Memory(config);
    } catch (err) {
      if (!config.disableHistory) {
        console.warn(
          "[mem0] Memory initialization failed, retrying with history disabled:",
          err instanceof Error ? err.message : err,
        );
        config.disableHistory = true;
        this.memory = new Memory(config);
      } else {
        throw err;
      }
    }
  }

  private scopeToOSSParams(scope: ScopeFilter): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    if (scope.userId) params.userId = scope.userId;
    if (scope.sessionId) params.runId = scope.sessionId;
    return params;
  }

  async add(request: StoreRequest): Promise<StoreResult> {
    await this.ensureMemory();

    const params = this.scopeToOSSParams(request.scope);
    const results: Array<{ id: string; memory: string; event: "ADD" | "UPDATE" | "DELETE" | "NOOP" }> = [];

    for (const fact of request.facts) {
      const result = await this.memory.add(
        [{ role: "user", content: fact }],
        params
      );

      if (result?.results) {
        for (const r of result.results) {
          results.push({
            id: r.id ?? "",
            memory: r.memory ?? fact,
            event: r.event ?? "ADD",
          });
        }
      }
    }

    return { results };
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    await this.ensureMemory();

    const params: Record<string, unknown> = this.scopeToOSSParams(request.scope);
    if (request.options?.limit) params.limit = request.options.limit;
    if (request.options?.threshold) params.threshold = request.options.threshold;

    const results = await this.memory.search(request.query, params);
    let items = normalizeSearchResults(results);

    // Client-side threshold filtering
    if (request.options?.threshold) {
      items = items.filter(item => (item.score ?? 0) >= request.options!.threshold!);
    }

    return { results: items };
  }

  async get(id: string): Promise<MemoryItem> {
    await this.ensureMemory();
    const result = await this.memory.get(id);
    return normalizeMemoryItem(result);
  }

  async update(id: string, data: { text: string; metadata?: Record<string, unknown> }): Promise<void> {
    await this.ensureMemory();
    await this.memory.update(id, { data: data.text, metadata: data.metadata });
  }

  async delete(id: string): Promise<void> {
    await this.ensureMemory();
    await this.memory.delete(id);
  }

  async list(request: ListRequest): Promise<MemoryItem[]> {
    await this.ensureMemory();

    const params = this.scopeToOSSParams(request.scope);
    if (request.limit) params.limit = request.limit;

    const results = await this.memory.getAll(params);
    if (Array.isArray(results)) return results.map(normalizeMemoryItem);
    if (results?.results) return results.results.map(normalizeMemoryItem);
    return [];
  }

  async deleteAll(scope: ScopeFilter): Promise<void> {
    await this.ensureMemory();
    const params = this.scopeToOSSParams(scope);
    await this.memory.deleteAll(params);
  }

  async history(id: string): Promise<HistoryEntry[]> {
    await this.ensureMemory();
    try {
      const result = await this.memory.history(id);
      return Array.isArray(result) ? result.map((h: any) => ({
        id: h.id,
        oldMemory: h.old_memory,
        newMemory: h.new_memory,
        event: h.event,
        createdAt: h.created_at,
      })) : [];
    } catch {
      return [];
    }
  }
}

// ============================================================================
// Provider Factory
// ============================================================================

export function createProvider(
  cfg: Mem0Config,
  api: OpenClawPluginApi,
): { provider: Mem0Provider; auditLogger: AuditLogger; conversationManager: ConversationMemoryManager } {
  const auditDbPath = cfg.oss?.historyDbPath
    ? api.resolvePath(cfg.oss.historyDbPath)
    : undefined;

  const auditLogger = new AuditLogger(auditDbPath, cfg.features.auditLog);
  const conversationManager = new ConversationMemoryManager();

  let provider: Mem0Provider;

  if (cfg.mode === "open-source") {
    provider = new OSSProvider(cfg.oss, (p) => api.resolvePath(p));
  } else {
    provider = new PlatformProvider(cfg.apiKey!, cfg.projectId);
  }

  return { provider, auditLogger, conversationManager };
}