import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import type { Db } from "../db/pool.js";
import { verifyAuditChain } from "./audit.js";
import type { AuditVerification } from "../models/types.js";

/**
 * Signed audit checkpoints.
 *
 * A checkpoint is an Ed25519 signature over "the audit chain head at seq N has hash H".
 * It is stored in the database AND appended to a JSONL file that should live on
 * separately controlled, append-only storage. Verification uses only the public key.
 *
 * Detects (given the private key and the checkpoint file are outside the attacker's reach):
 *  - consistent rewriting of the whole chain from some event onward (a hash chain alone cannot),
 *  - deletion of events up to the last checkpoint, and forged checkpoint rows.
 * Does not detect: changes after the newest checkpoint (window = checkpoint interval),
 * or anything done by someone who holds the signing key AND can rewrite the checkpoint file.
 */

const PAYLOAD_PREFIX = "sentinelpay-audit-checkpoint:v1";

export interface Checkpoint {
  seq: number;
  headHash: string;
  keyId: string;
  signedAt: string;
  signature: string;
}

export interface CheckpointSigner {
  keyId: string;
  publicKey: KeyObject;
  sign(payload: string): string;
}

export interface IntegrityReport {
  chain: AuditVerification;
  checkpoints: {
    configured: boolean;
    checked: number;
    externalChecked: number;
    valid: boolean;
    latestSeq: number | null;
    problems: string[];
  };
}

function payload(seq: number, headHash: string, signedAt: string): string {
  return `${PAYLOAD_PREFIX}|${seq}|${headHash}|${signedAt}`;
}

export function keyIdFor(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

export function signerFromPem(privatePem: string): CheckpointSigner {
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("audit signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  return {
    keyId: keyIdFor(publicKey),
    publicKey,
    sign: (data) => sign(null, Buffer.from(data), privateKey).toString("base64"),
  };
}

export function generateSigningKeyPair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Signs the current chain head (no-op if it is already checkpointed). Appends to the external file when configured. */
export async function createCheckpoint(db: Db, signer: CheckpointSigner, externalFile: string | null): Promise<Checkpoint | null> {
  const head = await db.query<{ seq: number; hash: string }>("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1");
  const row = head.rows[0];
  if (!row) return null;
  const seq = Number(row.seq);
  const existing = await db.query<{ seq: number }>("SELECT seq FROM audit_checkpoints WHERE seq = $1", [seq]);
  if (existing.rowCount) return null;

  const signedAt = new Date().toISOString();
  const checkpoint: Checkpoint = { seq, headHash: row.hash, keyId: signer.keyId, signedAt, signature: signer.sign(payload(seq, row.hash, signedAt)) };
  // External copy first: if the DB insert then fails, the extra external record still verifies.
  if (externalFile) await appendFile(externalFile, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600, flag: "a" });
  await db.query(
    "INSERT INTO audit_checkpoints (seq, head_hash, key_id, signed_at, signature) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (seq) DO NOTHING",
    [checkpoint.seq, checkpoint.headHash, checkpoint.keyId, checkpoint.signedAt, checkpoint.signature],
  );
  return checkpoint;
}

export async function readExternalCheckpoints(file: string): Promise<Checkpoint[]> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Checkpoint);
}

/**
 * Verifies the hash chain, every checkpoint signature (with the public key only),
 * and that each checkpoint's hash still matches the event at its seq. Checkpoints
 * from the external file are checked too, so deleting or forging DB rows is caught.
 */
export async function verifyAuditIntegrity(
  db: Db,
  options: { publicKey: KeyObject | null; externalFile: string | null },
): Promise<IntegrityReport> {
  const chain = await verifyAuditChain(db);
  const problems: string[] = [];
  if (!options.publicKey) {
    return { chain, checkpoints: { configured: false, checked: 0, externalChecked: 0, valid: chain.valid, latestSeq: null, problems } };
  }
  const expectedKeyId = keyIdFor(options.publicKey);

  const { rows } = await db.query<{ seq: number; head_hash: string; key_id: string; signed_at: Date; signature: string }>(
    "SELECT * FROM audit_checkpoints ORDER BY seq",
  );
  const dbCheckpoints: Checkpoint[] = rows.map((r) => ({
    seq: Number(r.seq),
    headHash: r.head_hash,
    keyId: r.key_id,
    signedAt: r.signed_at.toISOString(),
    signature: r.signature,
  }));
  const external = options.externalFile ? await readExternalCheckpoints(options.externalFile) : [];

  const hashes = new Map<number, string>();
  const events = await db.query<{ seq: number; hash: string }>("SELECT seq, hash FROM audit_events");
  for (const e of events.rows) hashes.set(Number(e.seq), e.hash);

  const check = (cp: Checkpoint, source: string) => {
    if (cp.keyId !== expectedKeyId) {
      problems.push(`${source} checkpoint #${cp.seq}: signed by unknown key ${cp.keyId}`);
      return;
    }
    const ok = verify(null, Buffer.from(payload(cp.seq, cp.headHash, cp.signedAt)), options.publicKey!, Buffer.from(cp.signature, "base64"));
    if (!ok) {
      problems.push(`${source} checkpoint #${cp.seq}: invalid signature (forged or altered)`);
      return;
    }
    const actual = hashes.get(cp.seq);
    if (actual === undefined) problems.push(`${source} checkpoint #${cp.seq}: event no longer exists (deleted or truncated)`);
    else if (actual !== cp.headHash) problems.push(`${source} checkpoint #${cp.seq}: chain hash differs from signed hash (history rewritten)`);
  };
  for (const cp of dbCheckpoints) check(cp, "database");
  for (const cp of external) check(cp, "external");

  // Every externally recorded checkpoint must still be present in the database.
  const dbSeqs = new Set(dbCheckpoints.map((c) => c.seq));
  for (const cp of external) if (!dbSeqs.has(cp.seq)) problems.push(`external checkpoint #${cp.seq}: missing from database`);

  const latestSeq = Math.max(...[...dbCheckpoints, ...external].map((c) => c.seq), -1);
  return {
    chain,
    checkpoints: {
      configured: true,
      checked: dbCheckpoints.length,
      externalChecked: external.length,
      valid: problems.length === 0,
      latestSeq: latestSeq >= 0 ? latestSeq : null,
      problems,
    },
  };
}
