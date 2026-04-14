import { createHash } from "node:crypto";

type StableMetadata = {
  topicKey: string;
  entityKey: string;
  sourceKind: string;
  temporalScope: string;
};

const SOURCE_KIND_BY_CATEGORY: Record<string, string> = {
  rule: "rule",
  configuration: "config",
  decision: "decision",
  preference: "preference",
  project: "project",
  technical: "technical",
  identity: "identity",
  relationship: "relationship",
};

const TEMPORAL_SCOPE_BY_CATEGORY: Record<string, string> = {
  rule: "stable",
  identity: "stable",
  preference: "stable",
  configuration: "ongoing",
  decision: "ongoing",
  project: "ongoing",
  technical: "historical",
  relationship: "historical",
};

const QUOTED_ENTITY_PATTERNS = [
  /`([^`]{2,80})`/g,
  /"([^"]{2,80})"/g,
  /'([^']{2,80})'/g,
  /“([^”]{2,80})”/g,
  /「([^」]{2,80})」/g,
];

function normalizeFact(text: string): string {
  return text
    .replace(/as of \d{4}-\d{2}-\d{2},?\s*/gi, "")
    .replace(/截至\s*\d{4}-\d{2}-\d{2}[，,\s]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function stableHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 10);
}

function extractQuotedEntity(text: string): string | undefined {
  for (const pattern of QUOTED_ENTITY_PATTERNS) {
    const match = pattern.exec(text);
    pattern.lastIndex = 0;
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function extractTechnicalToken(text: string): string | undefined {
  const match = text.match(/\b[a-zA-Z][a-zA-Z0-9._/-]{2,63}\b/);
  return match?.[0];
}

function extractRuleTopic(text: string): string | undefined {
  const english = text.match(/user rule:\s*([^.;\n]{3,80})/i)?.[1];
  if (english) return english.trim();
  const chinese = text.match(/用户规则[:：]\s*([^。；\n]{2,40})/)?.[1];
  if (chinese) return chinese.trim();
  return undefined;
}

function extractPreferenceTopic(text: string): string | undefined {
  const english = text.match(/user prefers?\s+([^.;,\n]{2,80})/i)?.[1];
  if (english) return english.trim();
  const chinese = text.match(/用户(?:偏好|喜欢|更喜欢)\s*([^。；，\n]{2,40})/)?.[1];
  if (chinese) return chinese.trim();
  return undefined;
}

function extractDecisionTopic(text: string): string | undefined {
  const decisionVerb =
    text.match(
      /\b(?:migrating|migrate|switched|switch|changed|change|use|using|decided to use|configured)\s+([^.;,\n]{2,80})/i,
    )?.[1] ??
    text.match(/(?:改成|切到|使用|决定使用|配置为)\s*([^。；，\n]{2,40})/)?.[1];
  return decisionVerb?.trim();
}

function deriveTopicSeed(category: string | undefined, facts: string[]): string {
  const combined = normalizeFact(facts.join(" "));
  const quoted = extractQuotedEntity(combined);
  if (quoted) return quoted;

  if (category === "rule") {
    const value = extractRuleTopic(combined);
    if (value) return value;
  }
  if (category === "preference") {
    const value = extractPreferenceTopic(combined);
    if (value) return value;
  }
  if (category === "decision" || category === "configuration" || category === "project") {
    const value = extractDecisionTopic(combined);
    if (value) return value;
  }

  const technicalToken = extractTechnicalToken(combined);
  if (technicalToken) return technicalToken;

  return combined;
}

function inferEntityType(category: string | undefined): string {
  switch (category) {
    case "identity":
      return "person";
    case "relationship":
      return "person";
    case "configuration":
      return "system";
    case "decision":
      return "project";
    case "project":
      return "project";
    case "rule":
      return "rule";
    default:
      return "topic";
  }
}

function makeStableKey(prefix: string, seed: string, fallbackGroup: string): string {
  const slug = slugify(seed);
  if (slug) return `${prefix}:${slug}`;
  return `${prefix}:${fallbackGroup}-${stableHash(seed)}`;
}

export function buildStableMemoryMetadata(
  facts: string[],
  category?: string,
  metadata?: Record<string, unknown>,
): StableMetadata {
  const sourceKind =
    typeof metadata?.sourceKind === "string" && metadata.sourceKind.trim()
      ? metadata.sourceKind.trim()
      : SOURCE_KIND_BY_CATEGORY[category ?? ""] ?? (category || "memory");

  const temporalScope =
    typeof metadata?.temporalScope === "string" && metadata.temporalScope.trim()
      ? metadata.temporalScope.trim()
      : TEMPORAL_SCOPE_BY_CATEGORY[category ?? ""] ?? "historical";

  const topicSeed = deriveTopicSeed(category, facts);
  const topicKey =
    typeof metadata?.topicKey === "string" && metadata.topicKey.trim()
      ? metadata.topicKey.trim()
      : makeStableKey(sourceKind, topicSeed, category || "memory");

  const entityKey =
    typeof metadata?.entityKey === "string" && metadata.entityKey.trim()
      ? metadata.entityKey.trim()
      : makeStableKey(inferEntityType(category), topicSeed, category || "memory");

  return {
    topicKey,
    entityKey,
    sourceKind,
    temporalScope,
  };
}
