/**
 * Generates the Ed25519 audit checkpoint signing key pair:
 *   npm run audit:keygen -- --out .secrets/audit-signing
 * Writes <out>.pem (private, 0600) and <out>.pub.pem (public). Give the public key
 * to whoever verifies the log independently; keep the private key off the database host.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createPublicKey } from "node:crypto";
import { generateSigningKeyPair, keyIdFor } from "../engine/auditCheckpoints.js";

const i = process.argv.indexOf("--out");
const out = i >= 0 ? process.argv[i + 1] : undefined;
if (!out) {
  console.error("usage: npm run audit:keygen -- --out <path-prefix>");
  process.exit(1);
}
if (existsSync(`${out}.pem`)) {
  console.error(`${out}.pem already exists; refusing to overwrite a signing key`);
  process.exit(1);
}
const { privatePem, publicPem } = generateSigningKeyPair();
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(`${out}.pem`, privatePem, { mode: 0o600, flag: "wx" });
writeFileSync(`${out}.pub.pem`, publicPem, { mode: 0o644, flag: "wx" });
console.log(`Wrote ${out}.pem (private, 0600) and ${out}.pub.pem; key id ${keyIdFor(createPublicKey(publicPem))}`);
