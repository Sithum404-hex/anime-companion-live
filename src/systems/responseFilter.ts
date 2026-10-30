// responseFilter.ts — Post-processing pipeline for AI responses.
// Enforces short, natural, girly speech regardless of what the model returns.

import type { AiResponse, AiState, RawAiIntent } from "@/waifu/types";

const LLM_ISMS = [
  /\bof course!\b/gi,
  /\bof course,? (i can|here|let|i'?d|sure|yes)\b/gi,
  /\bcertainly!\b/gi,
  /\bcertainly,?\b/gi,
  /\bthat's a great question\b/gi,
  /\bthat's an? (interesting|good|excellent) (question|point)\b/gi,
  /\bi understand\b/gi,
  /\bi appreciate\b/gi,
  /\bI'd be happy to\b/gi,
  /\bI'm here to help\b/gi,
  /\bI'm an AI\b/gi,
  /\bas an AI\b/gi,
  /\bas an? (ai|language model|assistant)\b/gi,
  /\blet me (explain|clarify)\b/gi,
  /\bgreat question\b/gi,
  /\babsolutely!\b/gi,
  /\bwonderful!\b/gi,
  /\bno problem!?\b/gi,
  /\bhere's (what|the|how)\b/gi,
  /\bthat being said\b/gi,
  /\buser-san\b/gi,
  /\bdeveloper-san\b/gi,
  /\b\w+-san\b/gi,
  /\b\w+-chan\b/gi,
  /\b\w+-kun\b/gi,
];

export function stripLLMisms(text: string): string {
  let cleaned = text;
  for (const pattern of LLM_ISMS) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

const STUTTER_RE = /\b([a-zA-Z])-\1([a-zA-Z]+)\b/g;
export function cleanStutters(text: string): string {
  return text.replace(STUTTER_RE, "$1$2");
}

export function stripEmojis(text: string): string {
  return text
    .replace(
      // eslint-disable-next-line no-misleading-character-class -- intentional combined emoji ranges
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Remove model thinking artifacts (Gemma reasoning blocks, unused token floods,
 * turn delimiters) that would look broken in chat or sound broken in TTS.
 */
export function stripThinking(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/<unused\d+>/gi, "");
  cleaned = cleaned.replace(/\[(start|end)[\s_]*thinking\]/gi, "");
  cleaned = cleaned.replace(/<(start|end)_of_turn>/gi, "");
  cleaned = cleaned.replace(/<\|thinking\|>/gi, "");
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

/**
 * Remove planning/chain-of-thought prefixes that reasoning models (e.g.
 * Nemotron 3) sometimes write as plain *content* instead of reasoning tokens
 * — `reasoning:{exclude}` cannot reach those, and a leaked "We need to
 * respond as Yuki: …" must never be spoken or shown. The real reply (the last
 * quoted line / JSON block) is what survives.
 */
export function stripPlanningNoise(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.filter(
    (l) =>
      !/^(we need to|we should|let me|i need to|i should|okay, the user|first,|next,|the user (asks|says|wants|is)|respond as|reply as)\b/i.test(
        l,
      ),
  );
  if (kept.length === 0) return "";
  return kept
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Remove markdown formatting artifacts (bold/italic asterisks, backticks,
 * headings, links) so replies look clean in chat and don't get read
 * character-by-character by TTS.
 */
export function stripMarkdown(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1");
  cleaned = cleaned.replace(/(^|\s)\*([^*\n]+?)\*(?=\s|$)/g, "$1$2");
  cleaned = cleaned.replace(/__([^_]+)__/g, "$1");
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, "");
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

export function truncateSegment(text: string, maxWords = 25): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;

  const truncated = words.slice(0, maxWords).join(" ");
  const lastPunctuation = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("!"),
    truncated.lastIndexOf("?"),
  );

  if (lastPunctuation > truncated.length * 0.4) {
    return truncated.substring(0, lastPunctuation + 1);
  }

  return truncated + "...";
}

export function enforceSegmentLimit(segments: string[], max = 3): string[] {
  if (segments.length <= max) return segments;
  const kept = segments.slice(0, max - 1);
  const merged = segments.slice(max - 1).join(" ");
  kept.push(merged);
  return kept;
}

export function recoverPartialJSON(text: string): AiResponse | null {
  const segMatch = text.match(/"segments"\s*:\s*\[([^\]]*)/);
  if (!segMatch) return null;

  const stringsRe = /"([^"]+)"/g;
  const segments: string[] = [];
  let match;
  while ((match = stringsRe.exec(segMatch[1])) !== null) {
    const seg = match[1].trim();
    if (seg) segments.push(seg);
  }

  if (segments.length === 0) return null;

  let state: AiState | null = null;
  const stateMatch = text.match(/"state"\s*:\s*(\{[^}]*\})/);
  if (stateMatch) {
    try {
      state = JSON.parse(stateMatch[1]);
    } catch {
      state = null;
    }
  }

  let animation: RawAiIntent | null = null;
  const animMatch = text.match(/"animation"\s*:\s*(\{[^}]*\})/);
  if (animMatch) {
    try {
      animation = JSON.parse(animMatch[1]);
    } catch {
      animation = null;
    }
  }

  return { segments, state, animation };
}

export function stripThirdPerson(text: string, characterName = "Youki"): string {
  const thirdPersonRe = new RegExp(
    `\\b${characterName}\\s+(is|was|thinks|feels|wants|doesn't|does|has|can't|won't|loves|hates|misses|says)\\b`,
    "gi",
  );
  return text.replace(thirdPersonRe, (match, verb) => {
    const v = verb.toLowerCase();
    const MAP: Record<string, string> = {
      is: "I'm",
      was: "I was",
      thinks: "I think",
      feels: "I feel",
      wants: "I want",
      "doesn't": "I don't",
      does: "I do",
      has: "I have",
      "can't": "I can't",
      "won't": "I won't",
      loves: "I love",
      hates: "I hate",
      misses: "I miss",
      says: "I say",
    };
    return MAP[v] || match;
  });
}

/**
 * Remove the trailing state/animation JSON block, complete OR truncated.
 *
 * The prompt asks for the block to be appended last, but the model regularly
 * runs out of room mid-object (`…? {"state":`). The balanced-brace extractor
 * then fails, and the raw fragment lands in her spoken reply — she literally
 * says `{"state":`. This matches on the block's leading key, which the prompt
 * contract fixes, so real prose containing braces is never touched.
 */
export function stripTrailingJSON(text: string): string {
  const match = /\{\s*"(?:state|animation)"/.exec(text);
  if (!match) return text;
  return text.slice(0, match.index).trim();
}

/**
 * Best-effort field scrape from a state block that never closed.
 * Keeps her mood updating even when generation was cut short.
 */
export function parseLooseState(block: string): AiState | null {
  const emotion = /"emotion"\s*:\s*"([a-z_]+)"/i.exec(block)?.[1];
  const num = (key: string): number | undefined => {
    const m = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(block);
    return m ? Number(m[1]) : undefined;
  };
  const friendship = num("friendship");
  const trust = num("trust");
  const respect = num("respect");

  if (!emotion && friendship === undefined && trust === undefined && respect === undefined) {
    return null;
  }
  return {
    emotion: (emotion ?? "neutral") as AiState["emotion"],
    friendship: friendship ?? 50,
    trust: trust ?? 50,
    respect: respect ?? 50,
  };
}

export function processResponse(segments: string[], characterName = "Youki"): string[] {
  const cleaned = segments
    .map((s) => cleanStutters(s))
    .map((s) => stripLLMisms(s))
    .map((s) => stripThinking(s))
    .map((s) => stripPlanningNoise(s))
    // Must precede stripMarkdown: the leftover fragment may carry backticks
    // and asterisks that would otherwise be rewritten first.
    .map((s) => stripTrailingJSON(s))
    .map((s) => stripEmojis(s))
    .map((s) => stripThirdPerson(s, characterName))
    .map((s) => stripMarkdown(s))
    .filter((s) => s.length > 0)
    .join(" ");

  // One compact line keeps dialogue natural and prevents long TTS playback.
  return cleaned ? [truncateSegment(cleaned, 18)] : [];
}
