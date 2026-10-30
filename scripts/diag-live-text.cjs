/**
 * Live API turn test WITHOUT relying on VAD speech detection: sends a TEXT
 * turn (and optionally an explicit turnComplete signal) so we can tell a broken
 * model apart from a failed mic capture.
 *
 * Usage: node scripts/diag-live-text.cjs [model]
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

const models = process.argv.slice(2);
if (models.length === 0) models.push("gemini-2.5-flash-native-audio-latest");

async function mint() {
  const now = Date.now();
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      newSessionExpireTime: new Date(now + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.name;
}

function run(model, token, sysPrompt) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}?access_token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";
    const t0 = Date.now();
    const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
    let setup = false,
      out = "",
      turnDone = false,
      err = null,
      sawTurnCompleteSignal = false;

    const finish = (verdict) => {
      try {
        ws.close();
      } catch {}
      resolve({ model, setup, out, turnDone, err, verdict, ms: Date.now() - t0 });
    };

    ws.onopen = () =>
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
            systemInstruction: { parts: [{ text: sysPrompt }] },
          },
        }),
      );

    ws.onmessage = async (e) => {
      let m;
      const text =
        typeof e.data === "string"
          ? e.data
          : new TextDecoder().decode(
              e.data instanceof ArrayBuffer ? e.data : await e.data.arrayBuffer(),
            );
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }

      if (m.setupComplete && !setup) {
        setup = true;
        console.log(`  ${el()} setupComplete`);
        // TEXT turn — bypasses the mic and VAD entirely.
        ws.send(
          JSON.stringify({
            realtimeInput: {
              text: "What is 2 + 2? Answer with one short sentence and start with [happy].",
            },
          }),
        );
        return;
      }
      if (m.error) {
        err = JSON.stringify(m.error).slice(0, 200);
        console.log(`  ${el()} ERROR ${err}`);
      }
      const sc = m.serverContent;
      if (sc) {
        if (sc.turnComplete) sawTurnCompleteSignal = true;
        if (sc.outputTranscription?.text) out += sc.outputTranscription.text;
        if (sc.inputTranscription?.text)
          console.log(`  ${el()} INPUT: ${sc.inputTranscription.text}`);
        if (sc.turnComplete || sc.generationComplete) {
          turnDone = true;
          console.log(`  ${el()} turnComplete`);
        }
      }
    };
    ws.onerror = (e) => {
      err = err || `wserror ${e.message || ""}`;
    };
    ws.onclose = (e) => {
      if (!err) err = `close ${e.code} ${e.reason || ""}`;
    };

    setTimeout(() => {
      const verdict = turnDone && out ? "PASS" : "FAIL";
      if (!turnDone && !err) err = `timeout (turnComplete signal seen=${sawTurnCompleteSignal})`;
      finish(verdict);
    }, 25000);
  });
}

(async () => {
  for (const m of models) {
    const tok = await mint();
    console.log(`\n=== ${m} ===`);
    const r = await run(
      m,
      tok,
      "Answer in ONE short sentence. Start every reply with a bracketed emotion tag like [happy].",
    );
    console.log(
      `  setup=${r.setup} turnComplete=${r.turnDone} out="${r.out.slice(0, 200)}" err=${r.err}`,
    );
    console.log(`  VERDICT: ${r.verdict} (${(r.ms / 1000).toFixed(1)}s)`);
  }
  process.exit(0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
