/**
 * Creates (or re-keys) the demo purchasing agent through the operator API.
 *   OPERATOR_KEY_FILE=.secrets/<admin>.key npm run demo:setup
 * Policy: $25 per transaction, $60 per day, autonomous (vault, no buyer approval) up to $15,
 * merchants: acme-store only, categories: electronics, office.
 * The agent key is written to .secrets/demo-agent.key (0600), never printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadDotEnv } from "../src/config/env.js";

loadDotEnv();
const url = process.env.SENTINELPAY_URL ?? "http://localhost:5000";
const operatorKeyFile = process.env.OPERATOR_KEY_FILE;
if (!operatorKeyFile) {
  console.error("Set OPERATOR_KEY_FILE to an ADMIN operator key file");
  process.exit(2);
}
const opKey = readFileSync(operatorKeyFile, "utf8").trim();
const headers = { Authorization: `Bearer ${opKey}`, "Content-Type": "application/json" };
const agentId = process.env.DEMO_AGENT_ID ?? "demo-shopper";
const policy = {
  displayName: "Demo purchasing agent (Gemini)",
  perTransactionCap: "25.00",
  dailyCap: "60.00",
  autonomousLimit: "15.00",
  allowedMerchants: ["acme-store"],
  allowedCategories: ["electronics", "office"],
};

const existing = await fetch(`${url}/api/admin/agents/${agentId}`, { headers });
let apiKey: string;
if (existing.status === 404) {
  const res = await fetch(`${url}/api/admin/agents`, { method: "POST", headers, body: JSON.stringify({ agentId, ...policy }) });
  const body = (await res.json()) as any;
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(body)}`);
  apiKey = body.apiKey;
  console.log(`Created agent ${agentId}`);
} else {
  const upd = await fetch(`${url}/api/admin/agents/${agentId}/policy`, { method: "PUT", headers, body: JSON.stringify(policy) });
  if (!upd.ok) throw new Error(`policy update failed: ${upd.status}`);
  const rot = await fetch(`${url}/api/admin/agents/${agentId}/rotate-key`, { method: "POST", headers });
  apiKey = ((await rot.json()) as any).apiKey;
  console.log(`Updated policy and rotated key for existing agent ${agentId}`);
}
mkdirSync(".secrets", { recursive: true, mode: 0o700 });
writeFileSync(".secrets/demo-agent.key", `${apiKey}\n`, { mode: 0o600 });
console.log(`Policy: per-tx $${policy.perTransactionCap}, daily $${policy.dailyCap}, autonomous ≤ $${policy.autonomousLimit}, merchants ${policy.allowedMerchants}, categories ${policy.allowedCategories}`);
console.log("Agent key written to .secrets/demo-agent.key (0600)");
