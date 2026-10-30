#!/usr/bin/env node
/**
 * Post-build guard: fail if a real server-side key from .env.local was inlined
 * into dist/client or dist/server.
 *
 * Runs automatically as npm's `postbuild` hook. In CI there is no .env.local,
 * so it skips. Locally it catches accidental `process.env` inlining before a
 * key can reach a public bundle.
 */
import fs from "node:fs";
import path from "node:path";

const ENV_FILE = ".env.local";
const SECRET_KEYS = ["OPENROUTER_API_KEY", "TYPECAST_API_KEY", "GEMINI_API_KEY"];

if (!fs.existsSync(ENV_FILE)) {
  console.log("No .env.local — skipping built-bundle secret scan.");
  process.exit(0);
}

const env = {};
for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
}

const secrets = SECRET_KEYS.map((name) => [name, env[name]]).filter(
  ([, value]) => value?.length > 8,
);
if (secrets.length === 0) {
  console.log("No server secrets in .env.local — skipping built-bundle secret scan.");
  process.exit(0);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = [...walk("dist/client"), ...walk("dist/server")];
const findings = [];
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const [name, value] of secrets) {
    if (text.includes(value)) {
      findings.push({ name, file: file.replaceAll("\\", "/") });
    }
  }
}

if (findings.length === 0) {
  console.log(`Built-bundle scan clean (${files.length} files, ${secrets.length} server keys).`);
  process.exit(0);
}

console.error("Server-side secret value found in the build output:");
for (const finding of findings) {
  console.error(`  ${finding.name} -> ${finding.file}`);
}
console.error("Remove the client-side reference and rebuild before deploying.");
process.exit(1);
