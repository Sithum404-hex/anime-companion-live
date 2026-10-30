#!/usr/bin/env node
/**
 * Working-tree secret scan.
 *
 * Scans source-controlled text files for the credential formats this project
 * has actually leaked before (OpenRouter, Typecast, Google, Groq, xAI, AWS,
 * Hugging Face) plus private-key blocks. It intentionally does not scan git
 * history — use gitleaks/filter-repo for that — and it skips local env files
 * because a developer's .env.local is supposed to contain real keys.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".output",
  ".vinxi",
  ".wrangler",
  ".tanstack",
  "scripts/dev",
  "vrm animations",
]);
const SKIP_FILES = new Set([
  ".env",
  ".env.local",
  ".env.development.local",
  ".env.production.local",
]);
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
  ".example",
]);

const PATTERNS = [
  ["OpenRouter key", /sk-or-v1-[0-9a-f]{32,}/i],
  ["OpenAI project key", /sk-proj-[A-Za-z0-9_-]{20,}/],
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["Groq key", /gsk_[A-Za-z0-9]{20,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{30,}/],
  ["Typecast key", /__plt[A-Za-z0-9]{20,}/],
  ["xAI key", /xai-[A-Za-z0-9]{20,}/],
  ["Hugging Face token", /hf_[A-Za-z0-9]{20,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_DIRS.has(rel)) continue;
      walk(full);
      continue;
    }
    if (SKIP_FILES.has(entry.name)) continue;
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;

    let text;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const [label, re] of PATTERNS) {
        if (re.test(lines[i])) {
          findings.push({ file: rel, line: i + 1, label });
        }
      }
    }
  }
}

walk(ROOT);

if (findings.length === 0) {
  console.log("No secrets found in the working tree.");
  process.exit(0);
}

console.error(`Found ${findings.length} potential secret(s):`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.label}`);
}
console.error("\nRemove the value, move it to .env.local, and rotate it if it was ever committed.");
process.exit(1);
