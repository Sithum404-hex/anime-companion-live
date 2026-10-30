/**
 * Diagnostic: mint a Gemini Live ephemeral token and connect to the Live API
 * WebSocket, logging EVERY server message + close code so we can see why
 * `setupComplete` never arrives.
 *
 * Usage: node scripts/diag-live-ws.cjs [model]
 * Requires GEMINI_API_KEY in .env.local (read from the project root).
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

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

// Default to the model the app actually uses. Do NOT default this to
// `gemini-3.8-live`: it accepts setup, returns setupComplete and even runs
// server-side VAD, but then never transcribes or answers — so running this
// script with no argument reproduced "Live is broken" on a perfectly healthy
// system. Verified good: gemini-2.5-flash-native-audio-latest (see liveClient.ts).
const model = process.argv[2] || "gemini-2.5-flash-native-audio-latest";

(async () => {
  const now = Date.now();
  const tokenRes = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      newSessionExpireTime: new Date(now + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    console.log("TOKEN FAILED", tokenRes.status, JSON.stringify(tokenJson));
    return;
  }
  const token = tokenJson.name;
  console.log("token ok:", String(token).slice(0, 12) + "…", "| model:", model);

  const ws = new WebSocket(`${WS_BASE}?access_token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WS OPEN");
    ws.send(
      JSON.stringify({
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
          },
          sessionResumption: {},
          contextWindowCompression: { slidingWindow: {} },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: "You are Yuki. Reply in one short sentence." }] },
        },
      }),
    );
    console.log("setup sent");
  };
  ws.onmessage = async (e) => {
    const text =
      typeof e.data === "string"
        ? e.data
        : e.data instanceof ArrayBuffer
          ? new TextDecoder().decode(e.data)
          : await e.data.text();
    console.log("MSG:", text.slice(0, 600));
  };
  ws.onerror = (e) => console.log("WS ERROR:", e.message || e.type || String(e));
  ws.onclose = (e) => console.log("WS CLOSE:", e.code, JSON.stringify(e.reason));

  setTimeout(() => {
    console.log("--- still open after 20s, closing ---");
    try {
      ws.close();
    } catch {}
  }, 20_000);
})();
