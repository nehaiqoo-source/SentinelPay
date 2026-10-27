-- SentinelPay durable ledger: agents and their policies, transactions with
-- budget reservations, and a hash-chained audit log.

CREATE TABLE agents (
  id                         text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  display_name               text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  api_key_hash               text NOT NULL UNIQUE CHECK (api_key_hash ~ '^[0-9a-f]{64}$'),
  api_key_prefix             text NOT NULL,
  per_transaction_cap_cents  bigint NOT NULL CHECK (per_transaction_cap_cents > 0),
  daily_cap_cents            bigint NOT NULL CHECK (daily_cap_cents > 0),
  -- NULL means unrestricted; an empty array denies everything.
  allowed_merchants          text[],
  allowed_categories         text[],
  frozen                     boolean NOT NULL DEFAULT false,
  frozen_reason              text,
  frozen_at                  timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (per_transaction_cap_cents <= daily_cap_cents)
);

CREATE TABLE transactions (
  id                   uuid PRIMARY KEY,
  agent_id             text NOT NULL REFERENCES agents (id),
  request_id           text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  request_fingerprint  text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  merchant_id          text NOT NULL,
  merchant_name        text,
  category             text NOT NULL,
  description          text NOT NULL,
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  currency             text NOT NULL CHECK (currency = 'USD'),
  status               text NOT NULL,
  budget_state         text NOT NULL,
  budget_day           date NOT NULL,
  mode                 text CHECK (mode IN ('AUTONOMOUS', 'INTERACTIVE')),
  paypal_order_id      text UNIQUE,
  paypal_capture_id    text UNIQUE,
  approval_url         text,
  violations           jsonb NOT NULL DEFAULT '[]'::jsonb,
  error                jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- One transaction per agent idempotency key, enforced by the database.
  CONSTRAINT transactions_agent_request_unique UNIQUE (agent_id, request_id),
  -- Every status maps to exactly one budget state, so accounting cannot drift.
  CONSTRAINT transactions_status_budget_consistent CHECK (
       (status = 'BLOCKED' AND budget_state = 'NONE')
    OR (status IN ('PROCESSING', 'PENDING_APPROVAL', 'CAPTURING', 'RECONCILE_REQUIRED') AND budget_state = 'RESERVED')
    OR (status IN ('CAPTURE_PENDING', 'COMPLETED', 'REFUNDED') AND budget_state = 'COMMITTED')
    OR (status IN ('DECLINED', 'FAILED', 'EXPIRED', 'CANCELLED') AND budget_state = 'RELEASED')
  )
);

CREATE INDEX transactions_budget_idx
  ON transactions (budget_day, agent_id)
  WHERE budget_state IN ('RESERVED', 'COMMITTED');
CREATE INDEX transactions_status_idx ON transactions (status, updated_at);
CREATE INDEX transactions_created_idx ON transactions (created_at DESC);

CREATE TABLE audit_events (
  seq             bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('AGENT', 'ADMIN', 'SYSTEM')),
  actor_id        text NOT NULL,
  action          text NOT NULL,
  agent_id        text,
  transaction_id  uuid,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash       text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash            text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX audit_events_transaction_idx ON audit_events (transaction_id);

-- Append-only through the application role. A superuser or the table owner can
-- still disable this trigger; the hash chain is what detects such edits.
CREATE FUNCTION audit_events_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP;
END;
$$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_mutation();
