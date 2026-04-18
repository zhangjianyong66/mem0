/**
 * OpenClaw Memory (Mem0) Plugin
 *
 * Long-term memory via Mem0 — supports both the Mem0 platform
 * and the open-source self-hosted SDK. Uses the official `mem0ai` package.
 *
 * Features:
 * - 6 core tools: memory_search, memory_add, memory_get, memory_list,
 *   memory_update, memory_delete
 * - Short-term (session-scoped) and long-term (user-scoped) memory
 * - Auto-recall: injects relevant memories (both scopes) before each agent turn
 * - Auto-capture: stores key facts scoped to the current session after each agent turn
 * - Per-agent isolation: multi-agent setups write/read from separate userId namespaces
 *   automatically via sessionKey routing (zero breaking changes for single-agent setups)
 * - CLI: openclaw mem0 search, openclaw mem0 status
 * - Dual mode: platform or open-source (self-hosted)
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type {
  Mem0Config,
  Mem0Provider,
  AddOptions,
  SearchOptions,
  MemoryItem,
} from "./types.ts";
import { createProvider, providerToBackend } from "./providers.ts";
import { mem0ConfigSchema } from "./config.ts";
import type { FileConfig } from "./config.ts";
import { filterMessagesForExtraction } from "./filtering.ts";
import {
  effectiveUserId,
  agentUserId,
  resolveUserId,
  isNonInteractiveTrigger,
  isSubagentSession,
} from "./isolation.ts";
import {
  loadTriagePrompt,
  isSkillsMode,
} from "./skill-loader.ts";
import {
  recall as skillRecall,
  sanitizeQuery,
  shouldRecallLongTermMemory,
} from "./recall.ts";
import {
  incrementSessionCount,
  checkCheapGates,
  getDreamState,
} from "./dream-gate.ts";
import { enqueueDreamJob } from "./dream-queue.ts";
import { PlatformBackend } from "./backend/platform.ts";
import type { Backend } from "./backend/base.ts";
import { registerCliCommands } from "./cli/commands.ts";
import { readPluginAuth } from "./cli/config-file.ts";
import { registerAllTools } from "./tools/index.ts";
import type { ToolDeps } from "./tools/index.ts";
import { captureEvent } from "./telemetry.ts";
import { bootstrapTelemetryFlag } from "./fs-safe.ts";
import { drainDreamQueue } from "./dream-worker.ts";

bootstrapTelemetryFlag();

// ============================================================================
// Re-exports (for tests and external consumers)
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
export type { FileConfig } from "./config.ts";
export { createProvider } from "./providers.ts";

// ============================================================================
// Helpers
// ============================================================================

export function resolveDreamStateDir(
  sessionStateDir?: string,
  pluginStateDir?: string,
  runtimeStateDir?: string,
): {
  stateDir?: string;
  source: "session" | "plugin" | "runtime" | "none";
} {
  if (sessionStateDir) {
    return { stateDir: sessionStateDir, source: "session" };
  }
  if (pluginStateDir) {
    return { stateDir: pluginStateDir, source: "plugin" };
  }
  if (runtimeStateDir) {
    return { stateDir: runtimeStateDir, source: "runtime" };
  }
  return { source: "none" };
}

function extractTextFromPromptContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      if (!("type" in part) || !("text" in part)) return [];
      const record = part as { type?: unknown; text?: unknown };
      if (
        record.type !== "text" &&
        record.type !== "input_text" &&
        record.type !== "output_text"
      ) {
        return [];
      }
      return typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

type AutoRecallQuerySource = "prompt" | "messages" | "fallback";

export interface AutoRecallQueryResolution {
  query: string;
  source: AutoRecallQuerySource;
}

const NON_USER_QUERY_PATTERNS = [
  "read heartbeat.md if it exists",
  "a new session was started",
  "session startup sequence",
  "/new or /reset",
  "run your session",
];

function stripInjectedMemoryBlocks(text: string): string {
  return text
    .replace(/<recalled-memories>[\s\S]*?<\/recalled-memories>\s*/gi, "")
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/gi, "");
}

function stripSenderMetadata(text: string): string {
  return text.replace(
    /Sender\s*\(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
    "",
  );
}

function stripLeadingBracketPrefix(text: string): string {
  return text.replace(/^\[[^\]\n]*\]\s*/g, "").trim();
}

function extractTimestampedUserText(text: string): string | undefined {
  const timestampPattern = /\[[^\]\n]*\d{4}[^\]\n]*GMT[^\]\n]*\]\s*/gi;
  let match: RegExpExecArray | null = null;
  let lastMatch: RegExpExecArray | null = null;
  while ((match = timestampPattern.exec(text)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) return undefined;
  const candidate = text.slice(lastMatch.index + lastMatch[0].length).trim();
  return candidate || undefined;
}

function isNonUserRecallQuery(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;
  return NON_USER_QUERY_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
}

function cleanAutoRecallQueryCandidate(
  rawText: string,
  options: { allowPlainText: boolean },
): string | undefined {
  const withoutBlocks = stripInjectedMemoryBlocks(rawText);
  const withoutSender = stripSenderMetadata(withoutBlocks).trim();
  const timestamped = extractTimestampedUserText(withoutSender);
  const candidate = timestamped ?? (options.allowPlainText ? withoutSender : "");
  const cleaned = stripLeadingBracketPrefix(sanitizeQuery(candidate)).trim();
  if (isNonUserRecallQuery(cleaned)) return undefined;
  return cleaned;
}

export function resolveAutoRecallQueryDetails(
  prompt: string,
  messages?: unknown[],
): AutoRecallQueryResolution {
  const promptQuery = cleanAutoRecallQueryCandidate(prompt, {
    allowPlainText: false,
  });
  if (promptQuery) {
    return { query: promptQuery, source: "prompt" };
  }

  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        continue;
      }
      const record = message as { role?: unknown; content?: unknown };
      if (record.role !== "user") continue;
      const text = extractTextFromPromptContent(record.content);
      if (!text) continue;
      const query = cleanAutoRecallQueryCandidate(text, {
        allowPlainText: true,
      });
      if (query) {
        return { query, source: "messages" };
      }
    }
  }

  const fallbackQuery =
    cleanAutoRecallQueryCandidate(prompt, { allowPlainText: true }) ?? "";
  return { query: fallbackQuery, source: "fallback" };
}

export function resolveAutoRecallQuery(
  prompt: string,
  messages?: unknown[],
): string {
  return resolveAutoRecallQueryDetails(prompt, messages).query;
}

function previewForLog(text: unknown, max = 120): string {
  if (typeof text !== "string") return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = definePluginEntry({
  id: "openclaw-mem0",
  name: "Memory (Mem0)",
  description: "Mem0 memory backend — Mem0 platform or self-hosted open-source",

  register(api: OpenClawPluginApi) {
    // Read auth from openclaw.json plugin config (picks up post-startup login).
    // This is the single source of truth — set via `openclaw mem0 login`.
    const pluginAuth = readPluginAuth();
    const fileConfig: FileConfig = {
      apiKey: pluginAuth.apiKey,
      baseUrl: pluginAuth.baseUrl,
    };
    const cfg = mem0ConfigSchema.parse(api.pluginConfig, fileConfig);

    // Telemetry context bound to this plugin instance's config
    const telemetryCtx = {
      apiKey: cfg.apiKey,
      mode: cfg.mode,
      skillsActive: false,
    };
    const _captureEvent = (event: string, props?: Record<string, unknown>) => {
      try {
        captureEvent(event, props, telemetryCtx);
      } catch {
        /* silently swallow */
      }
    };

    if (cfg.needsSetup) {
      api.logger.warn(
        "openclaw-mem0: API key not configured. Memory features are disabled.\n" +
          "  To set up, run:\n" +
          "  openclaw mem0 init\n" +
          "  Get your key at: https://app.mem0.ai/dashboard/api-keys",
      );

      // Register CLI even without API key — init command must be available
      // to bootstrap configuration. Pass nulls for backend/provider since
      // only the init subcommand works without auth.
      registerCliCommands(
        api,
        null as any,
        null as any,
        cfg,
        () => cfg.userId,
        (id: string) => `${cfg.userId}:agent:${id}`,
        () => ({ user_id: cfg.userId, top_k: cfg.topK }),
        () => undefined,
        () => pluginStateDir,
        (cmd: string) => _captureEvent(`openclaw.cli.${cmd}`, { command: cmd }),
      );

      api.registerService({
        id: "openclaw-mem0",
        start: () => {
          api.logger.info("openclaw-mem0: waiting for API key configuration");
        },
        stop: () => {},
      });
      return;
    }

    const provider = createProvider(cfg, api);

    // Create Backend instance — PlatformBackend for platform mode, providerToBackend adapter for OSS
    let backend: Backend;
    if (cfg.mode === "platform") {
      backend = new PlatformBackend({
        apiKey: cfg.apiKey!,
        baseUrl: cfg.baseUrl ?? "https://api.mem0.ai",
      });
    } else {
      backend = providerToBackend(provider, cfg.userId);
    }

    // Shared mutable state — declared together before any closures capture them.
    let currentSessionId: string | undefined;
    let pluginStateDir: string | undefined;
    const resolveRuntimeStateDir = () =>
      (api.runtime as { state?: { resolveStateDir?: () => string } })?.state?.resolveStateDir?.() ??
      "";
    const resolveEffectiveStateDir = () => pluginStateDir ?? resolveRuntimeStateDir();

    // ========================================================================
    // Per-agent isolation helpers (thin wrappers around exported functions)
    // ========================================================================
    const _effectiveUserId = (sessionKey?: string) =>
      effectiveUserId(cfg.userId, sessionKey);
    const _agentUserId = (id: string) => agentUserId(cfg.userId, id);
    const _resolveUserId = (opts: { agentId?: string; userId?: string }) =>
      resolveUserId(cfg.userId, opts, currentSessionId);

    const skillsActive = isSkillsMode(cfg.skills);
    telemetryCtx.skillsActive = skillsActive;

    _captureEvent("openclaw.plugin.registered", {
      auto_recall: cfg.autoRecall,
      auto_capture: cfg.autoCapture,
    });

    api.logger.info(
      `openclaw-mem0: registered (mode: ${cfg.mode}, user: ${cfg.userId}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, skills: ${skillsActive})`,
    );

    // Helper: build add options
    function buildAddOptions(
      userIdOverride?: string,
      runId?: string,
      sessionKey?: string,
    ): AddOptions {
      const opts: AddOptions = {
        user_id: userIdOverride || _effectiveUserId(sessionKey),
        source: "OPENCLAW",
      };
      if (runId) opts.run_id = runId;
      if (cfg.mode === "platform") {
        opts.output_format = "v1.1";
      }
      return opts;
    }

    // Helper: build search options (skills config overrides legacy defaults)
    function buildSearchOptions(
      userIdOverride?: string,
      limit?: number,
      runId?: string,
      sessionKey?: string,
    ): SearchOptions {
      const recallCfg = cfg.skills?.recall;
      const opts: SearchOptions = {
        user_id: userIdOverride || _effectiveUserId(sessionKey),
        top_k: limit ?? cfg.topK,
        limit: limit ?? cfg.topK,
        threshold: recallCfg?.threshold ?? cfg.searchThreshold,
        keyword_search: recallCfg?.keywordSearch !== false,
        reranking: recallCfg?.rerank !== false,
        source: "OPENCLAW",
      };
      if (recallCfg?.filterMemories) opts.filter_memories = true;
      if (runId) opts.run_id = runId;
      return opts;
    }

    // ========================================================================
    // Tools (modular — each tool in its own file under tools/)
    // ========================================================================

    const toolDeps: ToolDeps = {
      api,
      provider,
      cfg,
      backend,
      resolveUserId: _resolveUserId,
      effectiveUserId: _effectiveUserId,
      agentUserId: _agentUserId,
      buildAddOptions,
      buildSearchOptions,
      getCurrentSessionId: () => currentSessionId,
      getStateDir: resolveEffectiveStateDir,
      skillsActive,
      captureToolEvent: (toolName: string, props: Record<string, unknown>) => {
        _captureEvent(`openclaw.tool.${toolName}`, {
          tool_name: toolName,
          ...props,
        });
      },
    };
    registerAllTools(toolDeps);

    // ========================================================================
    // CLI Commands
    // ========================================================================

    registerCliCommands(
      api,
      backend,
      provider,
      cfg,
      _effectiveUserId,
      _agentUserId,
      buildSearchOptions,
      () => currentSessionId,
      resolveEffectiveStateDir,
      (cmd: string) => _captureEvent(`openclaw.cli.${cmd}`, { command: cmd }),
    );

    // ========================================================================
    // Dream Background Worker
    // ========================================================================

    let dreamWorkerTimer: ReturnType<typeof setInterval> | undefined;
    let dreamWorkerBusy = false;
    const dreamWorkerIntervalMs = 5_000;

    const resolvePersistentDreamStateDir = () =>
      pluginStateDir ?? resolveRuntimeStateDir();

    const queueDreamJob = (
      stateDir: string,
      input: Parameters<typeof enqueueDreamJob>[1],
    ) => enqueueDreamJob(stateDir, input);

    const runDreamWorkerTick = async (reason: string) => {
      if (dreamWorkerBusy) return;
      const stateDir = resolvePersistentDreamStateDir();
      if (!stateDir) return;

      dreamWorkerBusy = true;
      try {
        const outcome = await drainDreamQueue(stateDir, {
          api,
          provider,
          cfg,
          captureEvent: _captureEvent,
        });
        if (outcome.processed === 0 && reason !== "interval") {
          api.logger.debug(
            `openclaw-mem0: dream worker idle (${reason}, stateDir=${stateDir})`,
          );
        }
      } catch (err) {
        api.logger.warn(
          `openclaw-mem0: dream worker tick failed (${reason}): ${String(err)}`,
        );
      } finally {
        dreamWorkerBusy = false;
      }
    };

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    registerHooks(
      api,
      provider,
      cfg,
      _effectiveUserId,
      buildAddOptions,
      buildSearchOptions,
      {
        setCurrentSessionId: (id: string) => {
          currentSessionId = id;
        },
        getPluginStateDir: () => pluginStateDir,
        getRuntimeStateDir: resolveRuntimeStateDir,
        queueDreamJob,
      },
      skillsActive,
      _captureEvent,
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "openclaw-mem0",
      start: (...args: any[]) => {
        pluginStateDir = args[0]?.stateDir ?? resolveRuntimeStateDir();
        api.logger.info(
          `openclaw-mem0: initialized (mode: ${cfg.mode}, user: ${cfg.userId}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, stateDir: ${pluginStateDir ?? "none"})`,
        );
        if (skillsActive && cfg.skills?.dream?.enabled !== false && cfg.skills?.dream?.auto !== false) {
          dreamWorkerTimer = setInterval(() => {
            void runDreamWorkerTick("interval");
          }, dreamWorkerIntervalMs);
          void runDreamWorkerTick("start");
        }
      },
      stop: () => {
        if (dreamWorkerTimer) clearInterval(dreamWorkerTimer);
        dreamWorkerTimer = undefined;
        api.logger.info("openclaw-mem0: stopped");
      },
    });
  },
});

// ============================================================================
// Lifecycle Hook Registration
// ============================================================================

function logDreamDiagnostics(
  api: OpenClawPluginApi,
  capture: (event: string, props?: Record<string, unknown>) => void,
  phase: string,
  stateDir: string | undefined,
  props: Record<string, unknown> = {},
): void {
  const state = stateDir ? getDreamState(stateDir) : undefined;
  const payload = {
    phase,
    ...props,
    state_dir_present: Boolean(stateDir),
    dream_last_consolidated_at: state?.lastConsolidatedAt ?? null,
    dream_sessions_since: state?.sessionsSince ?? null,
    dream_last_session_id: state?.lastSessionId ?? null,
  };
  capture("openclaw.hook.dream", payload);

  const details = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  api.logger.info(`openclaw-mem0: auto-dream ${phase}${details ? ` (${details})` : ""}`);
}

function registerHooks(
  api: OpenClawPluginApi,
  provider: Mem0Provider,
  cfg: Mem0Config,
  _effectiveUserId: (sessionKey?: string) => string,
  buildAddOptions: (
    userIdOverride?: string,
    runId?: string,
    sessionKey?: string,
  ) => AddOptions,
  buildSearchOptions: (
    userIdOverride?: string,
    limit?: number,
    runId?: string,
    sessionKey?: string,
  ) => SearchOptions,
  session: {
    setCurrentSessionId: (id: string) => void;
    getPluginStateDir: () => string | undefined;
    getRuntimeStateDir: () => string;
    queueDreamJob: (
      stateDir: string,
      input: Parameters<typeof enqueueDreamJob>[1],
    ) => ReturnType<typeof enqueueDreamJob>;
  },
  skillsActive: boolean = false,
  _captureEvent: (
    event: string,
    props?: Record<string, unknown>,
  ) => void = () => {},
) {
  // ========================================================================
  // SKILLS MODE: Agentic memory via before_prompt_build
  // ========================================================================
  if (skillsActive) {
    // Use before_prompt_build instead of before_agent_start:
    // - prependSystemContext: static memory protocol (provider-cacheable, no per-turn cost)
    // - prependContext: dynamic recalled memories (changes every turn)
    //
    // NOTE: We previously used a shared `lastCleanUserMessage` variable populated
    // by message_received to get clean user content. That variable was process-global
    // mutable state vulnerable to cross-session races. Removed in favor of resolving
    // the latest user message from event.messages inside this hook, where ctx.sessionKey
    // is available and the execution is scoped to the correct session.
    api.on("before_prompt_build", async (event: any, ctx: any) => {
      if (!event.prompt || event.prompt.length < 5) return;

      const trigger = ctx?.trigger ?? undefined;
      const sessionId = ctx?.sessionKey ?? undefined;
      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info(
          "openclaw-mem0: skills-mode skipping non-interactive trigger",
        );
        return;
      }

      const promptLower = event.prompt.toLowerCase();
      const isSystemPrompt =
        promptLower.includes("a new session was started") ||
        promptLower.includes("session startup sequence") ||
        promptLower.includes("/new or /reset") ||
        promptLower.startsWith("run your session");
      if (isSystemPrompt) {
        api.logger.info(
          "openclaw-mem0: skills-mode skipping recall for system/bootstrap prompt",
        );
        // Still inject the protocol, just skip recall search
        const systemContext = loadTriagePrompt(cfg.skills ?? {});
        return { prependSystemContext: systemContext };
      }

      if (sessionId) session.setCurrentSessionId(sessionId);

      const isSubagent = isSubagentSession(sessionId);
      const userId = _effectiveUserId(isSubagent ? undefined : sessionId);
      const runtimeStateDir = session.getRuntimeStateDir();

      // Static protocol goes in prependSystemContext (cacheable across turns)
      let systemContext = loadTriagePrompt(cfg.skills ?? {});
      if (isSubagent) {
        systemContext =
          "You are a subagent — use these memories for context but do not assume you are this user. Do NOT store new memories.\n\n" +
          systemContext;
      }

      // Dynamic recall goes in prependContext (changes every turn).
      // Strategy controls how much the plugin searches automatically:
      //   "always" — long-term + session search every turn (2 searches)
      //   "smart"  — long-term search only, no session search (1 search) [default]
      //   "manual" — no auto-recall; agent controls all search via memory_search (0 searches)
      let recallContext = "";
      const recallEnabled = cfg.skills?.recall?.enabled !== false;
      const recallStrategy = cfg.skills?.recall?.strategy ?? "smart";

      if (recallEnabled && recallStrategy !== "manual") {
        const recallStart = Date.now();
        try {
          const queryResolution = resolveAutoRecallQueryDetails(
            event.prompt,
            event.messages,
          );
          const query = queryResolution.query;
          const recallGate = shouldRecallLongTermMemory(query, cfg.skills ?? {});
          const recallLogBase = {
            strategy: recallStrategy,
            query_source: queryResolution.source,
            raw_prompt_preview: previewForLog(event.prompt),
            resolved_query_preview: previewForLog(query),
            query_length: query.length,
            gate_decision: recallGate.decision,
            session_id_present: Boolean(sessionId),
            is_subagent: isSubagent,
          };

          if (recallGate.decision === "skip") {
            api.logger.info(
              `openclaw-mem0: skills-mode recall skipped (${recallGate.reason}, strategy=${recallStrategy}, query_source=${queryResolution.source}, gate_decision=skip, query_length=${query.length}, raw_prompt_preview="${previewForLog(event.prompt)}", resolved_query_preview="${previewForLog(query)}", session_id_present=${Boolean(sessionId)}, is_subagent=${isSubagent})`,
            );
            _captureEvent("openclaw.hook.recall", {
              ...recallLogBase,
              decision: "skip",
              skip_reason: recallGate.reason,
              latency_ms: Date.now() - recallStart,
            });
          } else {
            // Smart mode: skip session search (saves 1 API call per turn)
            const sessionIdForRecall =
              recallGate.decision === "long_term_plus_session" ||
              recallStrategy === "always"
                ? isSubagent
                  ? undefined
                  : sessionId
                : undefined; // smart: long-term only

            const recallResult = await skillRecall(
              provider,
              query,
              userId,
              cfg.skills ?? {},
              sessionIdForRecall,
            );

            api.logger.info(
              `openclaw-mem0: skills-mode recall (strategy=${recallStrategy}, decision=${recallGate.decision}, query_source=${queryResolution.source}, gate_decision=${recallGate.decision}, query_length=${query.length}, raw_prompt_preview="${previewForLog(event.prompt)}", resolved_query_preview="${previewForLog(query)}", search_query_preview="${previewForLog(recallResult.debug.searchQuery)}", threshold=${recallResult.debug.threshold}, raw_top_k=${recallResult.debug.rawTopK}, session_search=${recallResult.debug.sessionSearchEnabled}, session_id_present=${Boolean(sessionId)}, is_subagent=${isSubagent}) injecting ${recallResult.memories.length} memories (~${recallResult.tokenEstimate} tokens, raw=${recallResult.debug.rawCandidateCount}, thresholded=${recallResult.debug.postThresholdCount}, deduped=${recallResult.debug.postDedupeCount})`,
            );

            _captureEvent("openclaw.hook.recall", {
              ...recallLogBase,
              decision: recallGate.decision,
              memory_count: recallResult.memories.length,
              search_query_preview: previewForLog(recallResult.debug.searchQuery),
              threshold: recallResult.debug.threshold,
              raw_top_k: recallResult.debug.rawTopK,
              session_search: recallResult.debug.sessionSearchEnabled,
              raw_candidate_count: recallResult.debug.rawCandidateCount,
              post_threshold_count: recallResult.debug.postThresholdCount,
              post_dedupe_count: recallResult.debug.postDedupeCount,
              latency_ms: Date.now() - recallStart,
            });

            recallContext = recallResult.context;
          }
        } catch (err) {
          api.logger.warn(
            `openclaw-mem0: skills-mode recall failed: ${String(err)}`,
          );
        }
      } else if (recallEnabled && recallStrategy === "manual") {
        api.logger.info(
          "openclaw-mem0: skills-mode recall strategy=manual, agent controls search",
        );
      }

      return {
        prependSystemContext: systemContext, // cached by provider
        prependContext: recallContext, // per-turn dynamic
      };
    });

    api.on("agent_end", async (event: any, ctx: any) => {
      const sessionId = ctx?.sessionKey ?? undefined;
      const trigger = ctx?.trigger ?? undefined;
      if (sessionId) session.setCurrentSessionId(sessionId);
      const sessionStateDir = session.getPluginStateDir();
      const runtimeStateDir = session.getRuntimeStateDir();
      const dreamStateResolution = resolveDreamStateDir(
        sessionStateDir,
        runtimeStateDir,
      );
      const effectiveDreamStateDir = dreamStateResolution.stateDir;
      const effectiveDreamStateSource = dreamStateResolution.source;

      if (!event.success) return;

      if (effectiveDreamStateDir && sessionId && !isNonInteractiveTrigger(trigger, sessionId)) {
        const sessionUpdate = incrementSessionCount(
          effectiveDreamStateDir,
          sessionId,
        );
        if (sessionUpdate.incremented) {
          _captureEvent("openclaw.hook.dream", {
            phase: "session_counted",
            session_id: sessionId,
            sessions_since: sessionUpdate.state.sessionsSince,
            state_dir_source: dreamStateResolution.source,
          });
          api.logger.info(
            `openclaw-mem0: auto-dream session counted (session=${sessionId}, sessions_since=${sessionUpdate.state.sessionsSince})`,
          );

          const dreamEnabled =
            cfg.skills?.dream?.enabled !== false &&
            cfg.skills?.dream?.auto !== false;
          if (dreamEnabled) {
            const dreamGate = checkCheapGates(
              effectiveDreamStateDir,
              cfg.skills?.dream ?? {},
            );
            if (dreamGate.proceed) {
              const enqueueResult = session.queueDreamJob(
                effectiveDreamStateDir,
                {
                  userId: _effectiveUserId(sessionId),
                  sessionId,
                  stateDir: effectiveDreamStateDir,
                  stateSource: effectiveDreamStateSource,
                  reason: `sessions_since=${sessionUpdate.state.sessionsSince}`,
                  priority: sessionUpdate.state.sessionsSince,
                },
              );
              if (enqueueResult.enqueued) {
                logDreamDiagnostics(api, _captureEvent, "enqueued", effectiveDreamStateDir, {
                  job_id: enqueueResult.job?.id,
                  user_id: _effectiveUserId(sessionId),
                  session_id: sessionId,
                  reason: `sessions_since=${sessionUpdate.state.sessionsSince}`,
                  runtime_state_dir_present: Boolean(runtimeStateDir),
                  state_dir_source: effectiveDreamStateSource,
                });
              } else {
                logDreamDiagnostics(api, _captureEvent, "enqueue_skipped", effectiveDreamStateDir, {
                  reason: enqueueResult.skippedReason ?? "duplicate_pending_or_running_job",
                  job_id: enqueueResult.job?.id,
                  user_id: _effectiveUserId(sessionId),
                  session_id: sessionId,
                  runtime_state_dir_present: Boolean(runtimeStateDir),
                  state_dir_source: effectiveDreamStateSource,
                });
              }
            } else {
              logDreamDiagnostics(api, _captureEvent, "gate_skipped", effectiveDreamStateDir, {
                reason: dreamGate.reason ?? "cheap_gate_failed",
                user_id: _effectiveUserId(sessionId),
                session_id: sessionId,
                runtime_state_dir_present: Boolean(runtimeStateDir),
                state_dir_source: effectiveDreamStateSource,
              });
            }
          }
        }
      }

      api.logger.info("openclaw-mem0: skills-mode agent_end (no auto-capture)");
    });

    return; // Skip legacy hook registration
  }

  // ========================================================================
  // LEGACY MODE: Original auto-recall + auto-capture behavior
  // ========================================================================

  // Track last seen session ID to detect actual new sessions (not every turn)
  let lastRecallSessionId: string | undefined;

  // Auto-recall: inject relevant memories before prompt is built
  if (cfg.autoRecall) {
    const RECALL_TIMEOUT_MS = 8_000;

    api.on("before_prompt_build", async (event: any, ctx: any) => {
      if (!event.prompt || event.prompt.length < 5) return;

      // Skip non-interactive triggers (cron, heartbeat, automation)
      const trigger = (ctx as any)?.trigger ?? undefined;
      const sessionId = (ctx as any)?.sessionKey ?? undefined;
      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info(
          "openclaw-mem0: skipping recall for non-interactive trigger",
        );
        return;
      }

      const promptLower = event.prompt.toLowerCase();
      const isSystemPrompt =
        promptLower.includes("a new session was started") ||
        promptLower.includes("session startup sequence") ||
        promptLower.includes("/new or /reset") ||
        promptLower.startsWith("run your session");
      if (isSystemPrompt) {
        api.logger.info(
          "openclaw-mem0: skipping recall for system/bootstrap prompt",
        );
        return;
      }

      // Update shared state for tools (best-effort — tools don't have ctx)
      if (sessionId) session.setCurrentSessionId(sessionId);

      if (sessionId) lastRecallSessionId = sessionId;

      // Subagents have ephemeral UUIDs — their namespace is always empty.
      // Search the parent (main) user namespace instead so subagents get
      // the user's long-term context.
      const isSubagent = isSubagentSession(sessionId);
      const recallSessionKey = isSubagent ? undefined : sessionId;

      // Strip OpenClaw sender metadata from the prompt before searching
      const searchPrompt = resolveAutoRecallQuery(
        event.prompt,
        event.messages,
      );

      const recallStart = Date.now();
      const recallWork = async () => {
        // Single search with a reasonable candidate pool
        const recallTopK = Math.max((cfg.topK ?? 5) * 2, 10);
        const recallSearchOpts = buildSearchOptions(
          undefined,
          recallTopK,
          undefined,
          recallSessionKey,
        );
        recallSearchOpts.threshold = Math.max(cfg.searchThreshold, 0.5);

        // Search long-term memories (user-scoped; subagents read from parent namespace)
        let longTermResults = await provider.search(
          searchPrompt,
          recallSearchOpts,
        );

        // Client-side threshold filter for auto-recall keeps a conservative
        // baseline so weak matches do not flood the context.
        const recallThreshold = recallSearchOpts.threshold ?? cfg.searchThreshold;
        longTermResults = longTermResults.filter(
          (r) => (r.score ?? 0) >= recallThreshold,
        );

        // Dynamic thresholding: drop memories scoring less than 50% of
        // the top result's score to filter out the long tail of weak matches
        if (longTermResults.length > 1) {
          const topScore = longTermResults[0]?.score ?? 0;
          if (topScore > 0) {
            longTermResults = longTermResults.filter(
              (r) => (r.score ?? 0) >= topScore * 0.5,
            );
          }
        }

        // Cap at configured topK after filtering
        longTermResults = longTermResults.slice(0, cfg.topK);

        if (longTermResults.length === 0) return undefined;

        // Build context with clear labels
        const memoryContext = longTermResults
          .map(
            (r) =>
              `- ${r.memory}${r.categories?.length ? ` [${r.categories.join(", ")}]` : ""}`,
          )
          .join("\n");

        _captureEvent("openclaw.hook.recall", {
          strategy: "legacy",
          memory_count: longTermResults.length,
          latency_ms: Date.now() - recallStart,
        });

        api.logger.info(
          `openclaw-mem0: injecting ${longTermResults.length} memories into context`,
        );

        const preamble = isSubagent
          ? `The following are stored memories for user "${cfg.userId}". You are a subagent — use these memories for context but do not assume you are this user.`
          : `The following are stored memories for user "${cfg.userId}". Use them to personalize your response:`;

        return {
          prependContext: `<relevant-memories>\n${preamble}\n${memoryContext}\n</relevant-memories>`,
        };
      };

      try {
        const timeout = new Promise<undefined>((resolve) => {
          setTimeout(() => resolve(undefined), RECALL_TIMEOUT_MS);
        });
        const result = await Promise.race([
          recallWork(),
          timeout.then(() => {
            api.logger.warn(
              `openclaw-mem0: recall timed out after ${RECALL_TIMEOUT_MS}ms, skipping`,
            );
            return undefined;
          }),
        ]);
        return result;
      } catch (err) {
        api.logger.warn(`openclaw-mem0: recall failed: ${String(err)}`);
      }
    });
  }

  // Auto-capture: store conversation context after agent ends.
  if (cfg.autoCapture) {
    api.on("agent_end", async (event, ctx) => {
      if (!event.success || !event.messages || event.messages.length === 0) {
        return;
      }

      // Skip non-interactive triggers (cron, heartbeat, automation)
      const trigger = (ctx as any)?.trigger ?? undefined;
      const sessionId = (ctx as any)?.sessionKey ?? undefined;
      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info(
          "openclaw-mem0: skipping capture for non-interactive trigger",
        );
        return;
      }

      // Skip capture for subagents — their ephemeral UUIDs create orphaned
      // namespaces that are never read again. The main agent's agent_end
      // hook captures the consolidated result including subagent output.
      if (isSubagentSession(sessionId)) {
        api.logger.info(
          "openclaw-mem0: skipping capture for subagent (main agent captures consolidated result)",
        );
        return;
      }

      // Update shared state for tools (best-effort — tools don't have ctx)
      if (sessionId) session.setCurrentSessionId(sessionId);

      const MEMORY_MUTATE_TOOLS = new Set([
        "memory_add",
        "memory_update",
        "memory_delete",
      ]);
      const agentUsedMemoryTool = event.messages.some((msg: any) => {
        if (msg?.role !== "assistant" || !Array.isArray(msg?.content))
          return false;
        return msg.content.some(
          (block: any) =>
            (block?.type === "tool_use" || block?.type === "toolCall") &&
            MEMORY_MUTATE_TOOLS.has(block.name),
        );
      });
      if (agentUsedMemoryTool) {
        api.logger.info(
          "openclaw-mem0: skipping auto-capture — agent already used memory tools this turn",
        );
        return;
      }

      // --- Build capture payload synchronously (cheap), then fire-and-forget ---

      // Patterns indicating an assistant message contains a summary of
      // completed work — these are high-value for extraction and should
      // be included even if they fall outside the recent-message window.
      const SUMMARY_PATTERNS = [
        /## What I (Accomplished|Built|Updated)/i,
        /✅\s*(Done|Complete|All done)/i,
        /Here's (what I updated|the recap|a summary)/i,
        /### Changes Made/i,
        /Implementation Status/i,
        /All locked in\. Quick summary/i,
      ];

      // First pass: extract all messages into a typed array
      const allParsed: Array<{
        role: string;
        content: string;
        index: number;
        isSummary: boolean;
      }> = [];

      for (let i = 0; i < event.messages.length; i++) {
        const msg = event.messages[i];
        if (!msg || typeof msg !== "object") continue;
        const msgObj = msg as Record<string, unknown>;

        const role = msgObj.role;
        if (role !== "user" && role !== "assistant") continue;

        let textContent = "";
        const content = msgObj.content;

        if (typeof content === "string") {
          textContent = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block &&
              typeof block === "object" &&
              "text" in block &&
              typeof (block as Record<string, unknown>).text === "string"
            ) {
              textContent +=
                (textContent ? "\n" : "") +
                ((block as Record<string, unknown>).text as string);
            }
          }
        }

        if (!textContent) continue;
        // Strip injected memory context, keep the actual user text
        if (textContent.includes("<relevant-memories>")) {
          textContent = textContent
            .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "")
            .trim();
          if (!textContent) continue;
        }
        // Strip OpenClaw sender metadata prefix (prevents storing TUI identity as memory)
        if (
          textContent.includes("Sender") &&
          textContent.includes("untrusted metadata")
        ) {
          textContent = textContent
            .replace(
              /Sender\s*\(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi,
              "",
            )
            .trim();
          if (!textContent) continue;
        }

        const isSummary =
          role === "assistant" &&
          SUMMARY_PATTERNS.some((p) => p.test(textContent));

        allParsed.push({
          role: role as string,
          content: textContent,
          index: i,
          isSummary,
        });
      }

      if (allParsed.length === 0) return;

      // Select messages: last 20 + any earlier summary messages,
      // sorted by original index to preserve chronological order.
      const recentWindow = 20;
      const recentCutoff = allParsed.length - recentWindow;

      const candidates: typeof allParsed = [];

      // Include summary messages from anywhere in the conversation
      for (const msg of allParsed) {
        if (msg.isSummary && msg.index < recentCutoff) {
          candidates.push(msg);
        }
      }

      // Include recent messages
      const seenIndices = new Set(candidates.map((m) => m.index));
      for (const msg of allParsed) {
        if (msg.index >= recentCutoff && !seenIndices.has(msg.index)) {
          candidates.push(msg);
        }
      }

      // Sort by original position so the extraction model sees
      // messages in the order they actually occurred
      candidates.sort((a, b) => a.index - b.index);

      const selected = candidates.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Apply noise filtering pipeline: drop noise, strip fragments, truncate
      const formattedMessages = filterMessagesForExtraction(selected);

      if (formattedMessages.length === 0) return;

      // Skip if no meaningful user content remains after filtering
      if (!formattedMessages.some((m) => m.role === "user")) return;
      const userContent = formattedMessages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join(" ");
      if (userContent.length < 50) {
        api.logger.info(
          "openclaw-mem0: skipping capture — user content too short for meaningful extraction",
        );
        return;
      }

      // Inject a timestamp preamble so the extraction model can anchor
      // time-sensitive facts to a concrete date and attribute to the correct user
      const timestamp = new Date().toISOString().split("T")[0];
      formattedMessages.unshift({
        role: "system",
        content: `Current date: ${timestamp}. The user is identified as "${cfg.userId}". Extract durable facts from this conversation. Include this date when storing time-sensitive information.`,
      });

      const addOpts = buildAddOptions(undefined, sessionId, sessionId);
      const captureStart = Date.now();
      provider
        .add(formattedMessages, addOpts)
        .then((result) => {
          const capturedCount = result.results?.length ?? 0;
          _captureEvent("openclaw.hook.capture", {
            captured_count: capturedCount,
            latency_ms: Date.now() - captureStart,
          });
          if (capturedCount > 0) {
            api.logger.info(
              `openclaw-mem0: auto-captured ${capturedCount} memories`,
            );
          }
        })
        .catch((err) => {
          api.logger.warn(`openclaw-mem0: capture failed: ${String(err)}`);
        });
    });
  }
}

export default memoryPlugin;
