/**
 * REAL end-to-end audio test for the Gemini Live pipeline.
 *
 * The existing scripts/diag-live-turn.cjs feeds a 220 Hz sine tone, which Gemini's
 * server-side VAD does not classify as speech — so it reports FAIL even on a healthy
 * model. This script synthesises REAL speech with Typecast (the same TTS provider the
 * app already pays for), decodes it to 16 kHz mono PCM16, and streams it into the Live
 * WebSocket exactly the way src/waifu/liveMode.ts does.
 *
 * This exercises the actual production path:
 *   PCM16 @16k base64 -> realtimeInput.audio -> inputTranscription -> outputTranscription
 *
 * Usage: node scripts/diag-live-speech.cjs [model]
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
if (!TC_KEY) throw new Error("TYPECAST_API_KEY missing from .env.local");

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

const model = process.argv[2] || "gemini-2.5-flash-native-audio-latest";
const TARGET_RATE = 16000;
const PHRASE = "Hey Yuki, what is two plus two?";

/** Minimal RIFF/WAVE parser -> { rate, channels, bitsPerSample, interleaved Int16 } */
function decodeWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE buffer");
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error("WAV missing fmt/data chunk");
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`expected PCM16 (format=1 bits=16), got format=${fmt.format} bits=${fmt.bits}`);
  }
  const samples = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  return { ...fmt, samples };
}

/** Downmix to mono, band-limit-ish decimate, normalize — mirrors liveMode.ts resampling. */
function toMono16k({ channels, rate, samples }) {
  const frames = Math.floor(samples.length / channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += samples[i * channels + c];
    mono[i] = acc / channels / 32768;
  }

  // Linear-interp resample to 16 kHz.
  const ratio = rate / TARGET_RATE;
  const outLen = Math.floor(frames / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, frames - 1);
    const frac = pos - i0;
    let v = mono[i0] * (1 - frac) + mono[i1] * frac;
    if (v > 1) v = 1;
    if (v < -1) v = -1;
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

const b64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString("base64");

async function mintToken() {
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

/** Real speech WAV via Typecast — the app's own TTS provider. */
async function synthSpeech(text) {
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
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  console.log(`model: ${model}`);
  console.log(`synthesising speech: "${PHRASE}"`);
  const wav = decodeWav(await synthSpeech(PHRASE));
  const pcm = toMono16k(wav);
  console.log(
    `source: ${wav.rate}Hz x${wav.channels}ch -> ${TARGET_RATE}Hz mono, ` +
      `${(pcm.length / TARGET_RATE).toFixed(2)}s, ${b64(pcm).length} b64 chars`,
  );

  const token = await mintToken();
  console.log("token ok");

  const ws = new WebSocket(`${WS_BASE}?access_token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";
  const t0 = Date.now();
  const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  let setup = false,
    input = "",
    out = "",
    turnDone = false,
    sawAudio = false,
    err = null;
  let chunks = 0;

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
            parts: [
              {
                text:
                  "You are Yuki, a warm anime companion. Reply in ONE short sentence and " +
                  "begin every reply with a bracketed emotion tag like [happy].",
              },
            ],
          },
        },
      }),
    );

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
      return console.log(el(), "UNPARSED:", text.slice(0, 160));
    }

    if (m.error) {
      err = JSON.stringify(m.error).slice(0, 250);
      return console.log(el(), "ERROR:", err);
    }
    if (m.setupComplete && !setup) {
      setup = true;
      console.log(el(), "setupComplete — streaming speech at 100ms/chunk");
      // Stream in real time (100ms chunks) so server-side VAD behaves as in the browser.
      const CH = TARGET_RATE / 10;
      let off = 0;
      const iv = setInterval(() => {
        if (off >= pcm.length || ws.readyState !== 1) {
          clearInterval(iv);
          ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
          console.log(el(), `audioStreamEnd sent (${chunks} chunks)`);
          return;
        }
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: b64(pcm.subarray(off, off + CH)),
                mimeType: `audio/pcm;rate=${TARGET_RATE}`,
              },
            },
          }),
        );
        off += CH;
        chunks++;
      }, 100);
      return;
    }

    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      input += sc.inputTranscription.text;
      console.log(el(), "INPUT:", JSON.stringify(sc.inputTranscription.text));
    }
    if (sc.outputTranscription?.text) {
      out += sc.outputTranscription.text;
      console.log(el(), "OUTPUT:", JSON.stringify(sc.outputTranscription.text));
    }
    if (sc.modelTurn?.parts?.some((p) => p.inlineData?.data)) sawAudio = true;
    if (sc.interrupted) console.log(el(), "interrupted");
    if (sc.turnComplete || sc.generationComplete) {
      turnDone = true;
      console.log(el(), "turnComplete");
    }
  };

  ws.onerror = (e) => {
    err = err || `wserror ${e.message || ""}`;
  };
  ws.onclose = (e) => console.log(el(), "WS CLOSE:", e.code, JSON.stringify(e.reason || ""));

  setTimeout(() => {
    console.log(`\n=== VERDICT [${model}] — real speech ===`);
    console.log(`setup=${setup} inputTranscription=${JSON.stringify(input)} `);
    console.log(`outputTranscription=${JSON.stringify(out)}`);
    console.log(`turnComplete=${turnDone} sawModelAudio=${sawAudio} err=${err}`);
    const pass = setup && input.trim().length > 0 && turnDone && out.trim().length > 0;
    console.log(pass ? "RESULT: PASS — full audio turn works" : "RESULT: FAIL — broken audio turn");
    try {
      ws.close();
    } catch {}
    process.exit(pass ? 0 : 1);
  }, 45000);
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(2);
});
