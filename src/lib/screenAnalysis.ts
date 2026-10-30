import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  classifyApiError,
  VISION_MODELS,
  isRecoverableError,
  type ModelConfig,
} from "@/config/models";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const SCREEN_ANALYSIS_PROMPT = `You are analyzing the user's screen. Describe what they are viewing in 1-2 short sentences.
Focus on: what type of content (code, video, document, social media, reading, shopping, gaming, terminal, design, etc.), what website or app it appears to be, and what the user seems to be doing.

If the user is watching a video or listening to music, extract specific details like song/artist, video title, channel name, platform (YouTube, Spotify, etc.), or topics being discussed.

Return JSON with this exact schema:
{
  "summary": "brief 1-sentence description of what's on screen, including specific video/music details if applicable",
  "screenType": "code | video | document | social | reading | shopping | gaming | terminal | design | communication | music | other",
  "category": "work | entertainment | learning | social | productivity | browsing | other"
}`;

/**
 * Server-side screen analysis via OpenRouter vision model.
 *
 * Tries each model in VISION_MODELS in order — a rate-limited primary
 * falls back to the next vision-capable model.
 */
export const analyzeScreen = createServerFn({ method: "POST" })
  .validator(
    z.object({
      image: z.string(),
      model: z.string().min(1).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { image } = data;
    const chain =
      data.model && !VISION_MODELS.some((m) => m.name === data.model)
        ? [{ ...VISION_MODELS[0], name: data.model }, ...VISION_MODELS]
        : VISION_MODELS;

    let lastErr: unknown = new Error("No vision models configured");
    for (const model of chain) {
      try {
        return await requestVision(image, model);
      } catch (err) {
        lastErr = err;
        if (!isRecoverableError(err)) throw err;
      }
    }
    throw lastErr;
  });

async function requestVision(image: string, model: ModelConfig) {
  const controller = new AbortController();
  const tId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.SITE_URL || "http://localhost:3000",
        "X-Title": "AI Anime Waifu",
      },
      body: JSON.stringify({
        model: model.name,
        messages: [
          { role: "system", content: SCREEN_ANALYSIS_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Describe what is on my screen right now." },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
            ],
          },
        ],
        max_tokens: model.maxTokens,
        temperature: model.temperature,
        ...(model.excludeReasoning ? { reasoning: { exclude: true } } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw classifyApiError(response.status, errorText, false);
    }

    const json = await response.json();
    const content: string = json.choices?.[0]?.message?.content || "";
    const parsed = parseScreenAnalysis(content);

    if (!parsed.summary) {
      // Nothing usable came back — treat it as a failure so the chain moves on
      // to the next vision model instead of storing an empty summary.
      throw classifyApiError(
        502,
        `Vision model "${model.name}" returned no usable description (finish_reason=${json.choices?.[0]?.finish_reason ?? "unknown"}).`,
        false,
      );
    }

    return parsed;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw classifyApiError(0, "", true);
    }

    if (err && typeof err === "object" && "code" in (err as Record<string, unknown>)) {
      throw err;
    }

    throw classifyApiError(0, `Screen analysis error: ${(err as Error).message}`, false);
  } finally {
    clearTimeout(tId);
  }
}

/**
 * Extract {summary, screenType, category} from model output.
 *
 * Free vision models are messy: they wrap JSON in ```json fences, prefix it
 * with "**Reasoning:** …" prose (the primary ignores `reasoning.exclude`), or
 * answer in plain English with no JSON at all. Every shape is handled here so
 * Screen Vision degrades to a usable sentence instead of failing.
 */
function parseScreenAnalysis(content: string): {
  summary: string;
  screenType: string;
  category: string;
} {
  const trimmed = stripReasoningProse(content).trim();
  const fallback = { summary: firstSentence(trimmed), screenType: "", category: "" };

  const candidates = jsonCandidates(trimmed);
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
      if (!summary) continue;
      return {
        summary,
        screenType: normalizeEnum(obj.screenType, SCREEN_TYPES, "other"),
        category: normalizeEnum(obj.category, CATEGORIES, "other"),
      };
    } catch {
      /* try the next candidate */
    }
  }

  // No JSON (or none with a summary) — fall back to regex over the whole blob.
  const grab = (key: string): string => {
    const m = trimmed.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, "i"));
    return m ? m[1] : "";
  };
  const regexSummary = grab("summary");
  if (regexSummary) {
    return {
      summary: regexSummary,
      screenType: normalizeEnum(grab("screenType"), SCREEN_TYPES, "other"),
      category: normalizeEnum(grab("category"), CATEGORIES, "other"),
    };
  }

  return fallback;
}

/** Drop a leading "**Reasoning:** …" preamble ahead of the actual answer. */
function stripReasoningProse(content: string): string {
  // Markdown heading / label forms, e.g. "### Reasoning", "**Reasoning:**".
  const marker = content.search(
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*{0,2})\s*(reasoning|thinking|analysis step|thoughts)\s*(?:\*{0,2})\s*[:\-–]/i,
  );
  if (marker === -1) return content;
  // Keep whatever follows the reasoning block — the answer is always after it.
  const rest = content.slice(marker);
  const afterHeading = rest.replace(/^[^\n]*\n/, "");
  return afterHeading.trim() || rest;
}

/** Ordered JSON snippets to try: fenced block first, then any balanced object. */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) out.push(fenced[1].trim());

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) out.push(text.slice(first, last + 1));

  return out;
}

/** Coerce a free-text enum to one of the known values, else the fallback. */
function normalizeEnum(value: unknown, allowed: readonly string[], fallback: string): string {
  if (typeof value !== "string") return fallback;
  const needle = value.trim().toLowerCase();
  const hit = allowed.find((a) => a === needle || needle.includes(a));
  return hit ?? fallback;
}

const SCREEN_TYPES = [
  "code",
  "video",
  "document",
  "social",
  "reading",
  "shopping",
  "gaming",
  "terminal",
  "design",
  "communication",
  "music",
] as const;

const CATEGORIES = [
  "work",
  "entertainment",
  "learning",
  "social",
  "productivity",
  "browsing",
] as const;

/** First sentence of a plain-text answer, used when the model skips JSON. */
function firstSentence(text: string): string {
  if (!text) return "";
  const clean = text
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^\**\s*(summary|answer)\s*\**\s*[:\-–]\s*/i, "")
    .replace(/[*_`#]/g, "")
    .trim();
  if (!clean) return "";
  const match = clean.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : clean).slice(0, 240).trim();
}
