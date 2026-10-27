/**
 * Heuristic prompt-injection filter for free-text fields an AI agent submits.
 *
 * Purchase descriptions should describe goods, never address the system that
 * processes them. Any text that tries to issue instructions, impersonate a
 * chat role, tamper with spending policy or redirect funds is rejected.
 * This is defense in depth: spending caps still apply to everything that passes.
 */

export type InjectionRuleId =
  | "INSTRUCTION_OVERRIDE"
  | "ROLE_IMPERSONATION"
  | "JAILBREAK"
  | "POLICY_TAMPERING"
  | "FUNDS_REDIRECTION"
  | "HIDDEN_CHARACTERS"
  | "MIXED_SCRIPT"
  | "ENCODED_PAYLOAD";

export interface InjectionFinding {
  rule: InjectionRuleId;
  label: string;
  field: string;
}

interface PatternRule {
  id: InjectionRuleId;
  label: string;
  /** Matched against the normalized (lowercased, NFKC, whitespace-collapsed) text. */
  pattern: RegExp;
}

/** Zero-width, bidi-override and other invisible characters used to smuggle or hide text. */
const HIDDEN_CHARACTERS = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;
/** ASCII control characters other than ordinary whitespace. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

const PATTERN_RULES: readonly PatternRule[] = [
  {
    id: "INSTRUCTION_OVERRIDE",
    label: "attempts to override prior instructions",
    pattern:
      /\b(ignore|disregard|forget|override|bypass|skip)\b.{0,40}?\b(previous|prior|above|earlier|preceding|all|any|your|system)\b.{0,40}?\b(instructions?|prompts?|rules?|polic(?:y|ies)|guardrails?|limits?|restrictions?|checks?|directives?)\b/,
  },
  {
    id: "ROLE_IMPERSONATION",
    label: "impersonates a system or assistant message",
    pattern:
      /(?:^|[.!?;]\s*)(?:system|assistant|developer|admin(?:istrator)?)\s*(?:prompt|message|note)?\s*:|<\|?\s*(?:im_start|im_end|system|endoftext)\s*\|?>|\[\/?(?:inst|sys)\]|<<\/?sys>>|#{2,}\s*(?:system|instructions?)\b/,
  },
  {
    id: "JAILBREAK",
    label: "uses jailbreak phrasing",
    pattern:
      /\b(jailbreak|developer mode|dan mode|you are now|from now on,? you|act as (?:an? )?(?:admin|administrator|system|root|unrestricted|unfiltered)|pretend (?:to be|you are)|new instructions?)\b/,
  },
  {
    id: "POLICY_TAMPERING",
    label: "tries to change spending policy",
    pattern:
      /\b(approve (?:all|every|any)|auto[- ]?approve|unlimited (?:spend(?:ing)?|budget)|(?:policy|admin|system|security) override|(?:raise|increase|remove|disable|lift|turn off|ignore|bypass|skip|override|exceed|circumvent)\b.{0,20}?\b(?:spending|daily|transaction|purchase|budget)\s+(?:caps?|limits?)|(?:disable|turn off|bypass|skip)\b.{0,20}?\b(?:guardrails?|firewall|sentinel|policy checks?|approval))\b/,
  },
  {
    id: "FUNDS_REDIRECTION",
    label: "tries to redirect funds",
    pattern:
      /\b(send|wire|transfer|forward|redirect|route|pay ?out|refund)\b.{0,40}?\b(funds?|money|payments?|balance|proceeds|crypto|bitcoin|usdt)\b.{0,60}?\b(to|into)\b/,
  },
  {
    id: "ENCODED_PAYLOAD",
    label: "contains a long encoded payload",
    pattern: /[a-z0-9+/]{48,}={0,2}/,
  },
];

const HIDDEN_CHARACTERS_LABEL = "contains hidden or control characters";
const MIXED_SCRIPT_LABEL = "mixes Latin with look-alike Cyrillic/Greek letters";
/** A single word containing both Latin and Cyrillic/Greek letters (homoglyph obfuscation, e.g. Cyrillic "і" in "іgnore"). */
const MIXED_SCRIPT_WORD =
  /(?=[\p{L}\p{M}]*\p{Script=Latin})(?=[\p{L}\p{M}]*[\p{Script=Cyrillic}\p{Script=Greek}])[\p{L}\p{M}]+/u;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(new RegExp(HIDDEN_CHARACTERS.source, "gu"), "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Scans named text fields; returns one finding per (field, rule) match. */
export function scanForInjection(fields: Record<string, string>): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const [field, raw] of Object.entries(fields)) {
    if (HIDDEN_CHARACTERS.test(raw) || CONTROL_CHARACTERS.test(raw)) {
      findings.push({ rule: "HIDDEN_CHARACTERS", label: HIDDEN_CHARACTERS_LABEL, field });
    }
    if (raw.split(/[^\p{L}\p{M}]+/u).some((word) => MIXED_SCRIPT_WORD.test(word))) {
      findings.push({ rule: "MIXED_SCRIPT", label: MIXED_SCRIPT_LABEL, field });
    }
    const text = normalize(raw);
    for (const rule of PATTERN_RULES) {
      if (rule.pattern.test(text)) findings.push({ rule: rule.id, label: rule.label, field });
    }
  }
  return findings;
}
