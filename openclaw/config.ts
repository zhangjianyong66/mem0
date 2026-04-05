/**
 * Configuration parsing, env var resolution, and defaults.
 */

import type { Mem0Config, Mem0Mode, DefaultScopeConfig, FeaturesConfig } from "./types.ts";

// ============================================================================
// Default Instructions & Categories
// ============================================================================

export const DEFAULT_CUSTOM_INSTRUCTIONS = `Your Task: Extract durable, actionable facts from conversations between a user and an AI assistant. Only store information that would be useful to an agent in a FUTURE session, days or weeks later.

Before storing any fact, ask: "Would a new agent — with no prior context — benefit from knowing this?" If the answer is no, do not store it.

Information to Extract (in priority order):

1. Configuration & System State Changes:
   - Tools/services configured, installed, or removed (with versions/dates)
   - Model assignments for agents, API keys configured (NEVER the key itself — see Exclude)
   - Cron schedules, automation pipelines, deployment configurations
   - Architecture decisions (agent hierarchy, system design, deployment strategy)
   - Specific identifiers: file paths, sheet IDs, channel IDs, user IDs, folder IDs

2. Standing Rules & Policies:
   - Explicit user directives about behavior ("never create accounts without consent")
   - Workflow policies ("each agent must review model selection before completing a task")
   - Security constraints, permission boundaries, access patterns

3. Identity & Demographics:
   - Name, location, timezone, language preferences
   - Occupation, employer, job role, industry

4. Preferences & Opinions:
   - Communication style preferences
   - Tool and technology preferences (with specifics: versions, configs)
   - Strong opinions or values explicitly stated
   - The WHY behind preferences when stated

5. Goals, Projects & Milestones:
   - Active projects (name, description, current status)
   - Completed setup milestones ("ElevenLabs fully configured as of 2026-02-20")
   - Deadlines, roadmaps, and progress tracking
   - Problems actively being solved

6. Technical Context:
   - Tech stack, tools, development environment
   - Agent ecosystem structure (names, roles, relationships)
   - Skill levels in different areas

7. Relationships & People:
   - Names and roles of people mentioned (colleagues, family, clients)
   - Team structure, key contacts

8. Decisions & Lessons:
   - Important decisions made and their reasoning
   - Lessons learned, strategies that worked or failed

Guidelines:

TEMPORAL ANCHORING (critical):
- ALWAYS include temporal context for time-sensitive facts using "As of YYYY-MM-DD, ..."
- Extract dates from message timestamps, dates mentioned in the text, or the system-provided current date
- If no date is available, note "date unknown" rather than omitting temporal context

CONCISENESS:
- Use third person ("User prefers..." not "I prefer...")
- Keep related facts together in a single memory to preserve context

OUTCOMES OVER INTENT:
- When an assistant message summarizes completed work, extract the durable OUTCOMES
- Extract what WAS DONE, not what was requested

DEDUPLICATION:
- Before creating a new memory, check if a substantially similar fact already exists
- If so, UPDATE the existing memory with any new details rather than creating a duplicate

LANGUAGE:
- ALWAYS preserve the original language of the conversation

Exclude (NEVER store):
- Passwords, API keys, tokens, secrets, or any credentials
- One-time commands or instructions
- Acknowledgments or emotional reactions
- Transient UI/navigation states
- Ephemeral process status
- The current date/time as a standalone fact`;

export const DEFAULT_CUSTOM_CATEGORIES: Record<string, string> = {
  identity: "Personal identity information: name, age, location, timezone, occupation, employer, education, demographics",
  preferences: "Explicitly stated likes, dislikes, preferences, opinions, and values across any domain",
  goals: "Current and future goals, aspirations, objectives, targets the user is working toward",
  projects: "Specific projects, initiatives, or endeavors the user is working on, including status and details",
  technical: "Technical skills, tools, tech stack, development environment, programming languages, frameworks",
  decisions: "Important decisions made, reasoning behind choices, strategy changes, and their outcomes",
  relationships: "People mentioned by the user: colleagues, family, friends, their roles and relevance",
  routines: "Daily habits, work patterns, schedules, productivity routines, health and wellness habits",
  lifeEvents: "Significant life events, milestones, transitions, upcoming plans and changes",
  lessons: "Lessons learned, insights gained, mistakes acknowledged, changed opinions or beliefs",
  work: "Work-related context: job responsibilities, workplace dynamics, career progression, professional challenges",
  health: "Health-related information voluntarily shared: conditions, medications, fitness, wellness goals",
};

// ============================================================================
// Default Configuration Values
// ============================================================================

const DEFAULT_FEATURES: FeaturesConfig = {
  autoRecall: true,
  autoCapture: true,
  auditLog: false,
  graph: false,
};

// ============================================================================
// Config Schema
// ============================================================================

const ALLOWED_KEYS = [
  "mode",
  "apiKey",
  "projectId",
  "defaultScope",
  "features",
  "customInstructions",
  "customCategories",
  "oss",
  "skills",
  "searchThreshold",
  "topK",
];

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export const mem0ConfigSchema = {
  parse(value: unknown): Mem0Config {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("openclaw-mem0 config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ALLOWED_KEYS, "openclaw-mem0 config");

    // Determine mode
    const mode: Mem0Mode =
      cfg.mode === "oss" || cfg.mode === "open-source" ? "open-source" : "platform";

    // Platform mode requires apiKey
    const needsSetup = mode === "platform" && (typeof cfg.apiKey !== "string" || !cfg.apiKey);

    // Parse defaultScope (required)
    let defaultScope: DefaultScopeConfig;
    if (cfg.defaultScope && typeof cfg.defaultScope === "object" && !Array.isArray(cfg.defaultScope)) {
      const scopeCfg = cfg.defaultScope as Record<string, unknown>;
      const userId = scopeCfg.userId;
      if (typeof userId !== "string" || !userId) {
        throw new Error("defaultScope.userId is required and must be a non-empty string");
      }
      defaultScope = {
        userId,
        orgId: typeof scopeCfg.orgId === "string" ? scopeCfg.orgId : undefined,
        appId: typeof scopeCfg.appId === "string" ? scopeCfg.appId : undefined,
      };
    } else {
      // Fallback: use legacy userId field for migration
      const legacyUserId = cfg.userId;
      if (typeof legacyUserId !== "string" || !legacyUserId) {
        throw new Error("defaultScope.userId is required (or provide legacy userId field)");
      }
      defaultScope = { userId: legacyUserId };
    }

    // Parse features
    let features: FeaturesConfig = { ...DEFAULT_FEATURES };
    if (cfg.features && typeof cfg.features === "object" && !Array.isArray(cfg.features)) {
      const featCfg = cfg.features as Record<string, unknown>;
      features = {
        autoRecall: featCfg.autoRecall !== false,
        autoCapture: featCfg.autoCapture !== false,
        auditLog: featCfg.auditLog === true,
        graph: featCfg.graph === true,
      };
    }

    // Parse OSS config
    let ossConfig: Mem0Config["oss"];
    if (cfg.oss && typeof cfg.oss === "object" && !Array.isArray(cfg.oss)) {
      ossConfig = cfg.oss as Mem0Config["oss"];
    }

    return {
      mode,
      apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey : undefined,
      projectId: typeof cfg.projectId === "string" ? cfg.projectId : undefined,
      defaultScope,
      features,
      customInstructions:
        typeof cfg.customInstructions === "string"
          ? cfg.customInstructions
          : DEFAULT_CUSTOM_INSTRUCTIONS,
      customCategories:
        cfg.customCategories &&
          typeof cfg.customCategories === "object" &&
          !Array.isArray(cfg.customCategories)
          ? (cfg.customCategories as Record<string, string>)
          : DEFAULT_CUSTOM_CATEGORIES,
      oss: ossConfig,
      skills:
        cfg.skills && typeof cfg.skills === "object" && !Array.isArray(cfg.skills)
          ? (cfg.skills as Mem0Config["skills"])
          : undefined,
      searchThreshold: typeof cfg.searchThreshold === "number" ? cfg.searchThreshold : 0.5,
      topK: typeof cfg.topK === "number" ? cfg.topK : 5,
      needsSetup,
    };
  },
};