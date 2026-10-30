#!/usr/bin/env node
/**
 * Push server-side API keys from .env.local into Cloudflare Worker secrets.
 *
 * The values are written to Wrangler's stdin, never to argv, so they do not
 * appear in process listings or shell history. Nothing is printed except the
 * key names and Wrangler's own status output.
 *
 * Auth (one of):
 *   npx wrangler login
 *   CLOUDFLARE_API_TOKEN=... (and optionally CLOUDFLARE_ACCOUNT_ID=...)
 *
 * Usage:
 *   npm run secrets:cloudflare
 *   npm run secrets:cloudflare -- --dry-run
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const ENV_FILE = ".env.local";
const SECRET_KEYS = ["OPENROUTER_API_KEY", "TYPECAST_API_KEY", "GEMINI_API_KEY"];
const OPTIONAL_KEYS = new Set(["GEMINI_API_KEY"]);
const dryRun = process.argv.includes("--dry-run");

function readEnv(file) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${file}. Create it from .env.example first.`);
    process.exit(1);
  }
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = readEnv(ENV_FILE);
const missing = SECRET_KEYS.filter((key) => !OPTIONAL_KEYS.has(key) && !env[key]);
if (missing.length > 0) {
  console.error(`Missing required values in ${ENV_FILE}: ${missing.join(", ")}`);
  process.exit(1);
}

const present = SECRET_KEYS.filter((key) => env[key]);
if (present.length === 0) {
  console.error(`No server secrets found in ${ENV_FILE}.`);
  process.exit(1);
}

if (dryRun) {
  console.log(`Would upload to the Cloudflare Worker: ${present.join(", ")}`);
  process.exit(0);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const childEnv = { ...process.env };
for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (env[key] && !childEnv[key]) childEnv[key] = env[key];
}

for (const key of present) {
  console.log(`Uploading ${key}…`);
  const result = spawnSync(npx, ["wrangler", "secret", "put", key], {
    input: env[key],
    stdio: ["pipe", "inherit", "inherit"],
    env: childEnv,
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(`Could not start Wrangler: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `Failed to upload ${key}. Run "npx wrangler login" or set CLOUDFLARE_API_TOKEN, then retry.`,
    );
    process.exit(result.status ?? 1);
  }
}

console.log("Done. Server-side secrets are set on the Cloudflare Worker.");
