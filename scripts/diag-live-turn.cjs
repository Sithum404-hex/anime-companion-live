/**
 * Live API end-to-end AUDIO turn test: setup → PCM mic audio → transcription →
 * reply transcription → turnComplete.
 *
 * ⚠️ READ THIS BEFORE TRUSTING THE VERDICT.
 * The audio fed here is a synthetic 220 Hz sine tone. Gemini's server-side VAD
 * does not classify a pure tone as speech, so on a completely healthy model this
 * script prints `RESULT: FAIL — no conversational turn` with no input
 * transcription and no reply. That is a FALSE NEGATIVE, not a broken Live
 * system, and it is why this script used to be mistaken for a real outage.
 *
 * To actually test the audio path, use real speech:
 *   node scripts/diag-live-speech.cjs          (protocol level, Typecast speech)
 *   node scripts/e2e-live-hifi.cjs             (the real browser app, end to end)
 *
 * Usage: node scripts/diag-live-turn.cjs [model]
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

const model = process.argv[2] || "gemini-2.5-flash-native-audio-latest";
const RATE = 16000;

// A short synthetic "hello there" tone burst — enough for VAD to fire.
function pcmTone(seconds, freq) {
  const n = Math.floor(RATE * seconds);
  const buf = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = Math.sin((Math.PI * i) / n) ** 2;
    const v = Math.sin(2 * Math.PI * freq * t) * 0.3 * env;
    buf[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return buf;
}
function b64(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString("base64");
}

(async () => {
  const now = Date.now();
  const tr = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      newSessionExpireTime: new Date(now + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    }),
  });
  const tj = await tr.json();
  if (!tr.ok) return console.log("TOKEN FAILED", tr.status, JSON.stringify(tj));
  console.log("token ok | model:", model);

  const ws = new WebSocket(`${WS_BASE}?access_token=${encodeURIComponent(tj.name)}`);
  ws.binaryType = "arraybuffer";
  let setupDone = false,
    gotInput = false,
    gotOutput = false,
    turnDone = false;
  const t0 = Date.now();
  const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  ws.onopen = () => {
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
          systemInstruction: { parts: [{ text: "Reply in ONE short sentence, in English." }] },
        },
      }),
    );
  };

  ws.onmessage = async (e) => {
    const text =
      typeof e.data === "string"
        ? e.data
        : new TextDecoder().decode(
            e.data instanceof ArrayBuffer ? e.data : await e.data.arrayBuffer(),
          );
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return console.log(el(), "UNPARSED:", text.slice(0, 200));
    }

    if (m.setupComplete) {
      setupDone = true;
      console.log(el(), "setupComplete");
      // Stream ~1.2s of audio in 100ms chunks, then end the turn.
      const total = pcmTone(1.2, 220);
      const CH = RATE / 10;
      let off = 0;
      const iv = setInterval(() => {
        if (off >= total.length || ws.readyState !== 1) {
          clearInterval(iv);
          ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
          console.log(el(), "audioStreamEnd sent");
          return;
        }
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: { data: b64(total.slice(off, off + CH)), mimeType: `audio/pcm;rate=${RATE}` },
            },
          }),
        );
        off += CH;
      }, 100);
      return;
    }
    if (m.error) return console.log(el(), "ERROR:", JSON.stringify(m.error));
    const sc = m.serverContent;
    if (sc) {
      if (sc.inputTranscription?.text) {
        gotInput = true;
        console.log(el(), "INPUT:", sc.inputTranscription.text);
      }
      if (sc.outputTranscription?.text) {
        gotOutput = true;
        console.log(el(), "OUTPUT:", sc.outputTranscription.text);
      }
      if (sc.interrupted) console.log(el(), "interrupted");
      if (sc.turnComplete || sc.generationComplete) {
        turnDone = true;
        console.log(el(), "turnComplete");
      }
    }
  };
  ws.onerror = (e) => console.log(el(), "WS ERROR:", e.message || String(e));
  ws.onclose = (e) => console.log(el(), "WS CLOSE:", e.code, JSON.stringify(e.reason));

  setTimeout(() => {
    console.log(`\n=== VERDICT [${model}] — synthetic tone input ===`);
    console.log(
      `setup=${setupDone} inputTranscription=${gotInput} outputTranscription=${gotOutput} turnComplete=${turnDone}`,
    );
    if (turnDone && gotOutput) {
      console.log("RESULT: PASS — live turn works");
    } else if (setupDone) {
      console.log("RESULT: INCONCLUSIVE — this is EXPECTED for a pure tone.");
      console.log("  Gemini's VAD does not treat a 220 Hz sine as speech, so no");
      console.log("  transcription/reply here does NOT mean Live is broken.");
      console.log("  Re-test with real speech:");
      console.log("    node scripts/diag-live-speech.cjs   (protocol level)");
      console.log("    node scripts/e2e-live-hifi.cjs      (real browser app)");
    } else {
      console.log("RESULT: FAIL — setup never completed (real problem: key/network/model).");
    }
    try {
      ws.close();
    } catch {}
    process.exit(0);
  }, 35000);
})();
