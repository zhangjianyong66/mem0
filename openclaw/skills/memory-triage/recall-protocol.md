---
name: memory-recall
description: Protocol for searching and using recalled memories. Defines minimal query cleanup for retrieval.
applies_to: memory-triage
---

# Recalled Memories

Below your instructions you will find a `<recalled-memories>` section containing stored facts about this user. These memories persist across sessions and channels.

## Acting on Recalled Memories

Personalize naturally. If you know the user's name, use it. If you know their preferences, respect them. Do not announce that you are using memory. Never say "I remember that you..." or "According to my memory..." Act on the information without drawing attention to the mechanism.

Identity memories are ground truth. Trust name, role, timezone, system configurations unless the user explicitly corrects them.

Rules are mandatory. If a recalled memory says "User rule: never do X", follow it. Rules override your defaults.

Check timestamps. Project and operational memories have temporal anchors ("As of ..."). If a memory looks outdated, verify before relying on it.

## Before Recommending from Memory

A memory is a claim about what was true when it was written. It may no longer be true. Before recommending based on a memory:

- If the memory names a tool, service, or configuration: confirm it is still in use.
- If the memory names a preference: it may have evolved. Use it as a default, not an absolute.
- If the user is about to act on your recommendation, verify the memory first.

"The memory says X" is not the same as "X is true now."

## When to Search for More Context

Use `memory_search` when:

- The user references something not covered by your recalled memories
- The conversation topic shifts to a new domain
- The user asks "do you remember" or "what was" or references a past conversation
- You need to find an existing memory before updating it

Do NOT search when:
- Recalled memories already cover the topic
- The turn has no memory-relevant content
- A search query would be too generic to return useful results

## Constructing Search Queries

This section defines exactly how to write a memory_search query. Follow this process for every call. Do not skip steps. Do not add bridge terms or change the user's intent.

### Query Style

The search engine matches your query against stored memories using vector similarity and keyword overlap. Stored memories are factual third-person statements like "User is a data scientist based in Berlin" or "User decided to adopt weekly sprint reviews because biweekly was too slow." The user's conversational message contains filler words ("can you", "I was wondering", "help me") that can be dropped, but do not rewrite the request into a different category.

### The Process

For every memory_search call, follow these three steps:

**Step 1. Name your target.**
Before writing the query, identify what kind of stored memory you expect to find.

**Step 2. Extract signal words.**
Pull out every proper noun, technical term, domain concept, and specific detail from the user's message. Drop conversational framing, questions, pronouns, and filler.

**Step 3. Keep the original phrasing close.**
Use the user's wording or a lightly cleaned version. Do not add bridge terms like `preference`, `rule`, `configuration`, or `decision` unless the user explicitly asked for that category.

### Worked Examples

Each example shows the full reasoning chain. The examples deliberately span different domains to prevent anchoring on any single use case.

**Example 1: Looking for a person**
```
User: "Who was that nutritionist my wife recommended?"
Step 1: Target = a relationship or reference memory about a nutritionist
Step 2: Signal = nutritionist, wife, recommended
Step 3: Keep = nutritionist, wife recommended
Step 4: memory_search("nutritionist wife recommended")
```

**Example 2: Looking for a preference**
```
User: "How do I like my reports formatted again?"
Step 1: Target = a preference about report formatting
Step 2: Signal = reports, formatted
Step 3: Keep = "reports formatted"
Step 4: memory_search("reports formatted")
```

**Example 3: Looking for a technical decision**
```
User: "Remind me why we picked that message queue"
Step 1: Target = a decision memory about message queue technology
Step 2: Signal = message queue, picked, why
Step 3: Keep = message queue, picked, why
Step 4: memory_search("message queue picked why")
```

**Example 4: Looking for identity info**
```
User: "What timezone am I in?"
Step 1: Target = identity memory with timezone
Step 2: Signal = timezone
Step 3: Keep = timezone
Step 4: memory_search("timezone")
```

**Example 5: Looking for a rule**
```
User: "Is there anything I told you to always do before deploying?"
Step 1: Target = a rule memory about deployment
Step 2: Signal = deploy, always do, before
Step 3: Keep = deploy, always, before
Step 4: memory_search("deploy always before")
```

**Example 6: Looking for a project update**
```
User: "Where are we with the onboarding redesign?"
Step 1: Target = a project memory about onboarding
Step 2: Signal = onboarding, redesign
Step 3: Keep = onboarding, redesign
Step 4: memory_search("onboarding redesign")
```

**Example 7: Looking for a life event**
```
User: "When's my sister's birthday?"
Step 1: Target = a relationship or life event memory about the user's sister
Step 2: Signal = sister, birthday
Step 3: Keep = sister, birthday
Step 4: memory_search("sister birthday")
```

### Failure Patterns

These query patterns produce poor results. Recognize and avoid them.

| Pattern | Why it fails | Fix |
|---|---|---|
| Raw user message as query | Noise words ("can you", "help me") dilute signal | Extract entities and concepts only |
| Question words in query | "what", "how", "when", "who" are not in stored memories | Drop all question framing |
| Pronouns in query | "we", "our", "my", "I" do not appear in third-person memories | Use "user" or the entity name |
| Dropping available specifics | Too narrow, misses related context | Keep all specific terms the user provided |
| More than 8 keywords | Too broad, ranks everything equally | Trim to strongest 4-5 terms |
| Vague category words only | "user information stuff" matches everything | Include at least one specific entity or concept |
| Repeating the same search | If a search returned nothing, a rephrased version of the same query will likely also return nothing | Try a different angle or accept the memory does not exist |

## Constructing Filters

The `filters` parameter narrows search results by time, category, or metadata. Use it alongside your search query. The query handles semantic relevance. Filters handle structural constraints.

### When to Add Filters

Add filters when the user's intent implies a structural constraint beyond semantic similarity:

- Time references ("last week", "recently", "in January", "yesterday"): add `created_at` filter with gte/lte dates
- Category requests ("my preferences", "any rules", "what decisions"): add `categories` filter
- Recency bias ("latest", "most recent", "current"): add `created_at` with recent date
- No time or category signal in the user's message: do not add filters. Let the query handle it alone.

### Filter Syntax

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `icontains`
Logical: `AND`, `OR`, `NOT` (wrap conditions in arrays)
Date format: YYYY-MM-DD

### Worked Examples with Filters

```
User: "What did we decide last week about the migration?"
Query: "migration"
Filter: created_at >= 7 days ago
Call: memory_search("migration", filters: {"created_at": {"gte": "2026-03-25"}})
```

```
User: "What are all my standing rules?"
Query: "standing rules"
Filter: category = rule
Call: memory_search("standing rules", categories: ["rule"])
```

```
User: "Show me recent project updates"
Query: "recent updates"
Filter: category + time
Call: memory_search("recent updates", categories: ["project"], filters: {"created_at": {"gte": "2026-03-01"}})
```

```
User: "What preferences have I shared?"
Query: "preferences shared"
Filter: category = preference
Call: memory_search("preferences shared", categories: ["preference"])
```

```
User: "What do you know about me?"
Query: "about me"
Filter: category = identity
Call: memory_search("about me", categories: ["identity"])
```

```
User: "Anything from our conversation yesterday?"
Query: "conversation"
Filter: date range = yesterday
Call: memory_search("conversation", filters: {"created_at": {"gte": "2026-03-31", "lte": "2026-04-01"}})
```

### When NOT to Add Filters

- The user's message has no time signal and no category signal. Just use the cleaned query.
- You are unsure of the exact date. Do not guess dates. Omit the filter and let vector search handle it.
- The query is already narrow enough. Adding filters to a very specific query risks filtering out the answer.

## When NOT to Search

- Recalled memories already cover the topic. Do not re-search for what is in front of you.
- The turn has no memory-relevant content. Most turns do not need a search.
- The query would be too generic to return useful results.
