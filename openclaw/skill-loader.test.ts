/**
 * Tests for path traversal prevention in skill-loader.
 */
import { describe, it, expect } from "vitest";
import { safePath, loadSkill, loadTriagePrompt } from "./skill-loader.ts";

// ---------------------------------------------------------------------------
// safePath — path containment
// ---------------------------------------------------------------------------
describe("safePath", () => {
  it("rejects parent directory traversal", () => {
    expect(safePath("../../etc/passwd")).toBeNull();
  });

  it("rejects deep traversal", () => {
    expect(safePath("../../../etc/shadow")).toBeNull();
  });

  it("rejects traversal in nested segment", () => {
    expect(safePath("valid", "../../etc")).toBeNull();
  });

  it("rejects bare '..' as segment", () => {
    expect(safePath("..")).toBeNull();
  });

  it("accepts valid skill paths", () => {
    expect(safePath("memory-triage", "SKILL.md")).not.toBeNull();
  });

  it("accepts valid domain overlay paths", () => {
    expect(safePath("memory-triage", "domains", "companion.md")).not.toBeNull();
  });

  it("returns null for empty segments that resolve to skills root with subpath escape", () => {
    // path.resolve("skills", "", "../../etc") still escapes
    expect(safePath("", "../../etc")).toBeNull();
  });

  it("rejects traversal disguised with valid prefix", () => {
    expect(safePath("memory-triage/../../etc/passwd")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadSkill — integration tests for traversal prevention
// ---------------------------------------------------------------------------
describe("loadSkill path traversal", () => {
  it("returns null for traversal skillName", () => {
    expect(loadSkill("../../etc/passwd")).toBeNull();
  });

  it("returns null for deep traversal skillName", () => {
    expect(loadSkill("../../../..")).toBeNull();
  });

  it("loads a valid skill", () => {
    const result = loadSkill("memory-triage");
    expect(result).not.toBeNull();
    expect(result?.prompt).toBeTruthy();
  });

  it("blocks domain traversal while loading valid skill", () => {
    // Valid skill name, malicious domain — should load skill but skip the overlay
    const result = loadSkill("memory-triage", { domain: "../../etc/passwd" });
    // Should still succeed (skill itself is valid), domain overlay is just skipped
    expect(result).not.toBeNull();
    expect(result?.prompt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// loadTriagePrompt — recall protocol injection
// ---------------------------------------------------------------------------
describe("loadTriagePrompt recall protocol", () => {
  it("includes the recall protocol when recall is enabled", () => {
    const prompt = loadTriagePrompt({ recall: { enabled: true } });

    expect(prompt).toContain("# Recalled Memories");
    expect(prompt).toContain("Do not add bridge terms");
    expect(prompt).toContain('memory_search("nutritionist wife recommended")');
    expect(prompt).toContain('memory_search("message queue picked why")');
    expect(prompt).toContain('memory_search("timezone")');
    expect(prompt).toContain('memory_search("deploy always before")');
    expect(prompt).toContain('memory_search("onboarding redesign")');
  });

  it("does not include the recall protocol when recall is disabled", () => {
    const prompt = loadTriagePrompt({ recall: { enabled: false } });

    expect(prompt).not.toContain("# Recalled Memories");
    expect(prompt).not.toContain('memory_search("nutritionist wife recommended")');
  });

  it("does not include obsolete bridge-term examples", () => {
    const prompt = loadTriagePrompt({ recall: { enabled: true } });

    expect(prompt).not.toContain("nutritionist wife recommended relationship");
    expect(prompt).not.toContain("message queue decision chose rationale");
    expect(prompt).not.toContain("user timezone location based");
    expect(prompt).not.toContain("rule deploy always before");
    expect(prompt).not.toContain("onboarding redesign project status");
    expect(prompt).not.toContain("sister birthday date relationship");
    expect(prompt).not.toContain("project status milestone");
  });

  it("does not require a hosted mem0 API key in injected skills", () => {
    const prompt = loadTriagePrompt({ recall: { enabled: true } });

    expect(prompt).not.toContain("MEM0_API_KEY");
  });
});
