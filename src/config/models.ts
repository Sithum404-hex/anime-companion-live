/**
 * Centralized model configuration for all OpenRouter API calls.
 *
 * ── Chat ── (live-tested against the real API — updated 2026-09-29)
 *   PRIMARY  : nvidia/nemotron-3-super-120b-a12b:free  (text-only; needs
 *              `reasoning:{exclude:true}` or it leaks chain-of-thought)
 *   FALLBACK : nvidia/nemotron-3-ultra-550b-a55b:free  (same family, slower)
 *
 * ── Vision ── (live-tested against the real API — updated 2026-10-02)
 *   PRIMARY  : dots-studio/dots-3-note-preview:free   (the only free image
 *              model answering reliably; needs a large token budget)
 *   FALLBACK : google/gemma-4-26b-a4b-it:free         (429s often; 400s if
 *              the body includes `reasoning`, so excludeReasoning stays off)
 *
 * ❌ REMOVED (404 — yanked from the free tier, paid-only now):
 *   inclusionai/ling-3.0-flash-vl:free  ← was the chat+vision primary; every
 *   request answered "This model is unavailable for free", which is why chat
 *   stopped working entirely.
 *   nex-agi/nex-n2.5-pro:free  ← HTTP 404, no longer served on the free tier.
 *
 * ❌ REMOVED (not image-capable / not served on free tier):
 *   thinkingmachines/inkling(-small):free  (403)
 *   nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free  (rejects requests)
 *
 * ❌ REMOVED (return 200 but EMPTY content — do not use):
 *   inclusionai/ling-3.0-flash-sante:free,
 *   poolside/laguna-xs-2.1:free, liquid/lfm-2.5-2.6b:free,
 *   dots-studio/dots-3-note-preview:free,
 *   nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,
 *   nvidia/nemotron-3.5-lightning:free
 *
 * ❌ REMOVED (no image endpoint): poolside/laguna-s-2.1:free
 * ❌ REMOVED (agentic-harness only): thinkingmachines/inkling(-small):free
 * ❌ REMOVED (upstream 429 / 503 errors):
 *   google/gemma-4-31b-it:free, qwen/qwen3.8-27b:free,
 *   nex-agi/nex-n2.5-mini:free, poolside/laguna-s-2.1:free
 *
 * RetryManager handles cooldowns / exponential backoff per model.
 */

export interface ModelConfig {
  /** OpenRouter model slug */
  name: string;
  /** Sampling temperature (0–2) */
  temperature: number;
  /** Maximum completion tokens */
  maxTokens: number;
  /** Whether this model supports response_format: { type: "json_object" } */
  supportsJsonMode: boolean;
  /** Human-readable label for console logging */
  label: string;
  /** After this many consecutive failures, the model enters cooldown (default 2) */
  maxConsecutiveFailures: number;
  /** Base cooldown period in ms (doubles each consecutive cooldown cycle) */
  baseCooldownMs: number;
  /**
   * Ask OpenRouter to strip the model's reasoning tokens from the reply
   * (`reasoning: { exclude: true }`). Required for reasoning models —
   * otherwise they leak chain-of-thought into `message.content`.
   */
  excludeReasoning?: boolean;
}

export interface ModelError extends Error {
  code: ModelErrorCode;
  status?: number;
  recoverable: boolean;
  /** Raw response body snippet for logging */
  responseBody?: string;
}

export type ModelErrorCode =
  | "rate_limit"
  | "upstream_rate_limit"
  | "credits_exhausted"
  | "provider_unavailable"
  | "timeout"
  | "auth_error"
  | "invalid_request"
  | "unknown";

export type ModelStatus = "available" | "cooldown" | "exhausted";

// ── Chat Models ─────────────────────────────────────────

/**
 * Token budget for reasoning models.
 *
 * These Nemotron models spend a large part of `max_tokens` on INTERNAL
 * reasoning that OpenRouter does not return when `reasoning.exclude` is set —
 * so a tight budget silently produces `finish_reason:"length"` with EMPTY
 * content. Measured live against the ~6 KB Youki system prompt:
 *   400  → content empty, finish=length   ❌
 *   800  → content empty, finish=length   ❌
 *   1500 → 181 chars,  finish=stop        ✅
 *   2000 → 47-101 chars, finish=stop      ✅
 * 400 was the value that took chat down entirely (every reply surfaced
 * "I can't reach my brain right now"). ModelRouter additionally retries once
 * with a doubled budget if a model ever starves again.
 */
export const CHAT_TOKEN_BUDGET = 2000;

export const CHAT_MODELS: ModelConfig[] = [
  {
    // Verified in-character replies (2026-09-29). Reasoning model — MUST send
    // `reasoning:{exclude:true}` (see excludeReasoning) or every reply starts
    // with leaked chain-of-thought ("Okay, the user is asking...").
    // Text-only — vision requests must use VISION_MODELS.
    name: "nvidia/nemotron-3-super-120b-a12b:free",
    temperature: 0.8,
    // Reasoning models plan before answering — see CHAT_TOKEN_BUDGET.
    maxTokens: CHAT_TOKEN_BUDGET,
    supportsJsonMode: false,
    label: "Nemotron 3 Super (120B)",
    maxConsecutiveFailures: 2,
    baseCooldownMs: 5_000,
    excludeReasoning: true,
  },
  {
    // Verified fallback — same family, bigger and slower, occasional upstream
    // overloads which RetryManager already treats as recoverable.
    name: "nvidia/nemotron-3-ultra-550b-a55b:free",
    temperature: 0.8,
    maxTokens: CHAT_TOKEN_BUDGET,
    supportsJsonMode: false,
    label: "Nemotron 3 Ultra (550B)",
    maxConsecutiveFailures: 2,
    baseCooldownMs: 8_000,
    excludeReasoning: true,
  },
];

// ── Vision Models (screen analysis) ─────────────────────

export const VISION_MODELS: ModelConfig[] = [
  {
    // The ONLY free image-capable model that reliably answers right now
    // (2026-10-02). Verified against the real screen-analysis prompt: returns
    // clean JSON for a test screenshot.
    // Needs a large budget for the same reason as chat — and it IGNORES
    // `reasoning.exclude`, so the parser strips its leaked "Reasoning:" prose.
    name: "dots-studio/dots-3-note-preview:free",
    temperature: 0.3,
    maxTokens: 2000,
    supportsJsonMode: false,
    label: "Dots 3 Note (Vision)",
    maxConsecutiveFailures: 2,
    baseCooldownMs: 5_000,
    excludeReasoning: true,
  },
  {
    // Fallback — DOES accept image input, but:
    //  • frequently 429s on the free tier (cooldown handles it), and
    //  • returns HTTP 400 if `reasoning` is included in the body, so
    //    excludeReasoning stays OFF for this model.
    name: "google/gemma-4-26b-a4b-it:free",
    temperature: 0.3,
    maxTokens: 500,
    supportsJsonMode: false,
    label: "Gemma 4 26B (Vision)",
    maxConsecutiveFailures: 2,
    baseCooldownMs: 8_000,
  },
];

// ── Conversation Limits ─────────────────────────────────

export const CONVERSATION_LIMITS = {
  /** Max user messages per session before the AI needs a break (protects free tier). */
  maxSessionMessages: 50,
  /** Message when the session cap is reached — stays in character. */
  sessionLimitResponses: [
    "Okay, I'm a little tuckered out hehe. Let's pick this up again in a bit, yeah?",
    "Phew, I've been talking a lot. I just need a tiny break, okay? Talk to you soon!",
    "My brain feels fuzzy from all this talking hehe. Come back in a little while, alright?",
  ],
};

// ── Retry / Router Settings ─────────────────────────────

export const ROUTER_SETTINGS = {
  /** Whether to log model transitions to console */
  logging: true,
  /** Minimum backoff delay between retry attempts (ms) */
  baseBackoffMs: 800,
  /** Maximum backoff delay (ms) */
  maxBackoffMs: 15_000,
  /** Backoff multiplier (exponential) */
  backoffMultiplier: 2,
  /** Models slower than this (ms) are flagged as slow */
  slowModelMs: 8_000,
  /** How long a slow model stays flagged (ms) */
  slowPenaltyMs: 60_000,
};

/** Friendly fallback responses when the model is unavailable — stays in character. */
export const FALLBACK_RESPONSES = [
  "Hmm, give me just a moment to think about that...",
  "Sorry, I got a bit distracted there. One moment please!",
  "My thoughts are getting a little jumbled. Let me try again...",
  "Ah, give me one second to gather my thoughts!",
];

// ── Error Classification ────────────────────────────────

export function classifyApiError(status: number, body: string, isTimeout: boolean): ModelError {
  const msg = body.slice(0, 300);
  const lower = body.toLowerCase();

  if (isTimeout) {
    return Object.assign(new Error("Request timed out"), {
      code: "timeout" as ModelErrorCode,
      status,
      recoverable: true,
      responseBody: msg,
    });
  }

  switch (status) {
    case 401:
      return Object.assign(new Error(`Invalid API key: ${msg}`), {
        code: "auth_error" as ModelErrorCode,
        status,
        recoverable: false,
        responseBody: msg,
      });
    case 402:
      return Object.assign(new Error(`OpenRouter credits exhausted: ${msg}`), {
        code: "credits_exhausted" as ModelErrorCode,
        status,
        recoverable: false,
        responseBody: msg,
      });
    case 429:
      // Distinguish upstream provider rate limits from OpenRouter's own 429
      if (lower.includes("upstream") || lower.includes("provider") || lower.includes("origin")) {
        return Object.assign(new Error(`Upstream rate limit: ${msg}`), {
          code: "upstream_rate_limit" as ModelErrorCode,
          status,
          recoverable: true,
          responseBody: msg,
        });
      }
      return Object.assign(new Error(`Rate limited by OpenRouter: ${msg}`), {
        code: "rate_limit" as ModelErrorCode,
        status,
        recoverable: true,
        responseBody: msg,
      });
    default:
      if (
        lower.includes("provider") ||
        lower.includes("unavailable") ||
        lower.includes("overloaded") ||
        lower.includes("upstream") ||
        status >= 500
      ) {
        return Object.assign(new Error(`Provider unavailable (${status}): ${msg}`), {
          code: "provider_unavailable" as ModelErrorCode,
          status,
          recoverable: true,
          responseBody: msg,
        });
      }
      return Object.assign(new Error(`API error ${status}: ${msg}`), {
        code: "unknown" as ModelErrorCode,
        status,
        recoverable: status >= 400,
        responseBody: msg,
      });
  }
}

export function isRecoverableError(err: unknown): err is ModelError {
  if (err && typeof err === "object" && "recoverable" in err) {
    return (err as ModelError).recoverable === true;
  }
  if (err instanceof TypeError) return true;
  return false;
}
