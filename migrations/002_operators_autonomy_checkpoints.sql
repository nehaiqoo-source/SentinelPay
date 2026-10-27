-- Phase 4: named operator credentials with roles, per-agent autonomy limits,
-- and signed audit checkpoints.

-- Operators replace the single shared ADMIN_API_KEY. Keys are stored as SHA-256 hashes.
CREATE TABLE operators (
  id              text PRIMARY KEY CHECK (id ~ '^[a-z0-9._-]{1,64}$'),
  display_name    text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  role            text NOT NULL CHECK (role IN ('VIEWER', 'AUDITOR', 'OPERATOR', 'ADMIN')),
  api_key_hash    text NOT NULL UNIQUE CHECK (api_key_hash ~ '^[0-9a-f]{64}$'),
  api_key_prefix  text NOT NULL,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  revoked_reason  text,
  last_used_at    timestamptz,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Payments up to this amount may be paid from the vaulted source without a buyer
-- approving each order. 0 (the default) means every payment needs buyer approval.
ALTER TABLE agents
  ADD COLUMN autonomous_limit_cents bigint NOT NULL DEFAULT 0 CHECK (autonomous_limit_cents >= 0),
  ADD CONSTRAINT agents_autonomous_within_cap CHECK (autonomous_limit_cents <= per_transaction_cap_cents);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_actor_type_check CHECK (actor_type IN ('AGENT', 'ADMIN', 'OPERATOR', 'SYSTEM'));

-- Signed statements "the chain head at seq N had hash H". The signature is made with
-- a key the database never sees, and each checkpoint is also written outside the
-- database, so rewriting history in the database alone is detectable.
CREATE TABLE audit_checkpoints (
  seq         bigint PRIMARY KEY,
  head_hash   text NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  key_id      text NOT NULL,
  signed_at   timestamptz NOT NULL,
  signature   text NOT NULL
);

CREATE TRIGGER audit_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();

CREATE TRIGGER audit_checkpoints_no_truncate
  BEFORE TRUNCATE ON audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_mutation();
