import type { PolicyViolation } from "../models/types.js";

/**
 * Server-side spending policy. Decisions use only structured, validated fields
 * (agent identity from its API key, integer cents, merchant/category identifiers);
 * free-text descriptions never influence authorization.
 */

export interface AgentLimits {
  frozen: boolean;
  frozenReason: string | null;
  perTransactionCapCents: number;
  dailyCapCents: number;
  allowedMerchants: string[] | null;
  allowedCategories: string[] | null;
  /** Payments up to this amount may skip buyer approval (vault). 0 = always require approval. */
  autonomousLimitCents: number;
}

export interface GlobalLimits {
  perTransactionCapCents: number;
  dailyCapCents: number;
}

export interface PolicyInput {
  agent: AgentLimits;
  global: GlobalLimits;
  amountCents: number;
  merchantId: string;
  category: string;
  /** Reserved + committed spend today, excluding this request. */
  agentSpentTodayCents: number;
  globalSpentTodayCents: number;
}

export function evaluatePolicy(input: PolicyInput): PolicyViolation[] {
  const { agent, global, amountCents } = input;
  const violations: PolicyViolation[] = [];

  if (agent.frozen) {
    violations.push({
      code: "AGENT_FROZEN",
      message: `Agent is frozen${agent.frozenReason ? `: ${agent.frozenReason}` : ""}`,
    });
  }
  if (agent.allowedMerchants !== null && !agent.allowedMerchants.includes(input.merchantId)) {
    violations.push({ code: "MERCHANT_NOT_ALLOWED", message: `Merchant "${input.merchantId}" is not on this agent's allowlist` });
  }
  if (agent.allowedCategories !== null && !agent.allowedCategories.includes(input.category)) {
    violations.push({ code: "CATEGORY_NOT_ALLOWED", message: `Category "${input.category}" is not on this agent's allowlist` });
  }

  if (amountCents > agent.perTransactionCapCents) {
    violations.push(capViolation("PER_TRANSACTION_CAP", "the agent's per-transaction cap", agent.perTransactionCapCents, amountCents));
  }
  if (amountCents > global.perTransactionCapCents) {
    violations.push(capViolation("GLOBAL_PER_TRANSACTION_CAP", "the global per-transaction cap", global.perTransactionCapCents, amountCents));
  }

  const agentTotal = input.agentSpentTodayCents + amountCents;
  if (agentTotal > agent.dailyCapCents) {
    violations.push(capViolation("DAILY_SPENDING_CAP", "the agent's daily cap", agent.dailyCapCents, agentTotal));
  }
  const globalTotal = input.globalSpentTodayCents + amountCents;
  if (globalTotal > global.dailyCapCents) {
    violations.push(capViolation("GLOBAL_DAILY_SPENDING_CAP", "the global daily cap", global.dailyCapCents, globalTotal));
  }

  return violations;
}

/**
 * Server-side approval requirement: a payment may skip buyer approval only when a
 * vaulted source is configured AND the amount is within the agent's autonomous
 * limit. Nothing in the request can change this.
 */
export function requiresBuyerApproval(agent: AgentLimits, amountCents: number, vaultAvailable: boolean): boolean {
  return !vaultAvailable || amountCents > agent.autonomousLimitCents;
}

function capViolation(code: PolicyViolation["code"], what: string, limitCents: number, attemptedCents: number): PolicyViolation {
  return {
    code,
    message: `$${formatCents(attemptedCents)} would exceed ${what} of $${formatCents(limitCents)}`,
    limit: formatCents(limitCents),
    attempted: formatCents(attemptedCents),
  };
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
