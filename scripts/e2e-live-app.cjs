/**
 * REAL end-to-end test of Live mode in the actual browser app.
 *
 * Everything else in scripts/ tests the Live *protocol* in isolation. This drives
 * the real page: real Gemini Live session through the app's own
 * createLiveToken server fn, real WebSocket, real startMic() capture path, real
 * Web Audio ScriptProcessor, real [emotion] tag parsing and real Soundcast queue.
 *
 * The mic is faked with REAL speech (Typecast TTS, the app's own provider) so
 * Gemini's server-side VAD actually fires — a fake-device beep does not, which is
 * why the protocol-level tone test reports a false FAIL.
 *
 * Usage: node scripts/e2e-live-app.cjs [url]
 */
const fs = require("node:fs");
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

async function speechWavB64(text) {
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
  return Buffer.from(await r.arrayBuffer()).toString("base64");
}

(async () => {
  console.log(`url: ${URL_}`);
  const wavB64 = await speechWavB64(PHRASE);
  console.log(`speech wav: ${(wavB64.length / 1024).toFixed(0)} KB base64`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: [
      "--no-sandbox",
      "--enable-unsafe-swiftshader",
      "--disable-dev-shm-usage",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[PAGEERR] ${String(e).slice(0, 300)}`));
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (/googleapis|typecast/.test(u))
      logs.push(`[REQFAIL] ${u.slice(0, 120)} ${r.failure()?.errorText}`);
  });

  // Auth gate + real-speech mic, installed before the app boots.
  await page.evaluateOnNewDocument((b64) => {
    localStorage.setItem("waifu.auth.v1", JSON.stringify({ mode: "guest" }));
    localStorage.setItem("waifu.chatHistory.v2", "[]");

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      if (c && c.audio) {
        const ctx = new AudioContext();
        if (ctx.state === "suspended") await ctx.resume().catch(() => {});
        const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true; // keep talking for the whole hold
        const dest = ctx.createMediaStreamDestination();
        src.connect(dest);
        src.start();
        console.log(
          "[e2e] fake mic: real speech @ " +
            ctx.sampleRate +
            "Hz, " +
            buf.duration.toFixed(2) +
            "s (looped)",
        );
        return dest.stream;
      }
      return orig(c);
    };
  }, wavB64);

  console.log("loading app…");
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(9000);

  // Enter Live mode.
  const liveTab = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button[role="tab"]')].find((b) =>
      (b.textContent || "").trim().startsWith("Live"),
    ),
  );
  if (!liveTab) {
    console.log(
      "FAIL: no Live tab found. DOM state chips:",
      await page.evaluate(() => document.body.innerText.slice(0, 600)),
    );
    console.log(logs.slice(-40).join("\n"));
    await browser.close();
    process.exit(1);
  }
  await liveTab.asElement()?.click();
  console.log("entered Live mode");
  await sleep(1500);

  const readState = () =>
    page.evaluate(() => {
      const t = document.body.innerText;
      const pick = (re) => (t.match(re) || [])[0] || "";
      return {
        chip: pick(/Ready — hold to talk|Listening|Thinking|Speaking|Link problem/),
        emotion: pick(/feeling [a-z ]+/),
        error: pick(/No response received[^\n]*/) || pick(/GEMINI_API_KEY[^\n]*/),
        micBadge: !!document.querySelector('span[title="Mic on"]'),
        camBadge: !!document.querySelector('span[title="Camera on"]'),
        text: t,
      };
    });

  console.log(`before hold:`, JSON.stringify(await readState()));

  // Hold PTT (real trusted mouse events on the real button).
  const btn = await page.$(
    'button[aria-label="Hold to talk"], button[aria-label="Release to send"]',
  );
  if (!btn) {
    console.log("FAIL: no PTT button found");
    console.log(logs.slice(-40).join("\n"));
    await browser.close();
    process.exit(1);
  }
  const box = await btn.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  console.log("PTT down — holding 6s (speech plays into the mic)");

  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const s = await readState();
    const k = s.chip;
    if (k && !seen.has(k)) {
      seen.add(k);
      console.log(
        `  hold ${((i + 1) * 0.5).toFixed(1)}s: chip="${k}" mic=${s.micBadge} cam=${s.camBadge}`,
      );
    }
  }

  await page.mouse.up();
  console.log("PTT up — waiting for reply");

  for (let i = 0; i < 24; i++) {
    await sleep(1000);
    const s = await readState();
    if (s.chip && !seen.has(s.chip)) {
      seen.add(s.chip);
      console.log(`  +${i + 1}s: chip="${s.chip}" emotion="${s.emotion.trim()}"`);
    }
  }

  const final = await readState();
  console.log("\n=== FINAL PANEL ===");
  console.log("chip:", final.chip);
  console.log("emotion:", final.emotion.trim() || "(none)");
  console.log("error:", final.error || "(none)");

  // Did she ever actually enter the `talking` animation state?
  const asm = logs.filter((l) => /\[ASM\]/.test(l));
  const spoke = asm.filter((l) => /talking/i.test(l));
  console.log(`\n=== ANIMATION STATE MACHINE (${asm.length} transitions) ===`);
  console.log(asm.join("\n"));
  console.log(`\n-> transitions mentioning "talking": ${spoke.length}`);

  const tts = logs.filter((l) => /VoiceEngine|TTS|ttsSystem/i.test(l));
  console.log(`\n=== TTS (${tts.length}) ===`);
  console.log(tts.slice(0, 20).join("\n"));

  console.log(`\n=== TRANSCRIPT PANEL TEXT ===`);
  console.log(final.text.split("AI Anime Waifu Live Wallpaper")[0].slice(0, 800));

  await browser.close();

  const ok = final.chip !== "Link problem" && !!final.emotion;
  console.log(`\nRESULT: ${ok ? "PASS — app-level Live turn produced a tagged reply" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
