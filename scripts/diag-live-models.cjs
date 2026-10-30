/**
 * Lists every model the API key can actually reach, flagging Live / native-audio
 * candidates. Use this to confirm LIVE_MODEL in src/waifu/liveClient.ts still exists.
 *
 * Usage: node scripts/diag-live-models.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
const KEY = /^GEMINI_API_KEY=(.*)$/m
  .exec(env)?.[1]
  ?.trim()
  .replace(/^["']|["']$/g, "");
if (!KEY) throw new Error("GEMINI_API_KEY missing from .env.local");

(async () => {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": KEY },
  });
  const j = await r.json();
  if (!r.ok) {
    console.log("models list FAILED", r.status, JSON.stringify(j).slice(0, 300));
    process.exit(1);
  }

  const all = (j.models || []).map((m) => m.name.replace(/^models\//, ""));
  const live = all.filter((n) => /live|native-audio/i.test(n));

  console.log(`total models reachable: ${all.length}`);
  console.log(`\n--- Live / native-audio candidates (${live.length}) ---`);
  for (const n of live.sort()) console.log("  " + n);

  const CURRENT = "gemini-2.5-flash-native-audio-latest";
  console.log(`\nLIVE_MODEL in liveClient.ts = ${CURRENT}`);
  console.log(
    all.includes(CURRENT)
      ? "  -> PRESENT in the API (good)"
      : "  -> *** NOT REACHABLE — the configured model no longer exists ***",
  );

  const flashLive = all.filter(
    (n) => /flash.*live|live.*flash/i.test(n) && !/native-audio/.test(n),
  );
  console.log(`\n--- Other live-preview candidates (${flashLive.length}) ---`);
  for (const n of flashLive.sort()) console.log("  " + n);
})();
