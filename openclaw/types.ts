/**
 * Type definitions for the OpenClaw Mem0 plugin.
 *
 * Memory Architecture (per official Mem0 spec):
 * - Conversation: Single turn, in-memory only
 * - Session: Minutes to hours, identified by sessionId
 * - User: Weeks to permanent, identified by userId
 * - Organization: Global shared, identified by orgId/appId
 */

// ============================================================================
// Memory Scope Types
// ============================================================================

/**
 * Memory scope levels matching official Mem0 architecture.
 */
export type MemoryScope =
  | "conversation"    // Single turn, in-memory only
  | "session"         // Minutes to hours, sessionId
  | "user"            // Weeks to permanent, userId
  | "organization"    // Global shared, orgId/appId
  | "all";

/**
 * Scope filter for identifying which memories to operate on.
 */
export interface ScopeFilter {
  /** Memory scope level */
  type: MemoryScope;
  /** User ID - required for user/session scope */
  userId?: string;
  /** Session ID - required for session scope */
  sessionId?: string;
  /** Conversation ID - for conversation scope */
  conversationId?: string;
  /** Organization ID - for organization scope */
  orgId?: string;
  /** Application ID - optional subdivision within organization */
  appId?: string;
}

// ============================================================================
// Request/Response Types
// ============================================================================

/**
 * Search request for querying memories.
 */
export interface SearchRequest {
  /** Search query string */
  query: string;
  /** Scope filter identifying which memories to search */
  scope: ScopeFilter;
  /** Search options */
  options?: SearchOptions;
}

/**
 * Search options for fine-tuning search behavior.
 */
export interface SearchOptions {
  /** Maximum number of results (default: 5) */
  limit?: number;
  /** Minimum similarity threshold 0-1 (default: 0.5) */
  threshold?: number;
  /** Filter by categories */
  categories?: string[];
  /** Advanced filters with operators */
  filters?: Record<string, unknown>;
  /** Enable keyword search expansion */
  keywordSearch?: boolean;
  /** Enable reranking for better relevance */
  rerank?: boolean;
}

/**
 * Store request for saving new memories.
 */
export interface StoreRequest {
  /** Facts to store (required) */
  facts: string[];
  /** Scope filter identifying where to store */
  scope: ScopeFilter;
  /** Memory category (determines retention policy) */
  category?: string;
  /** Importance score 0-1 */
  importance?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * List request for retrieving memories.
 */
export interface ListRequest {
  /** Scope filter */
  scope: ScopeFilter;
  /** Maximum number of results */
  limit?: number;
}

/**
 * Single memory item.
 */
export interface MemoryItem {
  id: string;
  memory: string;
  userId?: string;
  score?: number;
  categories?: string[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Result from a store operation.
 */
export interface StoreResult {
  results: Array<{
    id: string;
    memory: string;
    event: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  }>;
}

/**
 * Result from a search operation.
 */
export interface SearchResult {
  results: MemoryItem[];
}

/**
 * History entry for a memory.
 */
export interface HistoryEntry {
  id: string;
  oldMemory: string;
  newMemory: string;
  event: string;
  createdAt: string;
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Memory provider interface for both Platform and OSS modes.
 */
export interface Mem0Provider {
  /** Store new memories */
  add(request: StoreRequest): Promise<StoreResult>;
  /** Search memories */
  search(request: SearchRequest): Promise<SearchResult>;
  /** Get a single memory by ID */
  get(id: string): Promise<MemoryItem>;
  /** Update a memory */
  update(id: string, data: { text: string; metadata?: Record<string, unknown> }): Promise<void>;
  /** Delete a memory */
  delete(id: string): Promise<void>;
  /** List memories */
  list(request: ListRequest): Promise<MemoryItem[]>;
  /** Delete all memories matching scope */
  deleteAll(scope: ScopeFilter): Promise<void>;
  /** Get history for a memory */
  history(id: string): Promise<HistoryEntry[]>;
}

// ============================================================================
// Configuration Types
// ============================================================================

export type Mem0Mode = "platform" | "open-source";

/**
 * Features configuration.
 */
export interface FeaturesConfig {
  /** Auto-inject memories before each agent turn */
  autoRecall: boolean;
  /** Auto-capture facts after each agent turn */
  autoCapture: boolean;
  /** Record audit log for all operations */
  auditLog: boolean;
  /** Enable graph storage for entity relationships */
  graph: boolean;
}

/**
 * Default scope configuration.
 */
export interface DefaultScopeConfig {
  /** User ID (required) */
  userId: string;
  /** Organization ID (optional) */
  orgId?: string;
  /** Application ID (optional) */
  appId?: string;
}

/**
 * OSS-specific configuration.
 */
export interface OSSConfig {
  embedder?: { provider: string; config: Record<string, unknown> };
  vectorStore?: { provider: string; config: Record<string, unknown> };
  llm?: { provider: string; config: Record<string, unknown> };
  historyDbPath?: string;
  disableHistory?: boolean;
}

/**
 * Main plugin configuration.
 */
export type Mem0Config = {
  /** Operation mode */
  mode: Mem0Mode;
  /** API key for platform mode */
  apiKey?: string;
  /** Project ID for platform mode */
  projectId?: string;
  /** Default scope configuration */
  defaultScope: DefaultScopeConfig;
  /** Feature toggles */
  features: FeaturesConfig;
  /** Custom instructions for memory extraction */
  customInstructions?: string;
  /** Custom categories */
  customCategories?: Record<string, string>;
  /** OSS configuration */
  oss?: OSSConfig;
  /** Skills configuration */
  skills?: SkillsConfig;
  /** Search threshold (default: 0.5) */
  searchThreshold?: number;
  /** Default result limit (default: 5) */
  topK?: number;
  /** Setup state indicator */
  needsSetup?: boolean;
};

// ============================================================================
// Skills Configuration Types
// ============================================================================

export interface CategoryConfig {
  importance: number;
  ttl: string | null;
  immutable?: boolean;
}

export interface SkillsConfig {
  triage?: {
    enabled?: boolean;
    importanceThreshold?: number;
    enableGraph?: boolean;
    credentialPatterns?: string[];
  };
  recall?: {
    enabled?: boolean;
    strategy?: "always" | "smart" | "manual";
    tokenBudget?: number;
    maxMemories?: number;
    rerank?: boolean;
    keywordSearch?: boolean;
    filterMemories?: boolean;
    threshold?: number;
    identityAlwaysInclude?: boolean;
    categoryOrder?: string[];
  };
  dream?: {
    enabled?: boolean;
    auto?: boolean;
    minHours?: number;
    minSessions?: number;
    minMemories?: number;
  };
  domain?: string;
  customRules?: {
    include?: string[];
    exclude?: string[];
  };
  categories?: Record<string, CategoryConfig>;
}