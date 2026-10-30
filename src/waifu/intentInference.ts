/**
 * intentInference.ts — the character's "thinking" bridge between text and body.
 *
 * LLMs often narrate an action in prose ("Okay, I'm dancing!") while failing
 * to emit the structured `animation` block, so nothing ever plays. This module
 * reads BOTH sides of the turn — the user's request and the AI's answer — and
 * deterministically derives the animation that should run:
 *
 *   1. Explicit request match  → forced intent (user asked for it, it happens)
 *   2. Answer narrates action  → fallback intent (she says what she's doing)
 *   3. Negation (don't/never)  → rule suppressed
 *
 * All emitted actions are registry intent ids, so they survive validation
 * downstream and can never 404 on a bad filename.
 */
import type { RawAiIntent } from "./types";

export interface InferredIntent {
  action: string;
  confidence: number;
  /** True when the user explicitly asked for this — wins over a model miss. */
  forced: boolean;
  source: "request" | "answer" | "request+answer";
  /** Optional descriptor tags (e.g. pose mood) forwarded to the registry. */
  tags?: string[];
}

interface IntentRule {
  action: string;
  /** Phrase patterns the USER uses to request/ask for this action. */
  request: RegExp[];
  /** Phrase patterns in the AI reply that narrate doing this action. */
  answer: RegExp[];
  /** If any of these match the text, the rule is suppressed (negation). */
  negate?: RegExp[];
  /** Base confidence when the user asked and she hasn't confirmed yet. */
  confidence: number;
  /** Optional tags forwarded with the action (generic pose mood selection). */
  tags?: string[];
}

/** Negations that kill a detected intent. */
const NEGATE =
  /(?:don'?t|do not|never|won'?t|wouldn'?t|can'?t|cannot|can not|no need|stop|quit|refuse)\b/i;

/**
 * Body-intent rules — ordered most-specific → generic so "salsa" wins over
 * plain "dance" and "blow a kiss" wins over "kiss".
 */
const RULES: IntentRule[] = [
  // ── Named dances (specific styles first) ──────────────────
  {
    action: "salsa",
    request: [/\bsalsa\b/i],
    answer: [/\bsalsa\b/i],
    confidence: 0.9,
  },
  {
    action: "rumba",
    request: [/\brumba\b/i],
    answer: [/\brumba\b/i],
    confidence: 0.9,
  },
  {
    action: "macarena",
    request: [/\bmacarena\b/i],
    answer: [/\bmacarena\b/i],
    confidence: 0.9,
  },
  {
    action: "samba",
    request: [/\bsamba\b/i],
    answer: [/\bsamba\b/i],
    confidence: 0.9,
  },
  {
    action: "hiphop",
    request: [/\bhip[-\s]?hop\b/i],
    answer: [/\bhip[-\s]?hop\b/i],
    confidence: 0.9,
  },
  {
    action: "jazz",
    request: [
      /\b(?:dance|dancing|danced)\b[^.]{0,40}\bjazz\b|\bjazz\b[^.]{0,40}\b(?:dance|dancing)\b/i,
    ],
    answer: [/\bjazz\b/i],
    confidence: 0.85,
  },
  {
    action: "shuffling",
    request: [/\bshuffl\w*\b/i],
    answer: [/\bshuffl\w*\b/i],
    confidence: 0.85,
  },
  {
    action: "belly_dance",
    request: [/\bbelly\s*danc\w*\b/i],
    answer: [/\bbelly\s*danc\w*\b/i],
    confidence: 0.9,
  },
  {
    action: "snake_hiphop",
    request: [/\bsnake\b[^.]{0,30}\bdanc\w*\b|\bbody\s*wave\b/i],
    answer: [/\bsnake\b[^.]{0,30}\bdanc\w*\b|\bbody\s*wave\b/i],
    confidence: 0.85,
  },
  {
    action: "booty_hiphop",
    request: [/\btwerk\w*\b|\bbooty\b[^.]{0,30}\bdanc\w*\b/i],
    answer: [/\btwerk\w*\b|\bbooty\b/i],
    confidence: 0.85,
  },
  {
    action: "twist_dance",
    request: [
      /\btwist\b[^.]{0,20}\bdanc\w*\b|\bdanc\w*\b[^.]{0,20}\btwist\b|\bdo\s+the\s+twist\b/i,
    ],
    answer: [/\btwist\b/i],
    confidence: 0.85,
  },
  {
    action: "ymca",
    request: [/\bymca\b/i],
    answer: [/\bymca\b/i],
    confidence: 0.9,
  },
  // Named K-pop imotes double as dances, so they must resolve before the
  // generic dance rule ("planet b dance" is Planet B, not freestyle).
  {
    action: "heart_crush_a",
    request: [/\bheart\s*crush\b/i],
    answer: [/\bheart\s*crush\b/i],
    confidence: 0.95,
  },
  {
    action: "planet_b",
    request: [/\bplanet\s*b\b/i],
    answer: [/\bplanet\s*b\b/i],
    confidence: 0.95,
  },
  // ── Generic dance (must stay after the named styles) ────────
  {
    action: "dance",
    request: [
      /\bdanc\w*\b/i,
      /\bboogie\b/i,
      /\bgroov\w*\b/i,
      /\bbust\s+a\s+move\b/i,
      /\bshow\s+me\s+your\s+moves\b/i,
    ],
    answer: [/\bdanc\w*\b/i, /\bboogie\b/i, /\bmoving\s+(?:my\s+)?(?:body|hips|feet)\b/i],
    negate: [
      /\b(?:don'?t|do not|never|won'?t|stop)\b[^.!?]{0,40}\bdanc\w*\b/i,
      /\bdanc\w*\b[^.!?]{0,20}\b(?:don'?t|never|stop)\b/i,
    ],
    confidence: 0.85,
  },

  // ── Captured emotes the user can request ────────────────────
  {
    action: "blow_kiss",
    request: [/\bblow\w*\s+(?:me\s+)?a?\s*kiss\b|\bsend\s+me\s+a\s+kiss\b/i],
    answer: [/\bblow\w*\s+(?:you\s+)?a?\s*kiss\b/i],
    confidence: 0.9,
  },
  {
    action: "kiss",
    request: [/\bkiss\b/i],
    answer: [/\bblows?\b[^.!?]{0,20}\bkiss\b/i],
    negate: [/\bkiss\b[^.!?]{0,30}\b(?:don'?t|never)\b|\b(?:don'?t|never)\b[^.!?]{0,30}\bkiss\b/i],
    confidence: 0.85,
  },
  // ── Tagged poses (must stay before the generic pose rule) ──
  {
    action: "pose",
    tags: ["cute"],
    request: [
      /\bcute pose\b|\badorable pose\b|\bsomething cute\b|\banything cute\b|\bcute\b[^.!?]{0,15}\bpose\b|\bpose\b[^.!?]{0,15}\bcute\b/i,
    ],
    answer: [/\bcute pose\b|\bstrikes? a cute pose\b/i],
    confidence: 0.9,
  },
  {
    action: "pose",
    tags: ["angry"],
    request: [/\bangry pose\b|\bfurious pose\b|\bpose\b[^.!?]{0,15}\bangry\b/i],
    answer: [/\bangry pose\b|\bstrikes? an angry pose\b/i],
    confidence: 0.9,
  },
  {
    action: "pose",
    tags: ["sad"],
    request: [/\bsad pose\b|\bpose\b[^.!?]{0,15}\bsad\b/i],
    answer: [/\bsad pose\b|\bstrikes? a sad pose\b/i],
    confidence: 0.9,
  },
  {
    action: "pose",
    tags: ["happy"],
    request: [/\bhappy pose\b|\bpose\b[^.!?]{0,15}\bhappy\b/i],
    answer: [/\bhappy pose\b|\bstrikes? a happy pose\b/i],
    confidence: 0.9,
  },

  // ── Imotes (greetings, goodbyes, performances) ──────────
  {
    action: "goodbye",
    request: [/\bgoodbye\b|\bbye[\s-]?bye\b|\bfarewell\b|\bsee ya\b|\bwave (?:goodbye|bye)\b/i],
    answer: [/\bgoodbye\b|\bbye[\s-]?bye\b|\bwav(?:e|es|ing) goodbye\b/i],
    negate: [/\b(?:don'?t|never)\b[^.!?]{0,30}\b(?:goodbye|bye)\b/i],
    confidence: 0.9,
  },
  {
    action: "greeting",
    request: [
      /\bsay (?:hi|hello)\b|\bgreet(?:\s+me)?\b|\bwave (?:at|to) me\b|\bwave\b|\bwelcome me\b/i,
    ],
    answer: [/\bwav(?:e|es|ing)\b|\bopens? (?:my |both )?(?:arms|hands)\b/i],
    confidence: 0.85,
  },
  {
    action: "sing",
    request: [/\bsing\b|\bsinging\b|\bkaraoke\b|\bsing a song\b/i],
    answer: [/\bsing(?:ing|s)\b|\bkaraoke\b/i],
    negate: [/\b(?:don'?t|never)\b[^.!?]{0,20}\bsing\b/i],
    confidence: 0.9,
  },
  {
    action: "selfie",
    request: [
      /\bselfie\b|\btake (?:a |an )?(?:photo|picture|pic|selfie)\b|\bpic(?:ture)? with me\b/i,
    ],
    answer: [/\bselfie\b|\btaking (?:a |an )?(?:photo|picture|pic)\b/i],
    confidence: 0.9,
  },
  {
    action: "bunny_ears",
    request: [/\bbunny ears?\b|\bbunny\b/i],
    answer: [/\bbunny ears?\b/i],
    confidence: 0.9,
  },
  {
    action: "draw_a_star",
    request: [/\bdraw (?:a |the )?star\b|\bdrawing (?:a )?star\b/i],
    answer: [/\bdrawing (?:a )?star\b|\bdraws? (?:a )?star\b/i],
    confidence: 0.9,
  },
  {
    action: "give_your_soul",
    request: [/\bgive (?:me )?your soul\b/i],
    answer: [/\bgive (?:me )?your soul\b/i],
    confidence: 0.95,
  },
  {
    action: "pose",
    request: [/\bpose\b|\bstrike\s+(?:a\s+)?pose\b/i],
    answer: [/\bpose\b/i],
    negate: [/\bpose\b[^.!?]{0,30}\b(?:don'?t|never)\b|\b(?:don'?t|never)\b[^.!?]{0,30}\bpose\b/i],
    confidence: 0.85,
  },
  {
    action: "jump",
    request: [/\bjump\b/i],
    answer: [/\bjump\w*\b/i],
    negate: [/\bjump\b[^.!?]{0,30}\b(?:don'?t|never)\b/i],
    confidence: 0.85,
  },
  {
    action: "jog",
    request: [/\bjog\b/i],
    answer: [/\bjog\w*\b/i],
    confidence: 0.85,
  },
  {
    action: "excited",
    request: [/\b(?:get|be|act)\s+excited\b|\bexcite\s+me\b/i],
    answer: [/\bso\s+excited\b/i],
    confidence: 0.75,
  },
  {
    action: "cheer",
    request: [
      /\bcheer\b(?!\s+up)|\bcheer\s+(?:for\s+me|me\s+on)\b|\blight[\s-]?stick\b|\bglow\s?stick\b/i,
    ],
    answer: [/\bcheering\b|\blight[\s-]?stick\b/i],
    confidence: 0.85,
  },
  {
    action: "happy",
    request: [/\b(?:be|act|get)\s+happy\b|\bcheer\s+(?:up|me)\b|\bsmile\s+for\s+me\b/i],
    answer: [/\bhappy\b/i],
    confidence: 0.75,
  },
  {
    action: "crying",
    request: [/\b(?:make\s+me|cry|you\s+should)\s+cry\b|\btry\s+to\s+cry\b/i],
    answer: [/\btears\b|\bcrying\b/i],
    negate: [/\bcry\b[^.!?]{0,30}\b(?:don'?t|never)\b/i],
    confidence: 0.8,
  },
  {
    action: "angry",
    request: [/\b(?:act|get|be)\s+angry\b|\bpretend\b[^.!?]{0,25}\bangry\b/i],
    answer: [/\b(?:mad|angry)\b/i],
    confidence: 0.75,
  },
  {
    action: "thinking",
    request: [/\bthink\s+(?:hard|about\s+it)\b|\bwhat\s+are\s+you\s+thinking\b/i],
    answer: [/\bthinking\b/i],
    confidence: 0.8,
  },
  {
    action: "look_around",
    request: [/\blook\s+around\b/i],
    answer: [/\blook(?:ing)?\s+around\b/i],
    confidence: 0.8,
  },
  {
    action: "hand_raise",
    request: [/\braise\s+(?:your\s+)?hand\b/i],
    answer: [/\brais(?:e|ing)\s+(?:my\s+)?hand\b/i],
    confidence: 0.85,
  },
  {
    action: "no",
    request: [/\bshake\s+(?:your\s+)?head\b|\bsay\s+no\b/i],
    answer: [/\bshakes?\s+(?:my\s+)?head\b/i],
    confidence: 0.8,
  },
  {
    action: "bashful",
    request: [/\b(?:act|be)\s+shy\b|\bget\s+embarrassed\b/i],
    answer: [/\b(?:shy|embarrassed|bashful)\b/i],
    confidence: 0.75,
  },
];

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * Infer what the character should be DOING from a complete turn.
 * Returns null when there is no actionable intent in the exchange.
 */
export function inferIntent(requestText: string, answerText: string): InferredIntent | null {
  const request = requestText ?? "";
  const answer = answerText ?? "";
  // Drop trailing concession clauses ("but don't overdo it", "though…") so a
  // positive request with a follow-up constraint still counts as a request.
  const requestCore = request.replace(/(?:,?\s*(?:but|though|unless|just)\s*).*$/i, "");

  // Pass 1 — the user asked for something. A plain "dance" in a sentence like
  // "can you dance?" or "dance for me!" counts: it is always an action order.
  for (const rule of RULES) {
    if (!matches(rule.request, request)) continue;
    if (rule.negate && (matches(rule.negate, requestCore) || matches(rule.negate, answer))) {
      continue;
    }
    const confirmed = matches(rule.answer, answer);
    return {
      action: rule.action,
      confidence: confirmed ? 1.0 : rule.confidence,
      forced: true,
      source: confirmed ? "request+answer" : "request",
      ...(rule.tags ? { tags: rule.tags } : {}),
    };
  }

  // Pass 2 — no explicit request, but the AI's reply narrates her own action
  // ("*does a little dance*", "I'm dancing now"). Play it back, softly.
  for (const rule of RULES) {
    if (!matches(rule.answer, answer)) continue;
    const negated =
      NEGATE.test(answer.slice(0, 120)) && rule.action !== "thinking" && rule.action !== "happy";
    if (negated && matches(rule.answer, answer)) continue;
    return {
      action: rule.action,
      confidence: 0.55,
      forced: false,
      source: "answer",
      ...(rule.tags ? { tags: rule.tags } : {}),
    };
  }

  return null;
}

/** Wrap an inferred action in the same shape the model emits. */
export function inferredToIntent(inferred: InferredIntent | null): RawAiIntent | null {
  if (!inferred) return null;
  return {
    action: inferred.action,
    confidence: inferred.confidence,
    ...(inferred.tags ? { tags: inferred.tags } : {}),
  };
}
