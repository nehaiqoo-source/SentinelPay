import type { RequestHandler, Response } from "express";
import type { Agent, LedgerStore } from "../engine/store.js";
import type { Actor } from "../models/types.js";
import { hasPermission, OPERATOR_KEY_PATTERN, type AuthenticatedOperator, type OperatorStore, type Permission } from "./operators.js";

const AGENT_KEY_PATTERN = /^sp_agent_[A-Za-z0-9_-]{43}$/;

export interface AgentLocals {
  agent: Agent;
  actor: Actor;
}

export interface OperatorLocals {
  operator: AuthenticatedOperator;
  actor: Actor;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** One generic response for every authentication failure, so callers learn nothing about which check failed. */
function unauthorized(res: Response, realm: string): void {
  res.setHeader("WWW-Authenticate", `Bearer realm="${realm}"`);
  res.status(401).json({ error: "UNAUTHORIZED", message: "Missing or invalid credentials" });
}

/** Authenticates an agent by its API key; the agent's identity comes only from the key. */
export function requireAgent(store: LedgerStore): RequestHandler {
  return async (req, res, next) => {
    const token = bearerToken(req.get("authorization"));
    // Shape check first, so malformed tokens never reach the database.
    if (!token || !AGENT_KEY_PATTERN.test(token)) return unauthorized(res, "sentinelpay-agent");
    const agent = await store.findAgentByApiKey(token);
    if (!agent) return unauthorized(res, "sentinelpay-agent");
    res.locals.agent = agent;
    res.locals.actor = { type: "AGENT", id: agent.id } satisfies Actor;
    next();
  };
}

interface AuthFailure {
  reason: "MISSING_KEY" | "MALFORMED_KEY" | "UNKNOWN_KEY" | "REVOKED" | "EXPIRED";
  operatorId: string | null;
  keyPrefix: string | null;
}

/**
 * Step 1 of operator auth: identifies the caller but does not respond. On failure
 * it records why in res.locals.authFailure, so a failure-only rate limiter can sit
 * between this and rejectUnauthenticatedOperator. Valid operators are therefore
 * never throttled by other clients' failed attempts from the same IP.
 */
export function authenticateOperator(operators: OperatorStore): RequestHandler {
  return async (req, res, next) => {
    const token = bearerToken(req.get("authorization"));
    if (!token) {
      res.locals.authFailure = { reason: "MISSING_KEY", operatorId: null, keyPrefix: null } satisfies AuthFailure;
      return next();
    }
    if (!OPERATOR_KEY_PATTERN.test(token)) {
      res.locals.authFailure = { reason: "MALFORMED_KEY", operatorId: null, keyPrefix: null } satisfies AuthFailure;
      return next();
    }
    const result = await operators.authenticate(token);
    if (!result.ok) {
      res.locals.authFailure = { reason: result.reason, operatorId: result.operatorId, keyPrefix: token.slice(0, 12) } satisfies AuthFailure;
      return next();
    }
    res.locals.operator = result.operator;
    res.locals.actor = { type: "OPERATOR", id: result.operator.id } satisfies Actor;
    next();
  };
}

/**
 * Step 2: rejects requests that failed authentication. Missing, unknown, revoked and
 * expired keys all get the same 401; the reason goes only to the audit log (with the
 * key prefix, never the key). Missing keys are not audited (dashboard sign-out noise).
 */
export function rejectUnauthenticatedOperator(operators: OperatorStore): RequestHandler {
  return async (req, res, next) => {
    if (res.locals.operator) return next();
    const failure = res.locals.authFailure as AuthFailure | undefined;
    if (failure && failure.reason !== "MISSING_KEY") {
      await operators.auditDenied("AUTH_FAILED", { ...failure, path: req.originalUrl.split("?")[0] }, { type: "SYSTEM", id: "auth" });
    }
    unauthorized(res, "sentinelpay-operator");
  };
}

/** Authorizes the authenticated operator's role for one permission; denials are audited. */
export function requirePermission(operators: OperatorStore, permission: Permission): RequestHandler {
  return async (req, res, next) => {
    const { operator, actor } = res.locals as OperatorLocals;
    if (hasPermission(operator.role, permission)) return next();
    await operators.auditDenied("PERMISSION_DENIED", { permission, role: operator.role, path: req.originalUrl.split("?")[0] }, actor);
    res.status(403).json({ error: "FORBIDDEN", message: `Role ${operator.role} lacks permission ${permission}` });
  };
}
