/**
 * Raw dump: does Gemini ever issue a sessionResumptionUpdate handle for the
 * model/config the app uses? Feeds a real speech turn and prints EVERY server
 * message so the answer is observed rather than assumed.
 *
 * Usage: node scripts/diag-live-resume-raw.cjs [model]
 */
const fs = require("node:fs");
const os = require("node:os");
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

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const model = process.argv[2] || "gemini-2.5-flash-native-audio-latest";
const RATE = 16000;

function decodeWav(buf) {
  let off = 12,
    fmt = null,
    data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ")
      fmt = {
        channels: buf.readUInt16LE(off + 10),
        rate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
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
    let v = mono[i0] * (1 - f) + mono[i1] * f;
    v = Math.max(-1, Math.min(1, v));
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
  return Buffer.from(await r.arrayBuffer());
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

  // Long enough that the server has real context worth checkpointing.
  const pcm = decodeWav(
    await speech(
      "Hi Yuki. I want you to remember something important for me. My name is River and my favourite colour is teal. Please remember both of those facts clearly so you can tell me later.",
    ),
  );
  console.log(`model=${model}  speech=${(pcm.length / RATE).toFixed(1)}s`);

  const ws = new WebSocket(`${WS_BASE}?access_token=${encodeURIComponent(tj.name)}`);
  ws.binaryType = "arraybuffer";
  let handles = 0;
  const t0 = Date.now();
  const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

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
          systemInstruction: {
            parts: [{ text: "You are Yuki. Reply in ONE short sentence. Start with [happy]." }],
          },
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

    // Only print the structurally interesting frames, not every audio delta.
    if (m.setupComplete) {
      console.log(el(), "setupComplete");
      const CH = RATE / 10;
      let off = 0;
      const iv = setInterval(() => {
        if (off >= pcm.length || ws.readyState !== 1) {
          clearInterval(iv);
          ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
          console.log(el(), "audioStreamEnd");
          return;
        }
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: { data: b64(pcm.subarray(off, off + CH)), mimeType: `audio/pcm;rate=${RATE}` },
            },
          }),
        );
        off += CH;
      }, 100);
      return;
    }
    if (m.sessionResumptionUpdate) {
      handles++;
      console.log(
        el(),
        "*** sessionResumptionUpdate:",
        JSON.stringify(m.sessionResumptionUpdate).slice(0, 160),
      );
      return;
    }
    if (m.error) return console.log(el(), "ERROR:", JSON.stringify(m.error).slice(0, 200));
    const sc = m.serverContent;
    if (sc?.inputTranscription?.text) console.log(el(), "IN :", sc.inputTranscription.text);
    if (sc?.outputTranscription?.text) console.log(el(), "OUT:", sc.outputTranscription.text);
    if (sc?.turnComplete) console.log(el(), "turnComplete");
  };
  ws.onerror = (e) => console.log(el(), "WS ERROR", e.message || "");
  ws.onclose = (e) => console.log(el(), "WS CLOSE", e.code, e.reason || "");

  setTimeout(() => {
    console.log(`\n=== RESULT ===`);
    console.log(`sessionResumptionUpdate messages received: ${handles}`);
    console.log(
      handles > 0
        ? "-> The server DOES issue resumable handles; liveMode now carries them across reconnects."
        : "-> The server issued NO resumable handle for this model/config, so resumption is inert (the carry-across-reconnect fix is still correct and harmless).",
    );
    try {
      ws.close();
    } catch {}
    process.exit(0);
  }, 40000);
})();
