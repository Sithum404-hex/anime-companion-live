// Smoke test: mint a Gemini Live ephemeral token exactly like src/lib/liveToken.ts.
//
// Note: the REST auth_tokens endpoint does NOT accept `live_connect_constraints`
// (verified live — 400 "Cannot find field" in both camel and snake case), so this
// sends the same body liveToken.ts sends. Do not add the constraints back here.
const KEY = process.env.GEMINI_API_KEY || "";
if (!KEY) {
  console.error("FAIL: GEMINI_API_KEY not set");
  process.exit(1);
}
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const body = {
  uses: 1,
  expireTime: iso(now + 30 * 60 * 1000),
  newSessionExpireTime: iso(now + 60 * 1000),
};
(async () => {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(
      `FAIL: token request rejected (${r.status}):`,
      text.slice(0, 300).replace(/\s+/g, " "),
    );
    process.exit(1);
  }
  const json = JSON.parse(text);
  if (!json.name) {
    console.error("FAIL: 200 but no token in response:", text.slice(0, 300));
    process.exit(1);
  }
  console.log(`OK: token minted, prefix ${String(json.name).slice(0, 10)}...`);
  process.exit(0);
})();
