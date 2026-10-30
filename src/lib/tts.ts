import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const TYPECAST_URL = "https://api.typecast.ai/v1/text-to-speech";
const DEFAULT_MODEL = "ssfm-v30";
const DEFAULT_VOICE_ID = "tc_632a759503f3cb7b9c8a717b";
const WAV_HEADER_SIZE = 44;

type EmotionPreset = "normal" | "happy" | "sad" | "angry" | "whisper" | "toneup" | "tonedown";

type PromptPayload =
  | { emotion_type: "smart" }
  | { emotion_type: "preset"; emotion_preset: EmotionPreset; emotion_intensity: number };

const ALLOWED_EMOTION_PRESETS: readonly EmotionPreset[] = [
  "normal",
  "happy",
  "sad",
  "angry",
  "whisper",
  "toneup",
  "tonedown",
] as const;

// Maps app emotion names to Typecast emotion_preset values.
// Only "normal", "happy", "sad", "angry" are used for natural conversation.
// "whisper" and "toneup" are avoided because they produce unnatural cartoon effects.
const APP_EMOTION_TO_PRESET: Record<string, EmotionPreset> = {
  happy: "happy",
  sad: "sad",
  angry: "angry",
  annoyed: "angry",
  embarrassed: "normal",
  excited: "happy",
  nervous: "normal",
  neutral: "normal",
};

function buildPrompt(appEmotion?: string): PromptPayload {
  if (!appEmotion) {
    return { emotion_type: "smart" };
  }

  const preset = APP_EMOTION_TO_PRESET[appEmotion];
  if (preset && ALLOWED_EMOTION_PRESETS.includes(preset)) {
    return {
      emotion_type: "preset",
      emotion_preset: preset,
      emotion_intensity: 1.0,
    };
  }

  return { emotion_type: "smart" };
}

function fixWavHeader(buffer: Buffer): Buffer {
  if (buffer.length <= WAV_HEADER_SIZE) return buffer;
  const dataSize = buffer.length - WAV_HEADER_SIZE;
  buffer.writeUInt32LE(dataSize, 40);
  buffer.writeUInt32LE(dataSize + 36, 4);
  return buffer;
}

export const tts = createServerFn({ method: "POST" })
  .validator(
    z.object({
      text: z.string().min(1),
      rate: z.number().min(0.5).max(2).optional(),
      pitch: z.number().optional(),
      emotion: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env.TYPECAST_API_KEY;
    if (!apiKey) throw new Error("TYPECAST_API_KEY not set on server.");

    const cleanText = data.text.replace(/\s+/g, " ").trim();
    if (!cleanText) throw new Error("Text is empty.");

    const prompt = buildPrompt(data.emotion);

    const payload: Record<string, unknown> = {
      text: cleanText,
      model: DEFAULT_MODEL,
      voice_id: DEFAULT_VOICE_ID,
      prompt,
      output: {
        audio_format: "wav",
        audio_tempo: Math.min(2, Math.max(0.5, data.rate ?? 1)),
      },
    };

    if (data.pitch !== undefined) {
      const semitones = Math.round((data.pitch - 1) * 12);
      (payload.output as Record<string, unknown>).audio_pitch = Math.min(
        12,
        Math.max(-12, semitones),
      );
    }

    const response = await fetch(TYPECAST_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Typecast TTS failed (${response.status}): ${errorText}`);
    }

    const raw = await response.arrayBuffer();
    const fixed = fixWavHeader(Buffer.from(raw));
    const base64 = fixed.toString("base64");

    return { audioData: base64 };
  });
