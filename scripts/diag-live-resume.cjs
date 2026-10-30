/**
 * Verifies Gemini Live SESSION RESUMPTION carries context across a reconnect.
 *
 * Two separate things have to be true, and this checks both:
 *
 *  1. The PLUMBING must survive. LiveModeController builds a brand-new
 *     GeminiLiveClient for every connect, so a resumption handle stored only on
 *     the client instance died with it. Every reconnect — the ~10 min WebSocket
 *     limit, a network blip, an expired token — silently restarted the
 *     conversation from nothing, even though the docs claimed one session
 *     persisted. The handle is now owned by the controller and re-seeded into
 *     each new client.
 *
 *  2. The SERVER must issue a handle. It only does so once the conversation has
 *     real content (an early short turn yields no handle), so this feeds a
 *     genuine speech turn — a tone or a one-word prompt never gets one.
 *
 * It then drops the socket, reconnects WITH the handle, and asks a follow-up
 * whose answer is impossible without the earlier context.
 *
 * Usage: node scripts/diag-live-resume.cjs [model]
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
const KEY = /^GEMINI_API_KEY=(.*)$/m
  .exec(env)?.[1]
  ?.trim()
  .replace(/^["']|["']$/g, "");
const TC_KEY = /^TYPECAST_API_KEY=(.*)$/m
  .exec(env)?.[1]
  ?.trim()
  .replace(/^["']|["']$/g, "");
if (!KEY) throw new Error("GEMINI_API_KEY missing from .env.local");
if (!TC_KEY) throw new Error("TYPECAST_API_KEY missing from .env.local (needed for real speech)");

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

const model = process.argv[2] || "gemini-2.5-flash-native-audio-latest";
const RATE = 16000;
const SYS =
  "You are Yuki, a warm anime companion. Keep replies to ONE short sentence. Start with a bracketed emotion tag.";

const FACT = "teal";
// Long enough that the server actually checkpoints a resumable handle — an
// early short turn yields none, which is the whole reason the first version of
// this test wrongly concluded resumption was broken.
const REMEMBER_LINE =
  "Hi Yuki. I want to tell you a few important things about me, so please listen carefully and remember them. " +
  "My name is River. My favourite colour is teal, the blue green one. " +
  "I am building a little music player app at the moment, and I have been working on it all week. " +
  "I also really love taking photos of the sky at sunset. " +
  "Please keep all of that in mind, because I am going to ask you about it in a moment.";

// ── WAV (Typecast, the app's own TTS) → 16 kHz mono PCM16 ──────────────
function decodeWav(buf) {
  let off = 12,
    fmt = null,
    data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ")
      fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12) };
    else if (id === "data") data = buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
    off += 8 + size + (size % 2);
  }
  const s = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  const frames = Math.floor(s.length / fmt.channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let a = 0;
    for (let c = 0; c < fmt.channels; c++) a += s[i * fmt.channels + c];
    mono[i] = a / fmt.channels / 32768;
  }
  const ratio = fmt.rate / RATE;
  const out = new Int16Array(Math.floor(frames / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio,
      i0 = Math.floor(pos),
      i1 = Math.min(i0 + 1, frames - 1),
      f = pos - i0;
    const v = Math.max(-1, Math.min(1, mono[i0] * (1 - f) + mono[i1] * f));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}
const b64 = (i) => Buffer.from(i.buffer, i.byteOffset, i.byteLength).toString("base64");

async function speech(text) {
  const r = await fetch("https://api.typecast.ai/v1/text-to-speech", {
    method: "POST",
    headers: { "X-API-KEY": TC_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model: "ssfm-v30",
      voice_id: "tc_632a759503f3cb7b9c8a717b",
      prompt: { emotion_type: "preset", emotion_preset: "normal", emotion_intensity: 1.0 },
      output: { audio_format: "wav", audio_tempo: 1 },
    }),
  });
  if (!r.ok) throw new Error(`typecast ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return decodeWav(Buffer.from(await r.arrayBuffer()));
}

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

/**
 * One speech turn on a socket, optionally seeded with a resumption handle.
 * @returns {{ heard, said, handle, setup }}
 */
function speakTurn(token, handle, wav) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}?access_token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";
    let setup = false,
      heard = "",
      said = "",
      newHandle = handle,
      done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {}
      resolve({ heard, said, handle: newHandle, setup });
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
            // Seeded with the handle from the previous (now dead) socket.
            sessionResumption: handle ? { handle } : {},
            contextWindowCompression: { slidingWindow: {} },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: { parts: [{ text: SYS }] },
          },
        }),
      );

    ws.onmessage = async (e) => {
      const raw =
        typeof e.data === "string"
          ? e.data
          : new TextDecoder().decode(
              e.data instanceof ArrayBuffer ? e.data : await e.data.arrayBuffer(),
            );
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }

      const ru = m.sessionResumptionUpdate;
      // Only a handle-bearing update counts; the server also sends bare {} frames.
      if (ru?.resumable && ru.newHandle) newHandle = ru.newHandle;

      if (m.error) {
        console.log("  ERROR:", JSON.stringify(m.error).slice(0, 200));
        return finish();
      }
      if (m.setupComplete && !setup) {
        setup = true;
        const CH = RATE / 10;
        let off = 0;
        const iv = setInterval(() => {
          if (off >= wav.length || ws.readyState !== 1) {
            clearInterval(iv);
            ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
            return;
          }
          ws.send(
            JSON.stringify({
              realtimeInput: {
                audio: {
                  data: b64(wav.subarray(off, off + CH)),
                  mimeType: `audio/pcm;rate=${RATE}`,
                },
              },
            }),
          );
          off += CH;
        }, 100);
        return;
      }
      const sc = m.serverContent;
      if (sc) {
        if (sc.inputTranscription?.text) heard += sc.inputTranscription.text;
        if (sc.outputTranscription?.text) said += sc.outputTranscription.text;
        // Resumption handles can arrive AFTER turnComplete (observed up to ~2s
        // later), so keep the socket open long enough to actually receive one.
        if (sc.turnComplete) setTimeout(finish, 5000);
      }
    };
    ws.onerror = () => finish();
    ws.onclose = () => finish();
    setTimeout(finish, 45000);
  });
}

(async () => {
  console.log(`model: ${model}\n`);
  const rememberWav = await speech(REMEMBER_LINE);
  const askWav = await speech("Hey Yuki, what is my favourite colour? Just tell me the colour.");
  console.log(
    `speech: remember=${(rememberWav.length / RATE).toFixed(1)}s ask=${(askWav.length / RATE).toFixed(1)}s\n`,
  );

  console.log("TURN 1 — fresh session, telling her a fact (speech)…");
  const t1 = await speakTurn(await mint(), null, rememberWav);
  console.log(`  setup=${t1.setup}`);
  console.log(`  she heard: ${JSON.stringify(t1.heard.trim().slice(0, 150))}`);
  console.log(`  she said : ${JSON.stringify(t1.said.trim().slice(0, 120))}`);
  console.log(
    `  handle   : ${t1.handle ? "ISSUED (" + String(t1.handle).slice(0, 20) + "…)" : "none issued"}`,
  );

  // The socket is now dead — exactly what a reconnect must survive.
  console.log("\nTURN 2 — socket dropped, reconnecting WITH the handle, asking for the fact…");
  const t2 = await speakTurn(await mint(), t1.handle, askWav);
  console.log(`  setup=${t2.setup}`);
  console.log(`  she heard: ${JSON.stringify(t2.heard.trim().slice(0, 120))}`);
  console.log(`  she said : ${JSON.stringify(t2.said.trim().slice(0, 120))}`);

  console.log("\nTURN 3 — control: cold session, identical question (should NOT know)…");
  const t3 = await speakTurn(await mint(), null, askWav);
  console.log(`  she said : ${JSON.stringify(t3.said.trim().slice(0, 120))}`);

  const gotHandle = !!t1.handle;
  const remembered = new RegExp(FACT, "i").test(t2.said);
  const coldForgot = !new RegExp(FACT, "i").test(t3.said);

  console.log(`\n=== VERDICT ===`);
  console.log(`server issued a resumable handle      : ${gotHandle ? "yes" : "no"}`);
  console.log(`resumed session still knew "${FACT}"  : ${remembered ? "YES" : "no"}`);
  console.log(`cold session did not know it          : ${coldForgot ? "yes (as expected)" : "no"}`);
  console.log(
    gotHandle && remembered
      ? "RESULT: PASS — context survives a reconnect via the carried handle"
      : "RESULT: FAIL — context did not survive",
  );
  process.exit(gotHandle && remembered ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(2);
});
