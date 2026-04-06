/**
 * OpenClaw Memory (Mem0) Plugin
 *
 * Long-term memory via Mem0 — supports both the Mem0 platform
 * and the open-source self-hosted SDK.
 *
 * Memory Architecture:
 * - Conversation: Single turn, in-memory only
 * - Session: Minutes to hours, sessionId
 * - User: Weeks to permanent, userId
 * - Organization: Global shared, orgId/appId
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type {
  Mem0Config,
  Mem0Provider,
  MemoryItem,
  MemoryScope,
  ScopeFilter,
  SearchRequest,
  StoreRequest,
  ListRequest,
} from "./types.ts";
import { createProvider, AuditLogger, ConversationMemoryManager } from "./providers.ts";
import { mem0ConfigSchema } from "./config.ts";
import {
  effectiveUserId,
  agentUserId,
  resolveUserId,
  isNonInteractiveTrigger,
  isSubagentSession,
} from "./isolation.ts";
import {
  filterMessagesForExtraction,
} from "./filtering.ts";
import {
  loadTriagePrompt,
  loadDreamPrompt,
  resolveCategories,
  ttlToExpirationDate,
  isSkillsMode,
} from "./skill-loader.ts";
import { recall as skillRecall, sanitizeQuery } from "./recall.ts";
import {
  incrementSessionCount,
  checkCheapGates,
  checkMemoryGate,
  acquireDreamLock,
  releaseDreamLock,
  recordDreamCompletion,
} from "./dream-gate.ts";

// ============================================================================
// Re-exports
// ============================================================================

export {
  extractAgentId,
  effectiveUserId,
  agentUserId,
  resolveUserId,
  isNonInteractiveTrigger,
  isSubagentSession,
} from "./isolation.ts";
export {
  isNoiseMessage,
  isGenericAssistantMessage,
  stripNoiseFromContent,
  filterMessagesForExtraction,
} from "./filtering.ts";
export { mem0ConfigSchema } from "./config.ts";
export { createProvider, AuditLogger, ConversationMemoryManager } from "./providers.ts";

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "openclaw-mem0",
  name: "Memory (Mem0)",
  description: "Mem0 memory backend — Mem0 platform or self-hosted open-source",
  kind: "memory" as const,
  configSchema: mem0ConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = mem0ConfigSchema.parse(api.pluginConfig);

    if (cfg.needsSetup) {
      api.logger.warn(
        "openclaw-mem0: API key not configured. Memory features are disabled.\n" +
        "  To set up, run:\n" +
        '  openclaw config set plugins.entries.openclaw-mem0.config.apiKey "m0-your-key"\n' +
        "  openclaw gateway restart\n" +
        "  Get your key at: https://app.mem0.ai/dashboard/api-keys"
      );
      api.registerService({
        id: "openclaw-mem0",
        start: () => { api.logger.info("openclaw-mem0: waiting for API key configuration"); },
        stop: () => {},
      });
      return;
    }

    const { provider, auditLogger, conversationManager } = createProvider(cfg, api);

    // Track current session ID for tool-level scoping
    let currentSessionId: string | undefined;

    // Scope helpers
    const _effectiveUserId = (sessionKey?: string) =>
      effectiveUserId(cfg.defaultScope.userId, sessionKey);
    const _agentUserId = (id: string) => agentUserId(cfg.defaultScope.userId, id);

    const skillsActive = isSkillsMode(cfg.skills);
    api.logger.info(
      `openclaw-mem0: registered (mode: ${cfg.mode}, user: ${cfg.defaultScope.userId}, features: ${JSON.stringify(cfg.features)}, skills: ${skillsActive})`,
    );

    // ========================================================================
    // Tools
    // ========================================================================

    registerTools(
      api,
      provider,
      cfg,
      auditLogger,
      conversationManager,
      () => currentSessionId,
      skillsActive,
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    registerCli(api, provider, cfg, _effectiveUserId, _agentUserId, () => currentSessionId);

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    registerHooks(
      api,
      provider,
      cfg,
      _effectiveUserId,
      {
        setCurrentSessionId: (id: string) => { currentSessionId = id; },
        getStateDir: () => pluginStateDir,
      },
      skillsActive,
    );

    // ========================================================================
    // Service
    // ========================================================================

    let pluginStateDir: string | undefined;

    api.registerService({
      id: "openclaw-mem0",
      start: (...args: any[]) => {
        pluginStateDir = args[0]?.stateDir;
        api.logger.info(
          `openclaw-mem0: initialized (mode: ${cfg.mode}, user: ${cfg.defaultScope.userId}, features: ${JSON.stringify(cfg.features)}, stateDir: ${pluginStateDir ?? "none"})`,
        );
      },
      stop: () => {
        api.logger.info("openclaw-mem0: stopped");
      },
    });
  },
};

// ============================================================================
// Tool Registration
// ============================================================================

function registerTools(
  api: OpenClawPluginApi,
  provider: Mem0Provider,
  cfg: Mem0Config,
  auditLogger: AuditLogger,
  conversationManager: ConversationMemoryManager,
  getCurrentSessionId: () => string | undefined,
  skillsActive: boolean = false,
): void {
  // ========================================================================
  // memory_search
  // ========================================================================

  api.registerTool(
    {
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search through memories stored in Mem0. Use when you need context about user preferences, past decisions, or previously discussed topics.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        scope: Type.Optional(
          Type.Union([
            Type.Literal("conversation"),
            Type.Literal("session"),
            Type.Literal("user"),
            Type.Literal("organization"),
            Type.Literal("all"),
          ], {
            description: 'Memory scope: "conversation", "session", "user", "organization", or "all". Default: "user"',
          }),
        ),
        userId: Type.Optional(Type.String({ description: "User ID (default: configured userId)" })),
        sessionId: Type.Optional(Type.String({ description: "Session ID for session scope" })),
        conversationId: Type.Optional(Type.String({ description: "Conversation ID for conversation scope" })),
        orgId: Type.Optional(Type.String({ description: "Organization ID for organization scope" })),
        appId: Type.Optional(Type.String({ description: "Application ID" })),
        limit: Type.Optional(Type.Number({ description: `Max results (default: ${cfg.topK})` })),
        categories: Type.Optional(Type.Array(Type.String(), { description: "Filter by categories" })),
        filters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Advanced filters" })),
      }),
      async execute(_toolCallId, params) {
        const {
          query,
          scope = "user",
          userId,
          sessionId,
          conversationId,
          orgId,
          appId,
          limit,
          categories,
          filters,
        } = params as {
          query: string;
          scope?: MemoryScope;
          userId?: string;
          sessionId?: string;
          conversationId?: string;
          orgId?: string;
          appId?: string;
          limit?: number;
          categories?: string[];
          filters?: Record<string, unknown>;
        };

        const currentSessionId = getCurrentSessionId();
        const effectiveUserId = userId ?? cfg.defaultScope.userId;
        const effectiveOrgId = orgId ?? cfg.defaultScope.orgId;
        const effectiveAppId = appId ?? cfg.defaultScope.appId;

        // Build scope filter
        const scopeFilter: ScopeFilter = {
          type: scope,
          userId: effectiveUserId,
          sessionId: sessionId ?? (scope === "session" ? currentSessionId : undefined),
          conversationId,
          orgId: effectiveOrgId,
          appId: effectiveAppId,
        };

        // Handle conversation scope (in-memory only)
        if (scope === "conversation" && conversationId) {
          const content = conversationManager.get(conversationId);
          if (content) {
            return {
              content: [{ type: "text", text: `Conversation memory: ${content}` }],
              details: { count: 1, scope: "conversation" },
            };
          }
          return {
            content: [{ type: "text", text: "No conversation memory found." }],
            details: { count: 0, scope: "conversation" },
          };
        }

        try {
          const startTime = Date.now();

          const searchRequest: SearchRequest = {
            query,
            scope: scopeFilter,
            options: {
              limit: limit ?? cfg.topK,
              threshold: cfg.searchThreshold,
              categories,
              filters,
            },
          };

          const result = await provider.search(searchRequest);

          const duration = Date.now() - startTime;
          await auditLogger.log({
            operation: "search",
            userId: effectiveUserId,
            scopeType: scope,
            query,
            resultCount: result.results.length,
            durationMs: duration,
          });

          if (!result.results.length) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const text = result.results
            .map((r, i) => `${i + 1}. ${r.memory} (score: ${((r.score ?? 0) * 100).toFixed(0)}%, id: ${r.id})`)
            .join("\n");

          return {
            content: [{ type: "text", text: `Found ${result.results.length} memories:\n\n${text}` }],
            details: { count: result.results.length, memories: result.results },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Memory search failed: ${String(err)}` }],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_search" },
  );

  // ========================================================================
  // memory_store
  // ========================================================================

  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in memory via Mem0. Use for preferences, facts, decisions, and anything worth remembering.",
      parameters: Type.Object({
        facts: Type.Array(Type.String(), {
          description: "Facts to store. All facts in one call share the same category and scope.",
        }),
        scope: Type.Optional(
          Type.Union([
            Type.Literal("conversation"),
            Type.Literal("session"),
            Type.Literal("user"),
            Type.Literal("organization"),
          ], {
            description: 'Memory scope. Default: "user"',
          }),
        ),
        userId: Type.Optional(Type.String({ description: "User ID (default: configured userId)" })),
        sessionId: Type.Optional(Type.String({ description: "Session ID for session scope" })),
        conversationId: Type.Optional(Type.String({ description: "Conversation ID for conversation scope" })),
        orgId: Type.Optional(Type.String({ description: "Organization ID for organization scope" })),
        appId: Type.Optional(Type.String({ description: "Application ID" })),
        category: Type.Optional(Type.String({ description: "Memory category" })),
        importance: Type.Optional(Type.Number({ description: "Importance score 0-1" })),
      }),
      async execute(_toolCallId, params) {
        const {
          facts,
          scope = "user",
          userId,
          sessionId,
          conversationId,
          orgId,
          appId,
          category,
          importance,
        } = params as {
          facts: string[];
          scope?: MemoryScope;
          userId?: string;
          sessionId?: string;
          conversationId?: string;
          orgId?: string;
          appId?: string;
          category?: string;
          importance?: number;
        };

        if (!facts.length) {
          return {
            content: [{ type: "text", text: "No facts provided." }],
            details: { error: "missing_facts" },
          };
        }

        const currentSessionId = getCurrentSessionId();

        // Block subagent writes
        if (isSubagentSession(currentSessionId)) {
          api.logger.warn("openclaw-mem0: blocked memory_store from subagent session");
          return {
            content: [{ type: "text", text: "Memory storage is not available in subagent sessions." }],
            details: { error: "subagent_blocked" },
          };
        }

        const effectiveUserId = userId ?? cfg.defaultScope.userId;
        const effectiveOrgId = orgId ?? cfg.defaultScope.orgId;
        const effectiveAppId = appId ?? cfg.defaultScope.appId;

        // Handle conversation scope (in-memory only)
        if (scope === "conversation" && conversationId) {
          conversationManager.set(conversationId, facts.join("\n"));
          return {
            content: [{ type: "text", text: `Stored ${facts.length} fact(s) in conversation memory.` }],
            details: { count: facts.length, scope: "conversation" },
          };
        }

        // Build scope filter
        const scopeFilter: ScopeFilter = {
          type: scope,
          userId: effectiveUserId,
          sessionId: sessionId ?? (scope === "session" ? currentSessionId : undefined),
          conversationId,
          orgId: effectiveOrgId,
          appId: effectiveAppId,
        };

        try {
          const startTime = Date.now();

          const storeRequest: StoreRequest = {
            facts,
            scope: scopeFilter,
            category,
            importance,
          };

          const result = await provider.add(storeRequest);

          const duration = Date.now() - startTime;
          await auditLogger.log({
            operation: "add",
            userId: effectiveUserId,
            scopeType: scope,
            resultCount: result.results.length,
            durationMs: duration,
          });

          return {
            content: [{ type: "text", text: `Stored ${facts.length} fact(s). ${result.results.length} memory operation(s).` }],
            details: { count: facts.length, results: result.results },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Memory store failed: ${String(err)}` }],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_store" },
  );

  // ========================================================================
  // memory_list
  // ========================================================================

  api.registerTool(
    {
      name: "memory_list",
      label: "Memory List",
      description: "List all stored memories for a scope.",
      parameters: Type.Object({
        scope: Type.Optional(
          Type.Union([
            Type.Literal("conversation"),
            Type.Literal("session"),
            Type.Literal("user"),
            Type.Literal("organization"),
            Type.Literal("all"),
          ], {
            description: 'Memory scope. Default: "user"',
          }),
        ),
        userId: Type.Optional(Type.String({ description: "User ID" })),
        sessionId: Type.Optional(Type.String({ description: "Session ID" })),
        conversationId: Type.Optional(Type.String({ description: "Conversation ID" })),
        orgId: Type.Optional(Type.String({ description: "Organization ID" })),
        appId: Type.Optional(Type.String({ description: "Application ID" })),
        limit: Type.Optional(Type.Number({ description: "Max results" })),
      }),
      async execute(_toolCallId, params) {
        const {
          scope = "user",
          userId,
          sessionId,
          conversationId,
          orgId,
          appId,
          limit,
        } = params as {
          scope?: MemoryScope;
          userId?: string;
          sessionId?: string;
          conversationId?: string;
          orgId?: string;
          appId?: string;
          limit?: number;
        };

        const currentSessionId = getCurrentSessionId();
        const effectiveUserId = userId ?? cfg.defaultScope.userId;

        // Handle conversation scope
        if (scope === "conversation" && conversationId) {
          const content = conversationManager.get(conversationId);
          if (content) {
            return {
              content: [{ type: "text", text: `1. ${content}` }],
              details: { count: 1 },
            };
          }
          return {
            content: [{ type: "text", text: "No conversation memories." }],
            details: { count: 0 },
          };
        }

        try {
          const scopeFilter: ScopeFilter = {
            type: scope,
            userId: effectiveUserId,
            sessionId: sessionId ?? currentSessionId,
            conversationId,
            orgId: orgId ?? cfg.defaultScope.orgId,
            appId: appId ?? cfg.defaultScope.appId,
          };

          const listRequest: ListRequest = {
            scope: scopeFilter,
            limit: limit ?? 100,
          };

          const memories = await provider.list(listRequest);

          if (!memories.length) {
            return {
              content: [{ type: "text", text: "No memories stored yet." }],
              details: { count: 0 },
            };
          }

          const text = memories
            .map((r, i) => `${i + 1}. ${r.memory} (id: ${r.id})`)
            .join("\n");

          return {
            content: [{ type: "text", text: `${memories.length} memories:\n\n${text}` }],
            details: { count: memories.length, memories },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Memory list failed: ${String(err)}` }],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_list" },
  );

  // ========================================================================
  // memory_get
  // ========================================================================

  api.registerTool(
    {
      name: "memory_get",
      label: "Memory Get",
      description: "Retrieve a specific memory by ID.",
      parameters: Type.Object({
        memoryId: Type.String({ description: "Memory ID" }),
      }),
      async execute(_toolCallId, params) {
        const { memoryId } = params as { memoryId: string };

        try {
          const memory = await provider.get(memoryId);

          return {
            content: [{
              type: "text",
              text: `Memory ${memory.id}:\n${memory.memory}\n\nCreated: ${memory.createdAt ?? "unknown"}`,
            }],
            details: { memory },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Memory get failed: ${String(err)}` }],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_get" },
  );

  // ========================================================================
  // memory_forget
  // ========================================================================

  api.registerTool(
    {
      name: "memory_forget",
      label: "Memory Forget",
      description: "Delete a memory by ID or query.",
      parameters: Type.Object({
        memoryId: Type.Optional(Type.String({ description: "Memory ID to delete" })),
        query: Type.Optional(Type.String({ description: "Search query to find memory to delete" })),
      }),
      async execute(_toolCallId, params) {
        const { memoryId, query } = params as { memoryId?: string; query?: string };

        const currentSessionId = getCurrentSessionId();
        if (isSubagentSession(currentSessionId)) {
          return {
            content: [{ type: "text", text: "Memory deletion is not available in subagent sessions." }],
            details: { error: "subagent_blocked" },
          };
        }

        try {
          if (memoryId) {
            await provider.delete(memoryId);
            await auditLogger.log({ operation: "delete", memoryId });
            return {
              content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
              details: { action: "deleted", id: memoryId },
            };
          }

          if (query) {
            const searchResult = await provider.search({
              query,
              scope: { type: "user", userId: cfg.defaultScope.userId },
              options: { limit: 5 },
            });

            if (!searchResult.results.length) {
              return {
                content: [{ type: "text", text: "No matching memories found." }],
                details: { found: 0 },
              };
            }

            // Delete highest confidence match
            if (searchResult.results.length === 1 || (searchResult.results[0]?.score ?? 0) > 0.9) {
              const match = searchResult.results[0];
              await provider.delete(match.id);
              await auditLogger.log({ operation: "delete", memoryId: match.id, query });
              return {
                content: [{ type: "text", text: `Forgotten: "${match.memory}"` }],
                details: { action: "deleted", id: match.id },
              };
            }

            // Multiple candidates
            const list = searchResult.results
              .map((r) => `- [${r.id}] ${r.memory.slice(0, 80)}... (score: ${((r.score ?? 0) * 100).toFixed(0)}%)`)
              .join("\n");

            return {
              content: [{ type: "text", text: `Found ${searchResult.results.length} candidates. Specify memoryId:\n${list}` }],
              details: { action: "candidates", candidates: searchResult.results },
            };
          }

          return {
            content: [{ type: "text", text: "Provide memoryId or query." }],
            details: { error: "missing_param" },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Memory forget failed: ${String(err)}` }],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_forget" },
  );

  // ========================================================================
  // memory_update
  // ========================================================================

  api.registerTool(
    {
      name: "memory_update",
      label: "Memory Update",
      description: "Update an existing memory's text.",
      parameters: Type.Object({
        memoryId: Type.String({ description: "Memory ID to update" }),
        text: Type.String({ description: "New text for the memory" }),
      }),
      async execute(_toolCallId, params) {
        const { memoryId, text } = params as { memoryId: string; text: string };

        const currentSessionId = getCurrentSessionId();
        if (isSubagentSession(currentSessionId)) {
          return {
            content: [{ type: "text", text: "Memory update is not available in subagent sessions." }],
            details: { error: "subagent_blocked" },
          };
        }

        try {
          await provider.update(memoryId, { text });
          await auditLogger.log({ operation: "update", memoryId });

          return {
            content: [{ type: "text", text: `Updated memory ${memoryId}.` }],
            details: { action: "updated", id: memoryId },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Memory update failed: ${String(err)}` }],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_update" },
  );

  // ========================================================================
  // memory_delete_all
  // ========================================================================

  api.registerTool(
    {
      name: "memory_delete_all",
      label: "Memory Delete All",
      description: "Delete ALL memories. Use with extreme caution.",
      parameters: Type.Object({
        confirm: Type.Boolean({ description: "Must be true to proceed." }),
        scope: Type.Optional(Type.String({ description: "Scope to delete (user, session, organization)" })),
      }),
      async execute(_toolCallId, params) {
        const { confirm, scope = "user" } = params as { confirm: boolean; scope?: string };

        const currentSessionId = getCurrentSessionId();
        if (isSubagentSession(currentSessionId)) {
          return {
            content: [{ type: "text", text: "Bulk deletion is not available in subagent sessions." }],
            details: { error: "subagent_blocked" },
          };
        }

        if (!confirm) {
          return {
            content: [{ type: "text", text: "Bulk deletion requires confirm: true." }],
            details: { error: "confirmation_required" },
          };
        }

        try {
          const scopeFilter: ScopeFilter = {
            type: scope as MemoryScope,
            userId: cfg.defaultScope.userId,
            sessionId: currentSessionId,
            orgId: cfg.defaultScope.orgId,
            appId: cfg.defaultScope.appId,
          };

          await provider.deleteAll(scopeFilter);
          await auditLogger.log({ operation: "deleteAll", userId: cfg.defaultScope.userId, scopeType: scope });

          return {
            content: [{ type: "text", text: `All memories deleted for scope "${scope}".` }],
            details: { action: "deleted_all", scope },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Bulk deletion failed: ${String(err)}` }],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_delete_all" },
  );

  // ========================================================================
  // memory_history
  // ========================================================================

  api.registerTool(
    {
      name: "memory_history",
      label: "Memory History",
      description: "View edit history of a memory.",
      parameters: Type.Object({
        memoryId: Type.String({ description: "Memory ID" }),
      }),
      async execute(_toolCallId, params) {
        const { memoryId } = params as { memoryId: string };

        try {
          const history = await provider.history(memoryId);

          if (!history.length) {
            return {
              content: [{ type: "text", text: `No history for memory ${memoryId}.` }],
              details: { count: 0 },
            };
          }

          const text = history
            .map((h, i) => `${i + 1}. [${h.event}] ${h.createdAt}\n   Old: ${h.oldMemory}\n   New: ${h.newMemory}`)
            .join("\n\n");

          return {
            content: [{ type: "text", text: `History for ${memoryId}:\n\n${text}` }],
            details: { count: history.length, history },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `History failed: ${String(err)}` }],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_history" },
  );
}

// ============================================================================
// CLI Registration
// ============================================================================

function registerCli(
  api: OpenClawPluginApi,
  provider: Mem0Provider,
  cfg: Mem0Config,
  _effectiveUserId: (sessionKey?: string) => string,
  _agentUserId: (id: string) => string,
  getCurrentSessionId: () => string | undefined,
): void {
  api.registerCli(
    ({ program }) => {
      const mem0 = program
        .command("mem0")
        .description("Mem0 memory plugin commands");

      mem0
        .command("search")
        .description("Search memories")
        .argument("<query>", "Search query")
        .option("--limit <n>", "Max results", String(cfg.topK))
        .option("--scope <scope>", "Scope: conversation, session, user, organization, all", "user")
        .option("--agent <agentId>", "Search agent namespace")
        .action(async (query: string, opts: { limit: string; scope: string; agent?: string }) => {
          try {
            const limit = parseInt(opts.limit, 10);
            const scope = opts.scope as MemoryScope;
            const currentSessionId = getCurrentSessionId();
            const uid = opts.agent ? _agentUserId(opts.agent) : _effectiveUserId(currentSessionId);

            const result = await provider.search({
              query,
              scope: {
                type: scope,
                userId: uid,
                sessionId: scope === "session" ? currentSessionId : undefined,
              },
              options: { limit },
            });

            if (!result.results.length) {
              console.log("No memories found.");
              return;
            }

            const output = result.results.map((r) => ({
              id: r.id,
              memory: r.memory,
              score: r.score,
              categories: r.categories,
              createdAt: r.createdAt,
            }));

            console.log(JSON.stringify(output, null, 2));
          } catch (err) {
            console.error(`Search failed: ${String(err)}`);
          }
        });

      mem0
        .command("stats")
        .description("Show memory statistics")
        .option("--agent <agentId>", "Stats for agent")
        .action(async (opts: { agent?: string }) => {
          try {
            const uid = opts.agent ? _agentUserId(opts.agent) : cfg.defaultScope.userId;
            const memories = await provider.list({
              scope: { type: "user", userId: uid },
            });

            console.log(`Mode: ${cfg.mode}`);
            console.log(`User: ${uid}`);
            console.log(`Total memories: ${memories.length}`);
            console.log(`Features: ${JSON.stringify(cfg.features)}`);
          } catch (err) {
            console.error(`Stats failed: ${String(err)}`);
          }
        });
    },
    { commands: ["mem0"] },
  );
}

// ============================================================================
// Lifecycle Hooks
// ============================================================================

function registerHooks(
  api: OpenClawPluginApi,
  provider: Mem0Provider,
  cfg: Mem0Config,
  _effectiveUserId: (sessionKey?: string) => string,
  session: {
    setCurrentSessionId: (id: string) => void;
    getStateDir: () => string | undefined;
  },
  skillsActive: boolean = false,
): void {
  // Skills mode hooks
  if (skillsActive) {
    api.on("before_prompt_build", async (event: any, ctx: any) => {
      if (!event.prompt || event.prompt.length < 5) return;

      const trigger = ctx?.trigger ?? undefined;
      const sessionId = ctx?.sessionKey ?? undefined;

      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info("openclaw-mem0: skills-mode skipping non-interactive trigger");
        return;
      }

      // Skip system/bootstrap prompts
      const promptLower = event.prompt.toLowerCase();
      const isSystemPrompt =
        promptLower.includes("a new session was started") ||
        promptLower.includes("session startup sequence") ||
        promptLower.startsWith("system:") ||
        promptLower.startsWith("run your session");

      if (isSystemPrompt) {
        api.logger.info("openclaw-mem0: skills-mode skipping system prompt");
        const systemContext = loadTriagePrompt(cfg.skills ?? {});
        return { prependSystemContext: systemContext };
      }

      if (sessionId) session.setCurrentSessionId(sessionId);

      const isSubagent = isSubagentSession(sessionId);
      const userId = _effectiveUserId(isSubagent ? undefined : sessionId);

      // Static protocol
      let systemContext = loadTriagePrompt(cfg.skills ?? {});
      if (isSubagent) {
        systemContext = "You are a subagent — use these memories for context but do not assume you are this user.\n\n" + systemContext;
      }

      // Dynamic recall
      let recallContext = "";
      const recallEnabled = cfg.skills?.recall?.enabled !== false;
      const recallStrategy = cfg.skills?.recall?.strategy ?? "smart";

      if (recallEnabled && recallStrategy !== "manual") {
        try {
          const query = sanitizeQuery(event.prompt);
          const sessionIdForRecall = recallStrategy === "always"
            ? (isSubagent ? undefined : sessionId)
            : undefined;

          const recallResult = await skillRecall(
            provider,
            query,
            userId,
            cfg.skills ?? {},
            sessionIdForRecall,
          );

          api.logger.info(
            `openclaw-mem0: recall (strategy=${recallStrategy}) injecting ${recallResult.memories.length} memories`,
          );

          recallContext = recallResult.context;
        } catch (err) {
          api.logger.warn(`openclaw-mem0: recall failed: ${String(err)}`);
        }
      }

      // Auto-dream
      const stateDir = session.getStateDir();
      const dreamEnabled = cfg.skills?.dream?.enabled !== false && cfg.skills?.dream?.auto !== false;
      let dreamContext = "";

      if (dreamEnabled && stateDir && !isSubagent) {
        try {
          const cheapResult = checkCheapGates(stateDir, cfg.skills?.dream ?? {});
          if (cheapResult.proceed) {
            const memories = await provider.list({
              scope: { type: "user", userId },
            });
            const memCount = memories.length;
            const memResult = checkMemoryGate(memCount, cfg.skills?.dream ?? {});

            if (memResult.pass && acquireDreamLock(stateDir)) {
              const dreamPrompt = loadDreamPrompt(cfg.skills ?? {});
              if (dreamPrompt) {
                dreamContext = "\n\n<auto-dream>\nRun memory consolidation before responding.\n\n" + dreamPrompt + "\n</auto-dream>";
                api.logger.info(`openclaw-mem0: auto-dream triggered (${memCount} memories)`);
              } else {
                releaseDreamLock(stateDir);
              }
            }
          }
        } catch (err) {
          api.logger.warn(`openclaw-mem0: auto-dream gate check failed: ${String(err)}`);
        }
      }

      return {
        prependSystemContext: systemContext,
        prependContext: recallContext + dreamContext,
      };
    });

    // Agent end hook for skills mode
    let dreamSessionId: string | undefined;

    api.on("agent_end", async (event: any, ctx: any) => {
      const sessionId = ctx?.sessionKey ?? undefined;
      const trigger = ctx?.trigger ?? undefined;
      if (sessionId) session.setCurrentSessionId(sessionId);

      // Dream completion
      const stateDir = session.getStateDir();
      if (dreamSessionId && dreamSessionId === sessionId && stateDir) {
        dreamSessionId = undefined;

        if (!event.success) {
          releaseDreamLock(stateDir);
          api.logger.warn("openclaw-mem0: auto-dream turn failed, lock released");
          return;
        }

        const WRITE_TOOLS = new Set(["memory_store", "memory_update", "memory_forget", "memory_delete_all"]);
        const messages = event.messages ?? [];
        const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
        const writeToolUsed = lastAssistant && Array.isArray(lastAssistant.content)
          ? lastAssistant.content.some((block: any) =>
              block.type === "tool_use" && WRITE_TOOLS.has(block.name)
            )
          : false;

        if (writeToolUsed) {
          releaseDreamLock(stateDir);
          recordDreamCompletion(stateDir);
          api.logger.info("openclaw-mem0: auto-dream completed");
        } else {
          releaseDreamLock(stateDir);
          api.logger.warn("openclaw-mem0: auto-dream injected but no write tools executed");
        }
        return;
      }

      if (!event.success) return;

      if (stateDir && sessionId && !isNonInteractiveTrigger(trigger, sessionId)) {
        incrementSessionCount(stateDir, sessionId);
      }

      api.logger.info("openclaw-mem0: skills-mode agent_end (no auto-capture)");
    });

    return;
  }

  // Legacy mode hooks
  if (cfg.features.autoRecall) {
    api.on("before_agent_start", async (event, ctx) => {
      if (!event.prompt || event.prompt.length < 5) return;

      const trigger = (ctx as any)?.trigger ?? undefined;
      const sessionId = (ctx as any)?.sessionKey ?? undefined;

      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info("openclaw-mem0: skipping recall for non-interactive trigger");
        return;
      }

      if (sessionId) session.setCurrentSessionId(sessionId);

      const isSubagent = isSubagentSession(sessionId);
      const recallSessionKey = isSubagent ? undefined : sessionId;
      
      // Determine agent's allowed appIds based on sessionKey
      // main/coder agents can access tech, product, and general memories
      const allowedAppIds = getAgentAllowedAppIds(sessionId);

      try {
        const recallTopK = Math.max((cfg.topK ?? 5) * 2, 10);

        const userResult = await provider.search({
          query: event.prompt,
          scope: {
            type: "user",
            userId: _effectiveUserId(recallSessionKey),
          },
          options: { limit: recallTopK },
        });

        let userResults = userResult.results.filter(
          (r) => (r.score ?? 0) >= Math.max(cfg.searchThreshold, 0.6),
        );

        // Dynamic thresholding
        if (userResults.length > 1) {
          const topScore = userResults[0]?.score ?? 0;
          if (topScore > 0) {
            userResults = userResults.filter((r) => (r.score ?? 0) >= topScore * 0.5);
          }
        }

        // Broad recall for short prompts
        if (event.prompt.length < 100) {
          const broadResult = await provider.search({
            query: "recent decisions, preferences, active projects",
            scope: { type: "user", userId: _effectiveUserId(recallSessionKey) },
            options: { limit: 5, threshold: 0.5 },
          });

          const existingIds = new Set(userResults.map((r) => r.id));
          for (const r of broadResult.results) {
            if (!existingIds.has(r.id)) {
              userResults.push(r);
            }
          }
        }

        userResults = userResults.slice(0, cfg.topK);

        // Session results
        let sessionResults: MemoryItem[] = [];
        if (sessionId) {
          const sessionResult = await provider.search({
            query: event.prompt,
            scope: {
              type: "session",
              userId: _effectiveUserId(recallSessionKey),
              sessionId,
            },
            options: { limit: cfg.topK, threshold: cfg.searchThreshold },
          });
          sessionResults = sessionResult.results;
        }

        // Organization (shared) memory results - filtered by appId
        let orgResults: MemoryItem[] = [];
        const orgId = cfg.defaultScope.orgId;
        if (orgId && allowedAppIds.length > 0) {
          // Search for general memories (no appId)
          const generalResult = await provider.search({
            query: event.prompt,
            scope: {
              type: "organization",
              orgId,
            },
            options: { limit: cfg.topK, threshold: cfg.searchThreshold },
          });
          
          // Search for role-specific memories (with appId)
          const roleResults: MemoryItem[] = [];
          for (const appId of allowedAppIds) {
            try {
              const appResult = await provider.search({
                query: event.prompt,
                scope: {
                  type: "organization",
                  orgId,
                  appId,
                },
                options: { limit: cfg.topK, threshold: cfg.searchThreshold },
              });
              roleResults.push(...appResult.results);
            } catch (e) {
              // Ignore errors for specific appIds
            }
          }
          
          // Merge and deduplicate
          const seenIds = new Set<string>();
          for (const r of [...generalResult.results, ...roleResults]) {
            if (!seenIds.has(r.id)) {
              seenIds.add(r.id);
              orgResults.push(r);
            }
          }
          
          // Filter by score and limit
          orgResults = orgResults
            .filter((r) => (r.score ?? 0) >= cfg.searchThreshold)
            .slice(0, cfg.topK);
        }

        // Merge all results
        const allIds = new Set([...userResults, ...sessionResults].map((r) => r.id));
        const uniqueOrgResults = orgResults.filter((r) => !allIds.has(r.id));

        if (userResults.length === 0 && sessionResults.length === 0 && uniqueOrgResults.length === 0) {
          return;
        }

        let memoryContext = "";
        
        // User memories
        if (userResults.length > 0) {
          memoryContext += userResults
            .map((r) => `- ${r.memory}${r.categories?.length ? ` [${r.categories.join(", ")}]` : ""}`)
            .join("\n");
        }
        
        // Session memories
        const uniqueSessionResults = sessionResults.filter((r) => !userResults.map(u => u.id).includes(r.id));
        if (uniqueSessionResults.length > 0) {
          if (memoryContext) memoryContext += "\n";
          memoryContext += "\nSession memories:\n";
          memoryContext += uniqueSessionResults.map((r) => `- ${r.memory}`).join("\n");
        }
        
        // Organization (shared) memories
        if (uniqueOrgResults.length > 0) {
          if (memoryContext) memoryContext += "\n";
          memoryContext += "\nShared team memories:\n";
          memoryContext += uniqueOrgResults.map((r) => `- ${r.memory}`).join("\n");
        }

        const totalCount = userResults.length + uniqueSessionResults.length + uniqueOrgResults.length;
        api.logger.info(
          `openclaw-mem0: injecting ${totalCount} memories (${userResults.length} user, ${uniqueSessionResults.length} session, ${uniqueOrgResults.length} shared)`,
        );

        const preamble = isSubagent
          ? `The following are stored memories for user "${cfg.defaultScope.userId}". You are a subagent.`
          : `The following are stored memories for user "${cfg.defaultScope.userId}":`;

        return {
          prependContext: `<relevant-memories>\n${preamble}\n${memoryContext}\n</relevant-memories>`,
        };
      } catch (err) {
        api.logger.warn(`openclaw-mem0: recall failed: ${String(err)}`);
      }
    });
  }

  /**
   * Get allowed appIds for an agent based on session key
   * This determines which shared memories the agent can access
   */
  function getAgentAllowedAppIds(sessionKey: string | undefined): string[] {
    if (!sessionKey) return ["tech", "product", "general"];
    
    // Extract agentId from session key (agent:<agentId>:<session>)
    const match = sessionKey.match(/^agent:([^:]+):/);
    const agentId = match?.[1];
    
    switch (agentId) {
      case "main":
        // Main agent (土豆) - can access tech, product, and general
        return ["tech", "product", "general"];
      case "coder":
        // Coder agent (猴子) - primarily tech-focused
        return ["tech", "general"];
      case "product":
        // Product agent - product and general
        return ["product", "general"];
      case "operation":
        // Operation agent - operation and general
        return ["operation", "general"];
      default:
        // Default: allow all
        return ["tech", "product", "operation", "general"];
    }
  }

  // Auto-capture
  if (cfg.features.autoCapture) {
    api.on("agent_end", async (event, ctx) => {
      if (!event.success || !event.messages || event.messages.length === 0) return;

      const trigger = (ctx as any)?.trigger ?? undefined;
      const sessionId = (ctx as any)?.sessionKey ?? undefined;

      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info("openclaw-mem0: skipping capture for non-interactive trigger");
        return;
      }

      if (isSubagentSession(sessionId)) {
        api.logger.info("openclaw-mem0: skipping capture for subagent");
        return;
      }

      if (sessionId) session.setCurrentSessionId(sessionId);

      try {
        const filtered = filterMessagesForExtraction(event.messages);
        if (!filtered.length) return;

        const userId = _effectiveUserId(sessionId);
        const orgId = cfg.defaultScope.orgId;
        
        // Get LLM config for content classification
        const llmConfig: LLMConfig | undefined = cfg.oss?.llm ? {
          provider: cfg.oss.llm.provider,
          config: cfg.oss.llm.config as LLMConfig["config"],
        } : undefined;

        // Analyze and categorize content using LLM
        const personalFacts: string[] = [];
        const sharedFactsByAppId: Map<string | undefined, { content: string; category: string }[]> = new Map();

        for (const msg of filtered) {
          const content = msg.content;
          const classification = await classifyContentWithLLM(content, llmConfig);
          
          if (classification.isShared && orgId) {
            const appId = classification.appId;
            if (!sharedFactsByAppId.has(appId)) {
              sharedFactsByAppId.set(appId, []);
            }
            sharedFactsByAppId.get(appId)!.push({ 
              content, 
              category: classification.category 
            });
          } else if (!classification.isShared) {
            personalFacts.push(content);
          }
        }

        // Save personal memories to user scope
        if (personalFacts.length > 0) {
          await provider.add({
            facts: personalFacts,
            scope: {
              type: "session",
              userId,
              sessionId,
            },
          });
        }

        // Save shared memories to organization scope with appId filtering
        let totalShared = 0;
        for (const [appId, facts] of sharedFactsByAppId) {
          if (facts.length === 0) continue;
          
          const sharedContents = facts.map(f => f.content);
          const scope: any = {
            type: "organization",
            orgId,
          };
          if (appId) {
            scope.appId = appId;
          }
          
          await provider.add({
            facts: sharedContents,
            scope,
          });
          
          const categories = [...new Set(facts.map(f => f.category))].join(", ");
          const appIdLabel = appId || "general";
          api.logger.info(`openclaw-mem0: captured ${facts.length} shared messages to org:${appIdLabel} [${categories}]`);
          totalShared += facts.length;
        }

        api.logger.info(`openclaw-mem0: captured ${filtered.length} messages (personal: ${personalFacts.length}, shared: ${totalShared})`);
      } catch (err) {
        api.logger.warn(`openclaw-mem0: capture failed: ${String(err)}`);
      }
    });
  }
}

/**
 * Configuration for LLM-based shared content classification
 */
interface LLMConfig {
  provider: string;
  config: {
    model: string;
    baseURL?: string;
    apiKey?: string;
    temperature?: number;
  };
}

/**
 * Content classification result with appId for role-based filtering
 */
interface ContentClassification {
  isShared: boolean;
  appId: string | undefined;  // "tech", "product", "operation", "general", or undefined
  category: string;
  reason: string;
}

/**
 * Map content category to appId for role-based memory isolation
 */
function categoryToAppId(category: string): string | undefined {
  const categoryLower = category.toLowerCase();
  
  // Technical categories → tech
  if (/架构|规范|API|环境|部署|流程|故障|监控|工具|backend|frontend|devops|数据库/.test(categoryLower)) {
    return "tech";
  }
  
  // Product categories → product
  if (/产品|需求|设计|用户|功能|优先级|roadmap|需求/.test(categoryLower)) {
    return "product";
  }
  
  // Operation categories → operation
  if (/运营|数据|分析|营销|活动|用户增长|留存|转化/.test(categoryLower)) {
    return "operation";
  }
  
  // General categories → no appId (org level)
  if (/通用|团队|规范|流程|个人|general/.test(categoryLower)) {
    return undefined;
  }
  
  // Default to undefined (shared at org level)
  return undefined;
}

/**
 * Use LLM to analyze if content is suitable for shared/organization memory.
 * This provides intelligent classification based on content semantics.
 */
async function classifyContentWithLLM(
  content: string,
  llmConfig: LLMConfig | undefined
): Promise<ContentClassification> {
  // If no LLM config, fall back to rule-based classification
  if (!llmConfig) {
    const isShared = isSharedContentRuleBased(content);
    return { 
      isShared, 
      appId: undefined, 
      category: "rule-based", 
      reason: "fallback to rule-based" 
    };
  }

  const prompt = `你是一位团队协作记忆管理专家。请分析以下对话内容，判断是否适合保存为团队共享记忆，并判断适合哪些角色查看。

## 团队角色：
- **技术团队 (tech)**：开发工程师、测试工程师、运维工程师
- **产品团队 (product)**：产品经理、产品运营
- **运营团队 (operation)**：用户运营、数据运营、市场运营
- **通用 (general)**：所有角色都需要了解

## 适合共享的记忆类型及对应角色：

### 技术团队专属 (tech)
- 项目架构和技术栈（如："系统采用微服务架构，使用 K8s 部署"）
- 技术规范和标准（如："代码必须使用 ESLint，2 空格缩进"）
- API 设计和接口规范（如："用户接口返回统一格式 {code, data, message}"）
- 环境配置信息（如："生产数据库是 PostgreSQL 15，连接池 100"）
- 部署和发布流程（如："发布需要经过测试 → 预发 → 生产"）
- 故障处理和运维经验（如："数据库连接超时需检查连接池配置"）
- 监控告警规则（如："CPU > 80% 触发告警，通知运维"）
- 通用工具和方法（如："使用 Docker Compose 本地启动服务"）

### 产品团队专属 (product)
- 产品需求和决策（如："这个功能优先级 P0，本周上线"）
- 用户需求和场景（如："用户反馈需要导出功能"）
- 产品设计规范（如："按钮颜色使用主色调蓝色"）
- 迭代计划和 Roadmap

### 运营团队专属 (operation)
- 运营活动方案（如："618 活动方案，目标 GMV 1000 万"）
- 数据分析结果（如："昨日新增用户 1000，留存率 30%"）
- 用户增长策略
- 营销渠道信息

### 通用信息 (general)
- 团队规范和制度（如："周会时间每周五下午 3 点"）
- 项目整体介绍
- 跨团队协作流程

## 不适合共享的记忆类型：
1. 个人主观意见（如："我觉得..."、"我认为..."）
2. 个人帮助请求（如："帮我查一下..."、"给我写个..."）
3. 临时性调试命令或代码片段
4. 针对具体 bug 的一次性讨论
5. 个人信息或偏好设置

## 待分析内容：
"""
${content}
"""

请按以下格式回复（必须是有效 JSON）：
{
  "isShared": true/false,
  "confidence": 0-1,
  "appId": "tech/product/operation/general",
  "category": "详细分类如：架构/规范/API/环境/流程/故障/监控/产品需求/运营活动/通用",
  "reason": "简短说明判断原因"
}`;

  try {
    const response = await callLLM(prompt, llmConfig);
    const result = parseLLMResponse(response);
    
    const isShared = result.isShared && result.confidence > 0.6;
    const appId = isShared ? (result.appId || categoryToAppId(result.category)) : undefined;
    
    return {
      isShared,
      appId,
      category: result.category,
      reason: result.reason,
    };
  } catch (err) {
    // Fall back to rule-based on error
    const isShared = isSharedContentRuleBased(content);
    return { 
      isShared, 
      appId: undefined, 
      category: "rule-based", 
      reason: "fallback to rule-based" 
    };
  }
}

/**
 * Call LLM API for content classification
 */
async function callLLM(prompt: string, llmConfig: LLMConfig): Promise<string> {
  const { provider, config } = llmConfig;
  
  if (provider === "openai" || config.baseURL?.includes("dashscope")) {
    // OpenAI-compatible API (including Aliyun DashScope)
    const response = await fetch(config.baseURL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        temperature: config.temperature ?? 0.1,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

/**
 * Parse LLM response to extract classification result
 */
function parseLLMResponse(response: string): {
  isShared: boolean;
  confidence: number;
  appId: string | undefined;
  category: string;
  reason: string;
} {
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
                      response.match(/```\s*([\s\S]*?)\s*```/) ||
                      response.match(/(\{[\s\S]*\})/);
    
    const jsonStr = jsonMatch ? jsonMatch[1] : response;
    const result = JSON.parse(jsonStr);

    return {
      isShared: Boolean(result.isShared),
      confidence: Number(result.confidence) || 0.5,
      appId: result.appId || undefined,
      category: String(result.category || "未分类"),
      reason: String(result.reason || "无说明"),
    };
  } catch (err) {
    // Default to not shared if parsing fails
    return { isShared: false, confidence: 0, appId: undefined, category: "解析失败", reason: String(err) };
  }
}

/**
 * Rule-based fallback for content classification
 */
function isSharedContentRuleBased(content: string): boolean {
  const lower = content.toLowerCase();
  
  // Shared content patterns
  const sharedPatterns = [
    /^(我们?的?(项目|系统|架构|设计)是|项目使用|技术栈|框架|架构)/,
    /^(配置|设置|参数|环境)/,
    /^(最佳实践|规范|标准|约定)/,
    /^(流程|步骤|方法|方案)/,
    /^(文档|说明|手册|指南)/,
    /(统一|一致|共同|通用)/,
    /(所有人|大家|团队)/,
    /^(api|接口|接口地址|endpoint|url)/i,
    /^(数据库|db|表结构|schema)/i,
    /^(版本|version|依赖|dependency)/i,
  ];
  
  // Personal content patterns (not shared)
  const personalPatterns = [
    /(我觉得|我认为|我想|我感觉)/,
    /^(我|帮我|给我)/,
    /(请帮我|帮我|给我)/,
  ];
  
  if (personalPatterns.some(p => p.test(lower))) {
    return false;
  }
  
  return sharedPatterns.some(p => p.test(lower));
}

// ============================================================================
// Export
// ============================================================================

export default memoryPlugin;