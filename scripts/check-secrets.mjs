// Pre-publish secret scan. Run before every push:  npm run check:secrets
// Checks every file that would be committed (skips .gitignore'd paths) for the actual
// secret values in .env / .secrets/ and for key/token patterns. Prints labels only, never values.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const secrets = [];
if (existsSync(".env")) {
  const env = Object.fromEntries(
    readFileSync(".env", "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=./.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  for (const k of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_VAULT_PAYMENT_TOKEN", "GEMINI_API_KEY"]) if (env[k]) secrets.push([k, env[k]]);
  for (const k of ["DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
    const m = /:\/\/[^:]+:([^@]+)@/.exec(env[k] ?? "");
    // The docker-compose default is a documented local-only value, not a secret.
    if (m && m[1] !== "sentinelpay_local_dev") secrets.push([`${k} password`, decodeURIComponent(m[1])]);
  }
}
if (process.env.GEMINI_API_KEY) secrets.push(["GEMINI_API_KEY (shell)", process.env.GEMINI_API_KEY]);
if (existsSync(".secrets")) {
  for (const f of readdirSync(".secrets")) {
    if (f.endsWith(".pub.pem") || f.endsWith(".jsonl")) continue;
    const v = readFileSync(join(".secrets", f), "utf8").trim();
    secrets.push([`.secrets/${f}`, v.includes("BEGIN") ? v.split("\n")[1] : v]);
  }
}
const patterns = [
  ["operator key", /sp_op_[A-Za-z0-9_-]{43}/],
  ["agent key", /sp_agent_[A-Za-z0-9_-]{43}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
];
const skip = new Set(["node_modules", "dist", ".env", ".secrets", ".git", ".DS_Store", "audit-checkpoints.jsonl"]);
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name) || e.name.endsWith(".log")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
})(".");

let findings = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const [label, value] of secrets) if (value && value.length >= 8 && text.includes(value)) (findings++, console.log(`LEAK  ${label} found in ${f}`));
  // This file defines the patterns; don't flag it for containing them.
  if (f.endsWith("check-secrets.mjs")) continue;
  for (const [label, re] of patterns) if (re.test(text)) (findings++, console.log(`MATCH ${label} pattern in ${f}`));
}
console.log(`Scanned ${files.length} committable files against ${secrets.length} known secret values and ${patterns.length} patterns: ${findings} finding(s)`);
process.exit(findings ? 1 : 0);
