/**
 * High-fidelity Live-mode E2E: real speech through Chrome's REAL fake audio
 * capture device.
 *
 * scripts/e2e-live-app.cjs overrides getUserMedia with a MediaStreamDestination,
 * but the app then applies echoCancellation/noiseSuppression/autoGainControl to
 * that synthetic source and Chrome's NS can gut it ("I heard noise, but the audio
 * broke up"). This version instead writes a WAV to disk and hands it to Chrome via
 * --use-file-for-fake-audio-capture, so speech travels the exact path a real
 * microphone takes: device → constraints → getUserMedia → createMediaStreamSource
 * → ScriptProcessor → 16 kHz PCM → Gemini Live WebSocket.
 *
 * It also spies on WebSocket.send/receive so the exact number of audio chunks and
 * bytes that reach Gemini is measured, not assumed.
 *
 * Usage: node scripts/e2e-live-hifi.cjs [url]
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
const TC_KEY = /^TYPECAST_API_KEY=(.*)$/m
  .exec(env)?.[1]
  ?.trim()
  .replace(/^["']|["']$/g, "");
if (!TC_KEY) throw new Error("TYPECAST_API_KEY missing from .env.local");

const URL_ = process.argv[2] || "http://localhost:5177/";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PHRASE = "Hey Yuki, I brought you some strawberry milk. Do you want some?";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function speechWav(text) {
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

/**
 * Chrome's fake capture device wants a plain RIFF/WAVE. Typecast already returns
 * PCM16 WAV; only the header sizes need to be trustworthy, so rewrite them.
 */
function normalizeWav(buf) {
  const b = Buffer.from(buf);
  if (b.toString("ascii", 0, 4) !== "RIFF") throw new Error("unexpected TTS container");
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") {
      b.writeUInt32LE(size, 40);
      b.writeUInt32LE(size + 36, 4);
      return b;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in TTS wav");
}

(async () => {
  const wavPath = path.join(os.tmpdir(), "live-e2e-speech.wav");
  const wav = normalizeWav(await speechWav(PHRASE));
  fs.writeFileSync(wavPath, wav);
  console.log(`speech wav: ${wavPath} (${(wav.length / 1024).toFixed(0)} KB)`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: [
      "--no-sandbox",
      "--enable-unsafe-swiftshader",
      "--disable-dev-shm-usage",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[PAGEERR] ${String(e).slice(0, 300)}`));

  // Auth gate + WebSocket wire spy (installed before the app boots).
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("waifu.auth.v1", JSON.stringify({ mode: "guest" }));
    localStorage.setItem("waifu.chatHistory.v2", "[]");

    // Timestamp every console line so ASM transitions, TTS start/end and Live
    // events can be placed on ONE timeline — the only reliable way to see which
    // animation state was active while her voice was actually playing.
    window.__timeline = [];
    const t0 = performance.now();
    const origLog = console.log.bind(console);
    console.log = (...a) => {
      const s = a.map(String).join(" ");
      if (/\[ASM\]|VoiceEngine|LipSync|\[Live\]/.test(s)) {
        window.__timeline.push({ t: Math.round(performance.now() - t0), s: s.slice(0, 160) });
      }
      return origLog(...a);
    };

    window.__wire = {
      audioChunks: 0,
      audioBytes: 0,
      videoChunks: 0,
      streamEnd: 0,
      setup: 0,
      input: "",
      output: "",
      errors: [],
    };
    const OrigWS = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new OrigWS(...args);
      const isLive = String(args[0]).includes("generativelanguage");
      if (isLive) {
        const send = ws.send.bind(ws);
        ws.send = (data) => {
          try {
            const m = JSON.parse(data);
            if (m.setup) window.__wire.setup++;
            const ri = m.realtimeInput;
            if (ri) {
              if (ri.audio) {
                window.__wire.audioChunks++;
                window.__wire.audioBytes += ri.audio.data.length;
              }
              if (ri.video) window.__wire.videoChunks++;
              if (ri.audioStreamEnd) window.__wire.streamEnd++;
            }
          } catch {}
          return send(data);
        };
        ws.addEventListener("message", (e) => {
          // Chrome may deliver WS text frames as Blob — the app awaits .text(),
          // so this spy must too, otherwise every transcription reads as empty.
          const take = async () => {
            const raw =
              typeof e.data === "string"
                ? e.data
                : e.data instanceof Blob
                  ? await e.data.text()
                  : new TextDecoder().decode(e.data);
            try {
              const m = JSON.parse(raw);
              if (m.error) window.__wire.errors.push(JSON.stringify(m.error).slice(0, 200));
              const sc = m.serverContent;
              if (sc) {
                if (sc.inputTranscription?.text) window.__wire.input += sc.inputTranscription.text;
                if (sc.outputTranscription?.text)
                  window.__wire.output += sc.outputTranscription.text;
              }
            } catch {}
          };
          void take();
        });
      }
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    Object.assign(window.WebSocket, OrigWS);
  });

  console.log("loading app…");
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(9000);

  const liveTab = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button[role="tab"]')].find((b) =>
      (b.textContent || "").trim().startsWith("Live"),
    ),
  );
  if (!liveTab) {
    console.log("FAIL: no Live tab");
    await browser.close();
    process.exit(1);
  }
  await liveTab.asElement()?.click();
  await sleep(1500);
  console.log("entered Live mode");

  const readState = () =>
    page.evaluate(() => {
      const t = document.body.innerText;
      const pick = (re) => (t.match(re) || [])[0] || "";
      return {
        chip: pick(/Ready — hold to talk|Listening|Thinking|Speaking|Link problem/),
        emotion: pick(/feeling [a-z ]+/),
        mic: !!document.querySelector('span[title="Mic on"]'),
        cam: !!document.querySelector('span[title="Camera on"]'),
        text: t,
      };
    });

  const btn = await page.$(
    'button[aria-label="Hold to talk"], button[aria-label="Release to send"]',
  );
  const box = await btn.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  console.log("PTT down — holding 8s");

  const seen = new Set();
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    const s = await readState();
    if (s.chip && !seen.has(s.chip)) {
      seen.add(s.chip);
      console.log(`  hold ${((i + 1) * 0.5).toFixed(1)}s: "${s.chip}" mic=${s.mic} cam=${s.cam}`);
    }
  }
  const wireDuringHold = await page.evaluate(() => ({ ...window.__wire }));
  await page.mouse.up();
  console.log(
    `PTT up — audio chunks sent during hold: ${wireDuringHold.audioChunks} (${wireDuringHold.audioBytes} b64 chars), video=${wireDuringHold.videoChunks}`,
  );

  for (let i = 0; i < 26; i++) {
    await sleep(1000);
    const s = await readState();
    if (s.chip && !seen.has(s.chip)) {
      seen.add(s.chip);
      console.log(`  +${i + 1}s: "${s.chip}" emotion="${s.emotion.trim()}"`);
    }
  }

  const wire = await page.evaluate(() => ({ ...window.__wire }));
  const timeline = await page.evaluate(() => window.__timeline || []);
  const final = await readState();

  console.log("\n=== GEMINI WIRE MEASUREMENTS ===");
  console.log("setup messages sent:", wire.setup);
  console.log(
    "audio chunks sent  :",
    wire.audioChunks,
    `(${(wire.audioBytes / 1024).toFixed(0)} KB base64)`,
  );
  console.log(
    "  → equivalent secs @16k/16bit:",
    ((wire.audioBytes * 0.75) / 32000).toFixed(2),
    "s",
  );
  console.log("video frames sent  :", wire.videoChunks);
  console.log("audioStreamEnd sent:", wire.streamEnd);
  console.log("server errors      :", wire.errors.length ? wire.errors.join(" | ") : "(none)");
  console.log("\nGemini inputTranscription :", JSON.stringify(wire.input));
  console.log("Gemini outputTranscription:", JSON.stringify(wire.output));
  console.log("\nSaid by app:", JSON.stringify(PHRASE));

  const asm = logs.filter((l) => /\[ASM\]/.test(l));
  console.log(`\n=== ASM (${asm.length}) ===`);
  console.log(asm.join("\n"));

  console.log(`\n=== TIMELINE (one clock, ms since load) ===`);
  for (const e of timeline) console.log(String(e.t).padStart(6), e.s);

  console.log("\n=== PANEL ===");
  console.log(final.text.split("AI Anime Waifu Live Wallpaper")[0].slice(0, 700));

  await browser.close();
  try {
    fs.unlinkSync(wavPath);
  } catch {}
  const heard = wire.input.trim().length;
  console.log(`\nRESULT: ${heard > 3 ? "PASS" : "FAIL"} — Gemini heard ${heard} chars`);
  process.exit(heard > 3 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
