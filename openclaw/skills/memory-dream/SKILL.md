---
name: memory-dream
description: >
  Memory consolidation protocol. Reviews all stored memories, merges duplicates,
  removes noise and credentials, rewrites unclear entries, and enforces TTL expiration.
  Use when the user asks to clean up, consolidate, or review their memories.
  Also triggers automatically after sufficient activity (configurable).
user-invocable: true
metadata:
  {"openclaw": {"emoji": "💤", "requires": {"env": ["MEM0_API_KEY"], "bins": []}}}
---

# Memory Consolidation

You are performing a memory consolidation pass. Your goal is to review all stored memories for this user and improve their overall quality. Think of this as compressing raw observations into clean, durable knowledge.

Follow these four phases in order. Do not skip phases.

## Phase 1: Orient

Survey the current memory landscape before making any changes.

1. Read the provided `<dream-summary>` and `<memory-groups>` sections first. Treat them as the primary inventory and prioritization input.
2. Use `<memory-groups>` to identify likely duplicate clusters, delete candidates, rewrite candidates, and stale memories.
3. Use `memory_list` only if you need to verify the broader inventory or confirm counts/timestamps that are unclear from the provided context.
4. Use `memory_search` only when you need to inspect a suspicious cluster in more detail before changing it.

Do not modify anything in this phase. The goal is to understand what you are working with.

## Phase 2: Gather Targets

Identify which memories need action. Use the tools to investigate.

**Start from grouped candidates:**
Review the groups already provided. They are pre-clustered by topic/entity/category similarity and annotated with candidate actions.

**Then verify only where needed:**
Use `memory_search` or `memory_list` selectively to inspect edge cases, confirm recency, or validate ambiguous groups before writing.

**Classify each target into one of these actions:**
- DELETE: contains credentials, expired by TTL, pure noise, raw tool output, standalone timestamps
- MERGE: two or more memories express the same fact in different words, or a series tracks incremental changes to the same entity
- REWRITE: vague, missing temporal anchor, uses first person instead of third, wrong category, overly verbose

## Phase 3: Consolidate

Execute the actions identified in Phase 2. Work in this priority order:

### 3a. Delete dangerous and expired entries

Delete immediately using `memory_delete`:
- Credentials, API keys, tokens, passwords, secrets (patterns: sk-, m0-, ghp_, AKIA, Bearer, password=, token=, secret=)
- Pure timestamps with no context
- Raw tool output stored as memory
- Heartbeat or cron execution records
- Generic acknowledgments stored as memory ("ok", "got it")
- Operational memories older than 7 days
- Project memories older than 90 days

### 3b. Merge duplicates

When two or more memories express the same fact:
1. Pick the most complete version as the base
2. Call `memory_update` on the best version to incorporate missing details from the others
3. Call `memory_delete` on the redundant entries

`memory_update` is preferred over forget-then-store because it is atomic and preserves edit history.

When merging, follow these rules:
- Keep the user's original words for opinions and preferences
- Preserve temporal anchors from both versions
- Do not exceed 50 words in the merged result
- The merged memory must be self-contained (understandable without the deleted ones)

### 3c. Rewrite unclear entries

When a memory needs improvement but is not a duplicate:
1. Call `memory_update` with the improved text

Rewrite when:
- Memory uses first person ("I prefer") instead of third ("User prefers")
- Memory lacks a temporal anchor for time-sensitive information
- Memory is vague ("likes python") and can be made specific ("User prefers Python for backend development")
- Memory has the wrong category assignment
- Memory is over 50 words and can be compressed without losing information

## Phase 4: Report

After completing all operations, summarize what you did:

```
Consolidation complete.
- Reviewed: [total count]
- Deleted (credentials/secrets): [count]
- Deleted (expired/stale): [count]
- Merged: [count] groups into [count] memories
- Rewritten: [count]
- Final count: [total remaining]
- Issues found: [any notable problems or observations]
```

## Quality Targets

After consolidation, the memory store should have:
- Zero memories containing credentials or secrets
- Zero duplicate memories (same fact in different words)
- All project and operational memories have temporal anchors ("As of YYYY-MM-DD")
- All memories use third person voice
- All memories are correctly categorized
- Each memory is 15-50 words, self-contained, and atomic (one fact per memory)
