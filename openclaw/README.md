# @mem0/openclaw-mem0

Long-term memory for [OpenClaw](https://github.com/openclaw/openclaw) agents, powered by [Mem0](https://mem0.ai).

Your agent forgets everything between sessions. This plugin fixes that. It watches conversations, extracts what matters, and brings it back when relevant — automatically.

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/mem0ai/mem0/main/docs/images/openclaw-architecture.png" alt="Architecture" width="800" />
</p>

**Auto-Recall** — Before the agent responds, the plugin searches Mem0 for memories that match the current message and injects them into context.

**Auto-Capture** — After the agent responds, the plugin filters the conversation through a noise-removal pipeline, then sends the cleaned exchange to Mem0. Mem0 decides what's worth keeping — new facts get stored, stale ones updated, duplicates merged.

Both run silently. No prompting, no configuration, no manual calls.

### Message filtering

Before extraction, messages pass through a multi-stage filtering pipeline:

1. **Noise detection** — Drops entire messages that are system noise: heartbeats (`HEARTBEAT_OK`, `NO_REPLY`), timestamps, single-word acknowledgments (`ok`, `sure`, `done`), system routing metadata, and compaction audit logs.
2. **Generic assistant detection** — Drops short assistant messages that are boilerplate acknowledgments with no extractable facts (e.g. "I see you've shared an update. How can I help?").
3. **Content stripping** — Removes embedded noise fragments (media boilerplate, routing metadata, compaction blocks) from otherwise useful messages.
4. **Truncation** — Caps messages at 2000 characters to avoid sending excessive context.

### Memory hierarchy (4 layers)

Memories are organized into four hierarchical scopes following official Mem0 architecture:

| Scope | Lifetime | Identifier | Description |
|-------|----------|------------|-------------|
| **Conversation** | Single turn | `conversationId` | In-memory only, lost after response |
| **Session** | Minutes to hours | `sessionId` | Short-term context for current conversation |
| **User** | Weeks to permanent | `userId` | Long-term personal memories |
| **Organization** | Global shared | `orgId` / `appId` | Shared across users/apps |

During **auto-recall**, the plugin searches all applicable scopes and presents them with scope labels so the agent knows the source.

### Per-agent memory isolation

In multi-agent setups, each agent automatically gets its own memory namespace. Session keys following the pattern `agent:<agentId>:<uuid>` are parsed to derive isolated namespaces (`${userId}:agent:${agentId}`). Single-agent deployments are unaffected — plain session keys and `agent:main:*` keys resolve to the configured `userId`.

**How it works:**

- The agent's session key is inspected on every recall/capture cycle
- If the key matches `agent:<name>:<uuid>`, memories are stored under `userId:agent:<name>`
- Different agents never see each other's memories unless explicitly queried

**Subagent handling:**

Ephemeral subagents (session keys like `agent:main:subagent:<uuid>`) are handled specially:
- **Recall** is routed to the parent (main user) namespace — subagents get the user's long-term context instead of searching their empty ephemeral namespace
- **Capture** is skipped entirely — the main agent's `agent_end` hook captures the consolidated result including subagent output, preventing orphaned memories
- A **subagent-specific preamble** is used: "You are a subagent — use these memories for context but do not assume you are this user"

### Concurrency safety

Lifecycle hooks (`before_agent_start`, `agent_end`) use `ctx.sessionKey` directly from the event context rather than shared mutable state. This prevents race conditions when multiple sessions run concurrently (e.g. multiple Telegram users chatting simultaneously).

### Non-interactive trigger filtering

The plugin automatically skips recall and capture for non-interactive triggers: `cron`, `heartbeat`, `automation`, and `schedule`. Detection works via both `ctx.trigger` and session key patterns (`:cron:`, `:heartbeat:`). This prevents system-generated noise from polluting long-term memory.

## Setup

```bash
openclaw plugins install @mem0/openclaw-mem0
```

### Platform (Mem0 Cloud)

Get an API key from [app.mem0.ai](https://app.mem0.ai), then add to your `openclaw.json`:

```json5
// plugins.entries
"openclaw-mem0": {
  "enabled": true,
  "config": {
    "apiKey": "${MEM0_API_KEY}",
    "defaultScope": {
      "userId": "alice"  // required: any unique identifier you choose
    }
  }
}
```

### Open-Source (Self-hosted)

No Mem0 key needed. Requires `OPENAI_API_KEY` for default embeddings/LLM.

```json5
"openclaw-mem0": {
  "enabled": true,
  "config": {
    "mode": "open-source",
    "defaultScope": {
      "userId": "alice"  // required: any unique identifier you choose
    }
  }
}
```

### Full configuration example

```json5
"openclaw-mem0": {
  "enabled": true,
  "config": {
    "mode": "platform",
    "apiKey": "${MEM0_API_KEY}",
    "projectId": "my-project",
    "defaultScope": {
      "userId": "alice",        // required
      "orgId": "my-company",    // optional
      "appId": "my-app"         // optional
    },
    "features": {
      "autoRecall": true,       // inject memories before each turn
      "autoCapture": true,      // store facts after each turn
      "auditLog": false,        // record operations to SQLite audit log
      "graph": false            // enable entity graph for relationships
    },
    "topK": 5,                  // max memories per recall
    "searchThreshold": 0.5,     // min similarity (0-1)
    "customInstructions": "...",  // extraction rules (optional)
    "customCategories": {       // category definitions (optional)
      "identity": "Personal identity information",
      "preferences": "Likes, dislikes, preferences"
    }
  }
}
```

### OSS mode configuration

```json5
"config": {
  "mode": "open-source",
  "defaultScope": { "userId": "your-user-id" },
  "oss": {
    "embedder": { "provider": "openai", "config": { "model": "text-embedding-3-small" } },
    "vectorStore": { "provider": "qdrant", "config": { "host": "localhost", "port": 6333 } },
    "llm": { "provider": "openai", "config": { "model": "gpt-4o" } },
    "historyDbPath": "./data/mem0_history.db",
    "disableHistory": false
  }
}
```

All `oss` fields are optional. See [Mem0 OSS docs](https://docs.mem0.ai/open-source/node-quickstart) for providers.

## Agent tools

The agent gets eight tools it can call during conversations:

| Tool | Description |
|------|-------------|
| `memory_search` | Search memories by natural language query |
| `memory_store` | Explicitly save facts to memory |
| `memory_list` | List all stored memories |
| `memory_get` | Retrieve a single memory by ID |
| `memory_forget` | Delete memories by ID or query |
| `memory_update` | Update an existing memory |
| `memory_delete_all` | Delete all memories in a scope |
| `memory_history` | Get edit history for a memory |

### Tool parameters

All tools use unified scope parameters:

```typescript
{
  scope?: "conversation" | "session" | "user" | "organization" | "all",  // default: "user"
  userId?: string,
  sessionId?: string,
  conversationId?: string,
  orgId?: string,
  appId?: string
}
```

**Examples:**

```typescript
// Search user's long-term memories
memory_search({ query: "what languages does the user know" })

// Search session memories
memory_search({ query: "recent context", scope: "session", sessionId: "abc123" })

// Search organization-wide memories
memory_search({ query: "company policies", scope: "organization", orgId: "acme" })

// Store to conversation scope (temporary, in-memory)
memory_store({ facts: ["user is currently looking at file X.ts"], scope: "conversation", conversationId: "turn-1" })

// Store to user scope (permanent)
memory_store({ facts: ["user prefers dark mode"], scope: "user" })
```

## CLI

```bash
# Search all memories
openclaw mem0 search "what languages does the user know"

# Search specific scope
openclaw mem0 search "recent context" --scope session
openclaw mem0 search "company policies" --scope organization --org-id acme

# Stats
openclaw mem0 stats

# Search a specific agent's memories
openclaw mem0 search "user preferences" --agent researcher
```

## Options

### Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | `"platform"` \| `"open-source"` | `"platform"` | Which backend to use |
| `defaultScope.userId` | `string` | — | **Required.** Any unique identifier for the user |
| `defaultScope.orgId` | `string` | — | Organization ID (optional) |
| `defaultScope.appId` | `string` | — | Application ID (optional) |
| `features.autoRecall` | `boolean` | `true` | Inject memories before each turn |
| `features.autoCapture` | `boolean` | `true` | Store facts after each turn |
| `features.auditLog` | `boolean` | `false` | Record operations to SQLite audit log |
| `features.graph` | `boolean` | `false` | Entity graph for relationships |
| `topK` | `number` | `5` | Max memories per recall |
| `searchThreshold` | `number` | `0.5` | Min similarity (0–1) |

### Platform mode

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiKey` | `string` | — | **Required.** Mem0 API key (supports `${MEM0_API_KEY}`) |
| `projectId` | `string` | — | Project ID |
| `customInstructions` | `string` | *(built-in)* | Extraction rules — what to store, how to format |
| `customCategories` | `object` | *(12 defaults)* | Category name → description map |

### Open-source mode

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `oss.embedder.provider` | `string` | `"openai"` | Embedding provider |
| `oss.embedder.config` | `object` | — | Provider config: `apiKey`, `model`, `baseURL` |
| `oss.vectorStore.provider` | `string` | `"memory"` | Vector store (`"memory"`, `"qdrant"`, `"chroma"`) |
| `oss.vectorStore.config` | `object` | — | Provider config: `host`, `port`, `collectionName` |
| `oss.llm.provider` | `string` | `"openai"` | LLM provider |
| `oss.llm.config` | `object` | — | Provider config: `apiKey`, `model`, `baseURL` |
| `oss.historyDbPath` | `string` | — | SQLite path for memory edit history |
| `oss.disableHistory` | `boolean` | `false` | Skip history DB initialization |

## Audit logging

When `features.auditLog` is enabled, all memory operations are logged to SQLite:

```sql
CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  operation    TEXT NOT NULL,      -- 'add', 'search', 'get', 'update', 'delete', 'delete_all'
  memory_id    TEXT,
  user_id      TEXT,
  scope_type   TEXT,               -- 'conversation', 'session', 'user', 'organization'
  query        TEXT,
  result_count INTEGER,
  metadata     TEXT,
  duration_ms  INTEGER,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

The audit log uses the same database file as the history DB (`oss.historyDbPath`).

## License

Apache 2.0