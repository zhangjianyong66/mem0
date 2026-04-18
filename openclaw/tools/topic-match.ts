import type { MemoryItem } from "../types.ts";

const CATEGORY_ALIASES: Record<string, string> = {
  rule: "rule",
  rules: "rule",
  preference: "preference",
  preferences: "preference",
  identity: "identity",
  identities: "identity",
  decision: "decision",
  decisions: "decision",
  configuration: "configuration",
  configurations: "configuration",
  config: "configuration",
  project: "project",
  projects: "project",
  technical: "technical",
  relationship: "relationship",
  relationships: "relationship",
  operational: "operational",
};

function normalizeCategory(category: string): string {
  const normalized = category.trim().toLowerCase();
  return CATEGORY_ALIASES[normalized] ?? normalized;
}

export function getMemoryCategory(memory: MemoryItem): string {
  if (
    memory.metadata?.category &&
    typeof memory.metadata.category === "string"
  ) {
    return normalizeCategory(memory.metadata.category);
  }
  const firstCategory = memory.categories?.[0];
  if (typeof firstCategory === "string" && firstCategory.trim()) {
    return normalizeCategory(firstCategory);
  }
  return "uncategorized";
}

export function normalizeMemoryText(text: string): string {
  return text
    .toLowerCase()
    .replace(/as of \d{4}-\d{2}-\d{2},?\s*/g, "")
    .replace(/截至\s*\d{4}-\d{2}-\d{2}[，,\s]*/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getTopicKey(memory: MemoryItem): string | undefined {
  const topicKey = memory.metadata?.topicKey;
  if (typeof topicKey === "string" && topicKey.trim()) return topicKey.trim();
  const entityKey = memory.metadata?.entityKey;
  if (typeof entityKey === "string" && entityKey.trim()) return entityKey.trim();
  return undefined;
}

export function getEntityKey(memory: MemoryItem): string | undefined {
  const entityKey = memory.metadata?.entityKey;
  if (typeof entityKey === "string" && entityKey.trim()) return entityKey.trim();
  return undefined;
}

export function overlapScore(a: string, b: string): number {
  const aTerms = new Set(a.split(" ").filter(Boolean));
  const bTerms = new Set(b.split(" ").filter(Boolean));
  if (aTerms.size === 0 || bTerms.size === 0) return 0;
  let overlap = 0;
  for (const term of aTerms) {
    if (bTerms.has(term)) overlap += 1;
  }
  return overlap / Math.max(aTerms.size, bTerms.size);
}

export function isSameTopic(a: MemoryItem, b: MemoryItem): boolean {
  const aTopic = getTopicKey(a);
  const bTopic = getTopicKey(b);
  if (aTopic && bTopic) return aTopic === bTopic;

  const aEntity = getEntityKey(a);
  const bEntity = getEntityKey(b);
  if (aEntity && bEntity) return aEntity === bEntity;

  const aCat = getMemoryCategory(a);
  const bCat = getMemoryCategory(b);
  if (aCat !== bCat) return false;

  const aText = normalizeMemoryText(a.memory);
  const bText = normalizeMemoryText(b.memory);
  if (!aText || !bText) return false;
  if (aText === bText) return true;

  return overlapScore(aText, bText) >= 0.6;
}

export function chooseBetterMemory(a: MemoryItem, b: MemoryItem): MemoryItem {
  const scoreA = a.score ?? 0;
  const scoreB = b.score ?? 0;
  if (scoreA !== scoreB) return scoreA > scoreB ? a : b;

  const lenA = a.memory.length;
  const lenB = b.memory.length;
  if (lenA !== lenB) return lenA > lenB ? a : b;

  const updatedA = a.updated_at ?? a.created_at ?? "";
  const updatedB = b.updated_at ?? b.created_at ?? "";
  return updatedA >= updatedB ? a : b;
}
