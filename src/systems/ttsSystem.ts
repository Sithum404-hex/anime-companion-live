import { tts as ttsServerFn } from "@/lib/tts";

export interface TtsOptions {
  pitch?: number;
  rate?: number;
  volume?: number;
  emotion?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── Emotion prosody presets ─────────────────────────────
// Per-emotion rate/pitch shaping layered on top of Typecast's emotion
// presets, so her voice actually carries mood instead of flatlining.

interface ProsodyPreset {
  /** Playback/synthesis tempo multiplier. */
  rate: number;
  /** Pitch multiplier (1 = natural; >1 brighter, <1 darker). */
  pitch: number;
}

const EMOTION_PROSODY: Record<string, ProsodyPreset> = {
  happy: { rate: 1.06, pitch: 1.08 },
  excited: { rate: 1.12, pitch: 1.12 },
  sad: { rate: 0.92, pitch: 0.94 },
  angry: { rate: 1.04, pitch: 1.02 },
  annoyed: { rate: 1.0, pitch: 0.97 },
  embarrassed: { rate: 1.08, pitch: 1.05 },
  nervous: { rate: 1.1, pitch: 1.03 },
  neutral: { rate: 1.0, pitch: 1.0 },
};

/** Resolve the prosody preset for an emotion (unknown emotions → neutral). */
export function getEmotionProsody(emotion?: string): ProsodyPreset {
  return EMOTION_PROSODY[emotion ?? "neutral"] ?? EMOTION_PROSODY.neutral;
}

// ── Speech text preparation ─────────────────────────────
// Chat text isn't always speakable: emoticons read as gibberish ("semicolon
// underscore semicolon"), tildes and repeated punctuation confuse the voice,
// and bare interjections come out rushed without a beat after them.

const EMOTICON_MAP: [RegExp, string][] = [
  [/[;()]+_+[;()]*/g, ""], // ;_; ;___; )_; etc.
  [/\^_+\^/g, ""], // ^_^ ^__^
  [/[xX]D+/g, ""],
  [/:'?\(/g, ""],
  [/:D+/gi, ""],
  [/<3+/g, " love you"],
  [/\bT_+T\b/g, ""],
];

const INTERJECTIONS = [
  "heehee",
  "hehe",
  "haha",
  "hmm",
  "mmh",
  "mmm",
  "hmph",
  "yay",
  "woah",
  "whoa",
  "ohh",
  "ooh",
  "aww",
  "ugh",
  "pfft",
  "geez",
  "wow",
  "nuh-uh",
];

/**
 * Make chat text sound right when spoken:
 *  • drops emoticons / kaomoji that would be read literally
 *  • trims tildes and collapses punctuation runs ("!!!", "?!")
 *  • inserts a small pause after leading interjections so they breathe
 */
export function prepareSpeechText(input: string): string {
  let text = input;

  for (const [re, replacement] of EMOTICON_MAP) {
    text = text.replace(re, replacement);
  }

  // Tildes are decoration — the prosody presets carry the playfulness instead.
  text = text.replace(/~+/g, " ");

  // Collapse punctuation runs: "so fun!!!" → "so fun!", "what?!" stays "what?"
  text = text.replace(/([!?])\1{1,}/g, "$1");
  text = text.replace(/([!?])\.(?=\s|$)/g, "$1");

  // Pause after interjections: "heehee you're funny" → "heehee, you're funny"
  const interjectionRe = new RegExp(`\\b(${INTERJECTIONS.join("|")})(?!\\s*[,!?\\.])\\b`, "gi");
  text = text.replace(interjectionRe, "$1,");

  // Whitespace cleanup
  text = text
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();

  // Drop stray leading/trailing separators left by removals
  text = text.replace(/^[,\s]+|[,\s]+$/g, "");

  return text;
}

// ── Audio cache ─────────────────────────────────────────
// Repeated lines (greetings, "hehe", etc.) are re-synthesized instantly.

const audioCache = new Map<string, Promise<ArrayBuffer>>();
const MAX_CACHE_ENTRIES = 50;

function cacheKey(text: string, emotion: string, rate: number, pitch: number | undefined): string {
  return `${emotion}|${rate}|${pitch ?? 1}|${text}`;
}

function cacheSet(key: string, promise: Promise<ArrayBuffer>): void {
  audioCache.set(key, promise);
  if (audioCache.size > MAX_CACHE_ENTRIES) {
    const first = audioCache.keys().next().value;
    if (first !== undefined) audioCache.delete(first);
  }
}

function fixWavHeader(buffer: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buffer);
  const dataSize = buffer.byteLength - 44;
  if (dataSize <= 0) return buffer;
  view.setUint32(40, dataSize, true);
  view.setUint32(4, dataSize + 36, true);
  return buffer;
}

async function fetchViaServerFn(
  text: string,
  emotion: string,
  rate: number,
  pitch: number | undefined,
): Promise<ArrayBuffer> {
  const result = await ttsServerFn({
    data: {
      text,
      rate: clamp(rate, 0.5, 2),
      pitch,
      emotion: emotion || undefined,
    },
  });

  if (!result?.audioData) {
    throw new Error("TTS server returned empty audio data.");
  }

  const binaryStr = atob(result.audioData);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  if (bytes.byteLength === 0) throw new Error("TTS audio is empty after decoding.");
  return bytes.buffer as ArrayBuffer;
}

export async function synthesizeSpeech(text: string, opts: TtsOptions = {}): Promise<ArrayBuffer> {
  if (!text || typeof text !== "string") {
    throw new Error("synthesizeSpeech: 'text' must be a non-empty string.");
  }

  const emotion = opts.emotion ?? "neutral";
  const prosody = getEmotionProsody(emotion);

  // Emotion presets modulate the baseline rate/pitch; explicit caller values win.
  const rate = clamp((opts.rate ?? 1) * (opts.emotion ? prosody.rate : 1), 0.5, 2);
  const pitch =
    opts.pitch !== undefined
      ? opts.pitch * (opts.emotion ? prosody.pitch : 1)
      : opts.emotion && prosody.pitch !== 1
        ? prosody.pitch
        : undefined;

  const cleanText = prepareSpeechText(String(text));
  if (!cleanText) throw new Error("synthesizeSpeech: text is empty after speech prep.");

  const key = cacheKey(cleanText, emotion, rate, pitch);
  const cached = audioCache.get(key);
  if (cached) return cached;

  // Server functions work in both development and production. The previous
  // Vite proxy existed only in development, so deployed apps could silently
  // fail before reaching Typecast.
  const promise = fetchViaServerFn(cleanText, emotion, rate, pitch);

  cacheSet(key, promise);
  // Never keep a rejected request in the cache: a later reply should retry
  // synthesis instead of inheriting a transient provider/network failure.
  void promise.catch(() => {
    if (audioCache.get(key) === promise) audioCache.delete(key);
  });
  return promise;
}

/** Begin synthesis while the chat UI updates, then reuse the cached audio. */
export function prefetchSpeech(text: string, opts: TtsOptions = {}): void {
  void synthesizeSpeech(text, opts).catch(() => {
    // Playback performs visible error handling and can retry on demand.
  });
}

export function initTTS(): Promise<void> {
  return Promise.resolve();
}

export function resetTTS(): void {
  /* no-op */
}

export default { initTTS, resetTTS, synthesizeSpeech, prefetchSpeech };
