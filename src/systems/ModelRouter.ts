import { chat } from "@/lib/chat";
import {
  CHAT_MODELS,
  ROUTER_SETTINGS,
  isRecoverableError,
  type ModelConfig,
  type ModelError,
} from "@/config/models";
import { RetryManager } from "./RetryManager";
import type { ModelStatus } from "@/config/models";

/** Result returned by ModelRouter.route(). */
export interface RouterResult {
  /** The response text (empty when `failed` is true). */
  text: string;
  /** Name of the model that produced the response. */
  modelUsed: string | null;
  /**
   * True when no model produced a reply (all failed or in cooldown).
   * The caller must surface a typed error instead of pretending the
   * character answered — fallback filler must never enter chat history
   * or TTS.
   */
  failed: boolean;
}

/** Internal logger scoped to the router. */
const log = {
  info: (msg: string) => ROUTER_SETTINGS.logging && console.log(`[Router] ${msg}`),
  warn: (msg: string) => ROUTER_SETTINGS.logging && console.warn(`[Router] ${msg}`),
  error: (msg: string) => ROUTER_SETTINGS.logging && console.error(`[Router] ${msg}`),
};

/** Server-function errors may lose their typed fields during serialization. */
function isAccountError(error: unknown): boolean {
  if (isRecoverableError(error)) return false;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b(401|402)\b|invalid api key|authentication|unauthorized|forbidden|credits? exhausted|billing/i.test(
    message,
  );
}

function recoverableCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /timed? out|abort/i.test(message) ? "timeout" : "provider_unavailable";
}

/** Cap on how long route() waits for a cooldown to expire before falling back. */
const MAX_COOLDOWN_WAIT_MS = 8_000;

/**
 * Hard ceiling for the token-starvation retry, so a pathological provider
 * response can't spin forever.
 */
const MAX_STARVATION_RETRY_TOKENS = 8000;

/**
 * ModelRouter — multi-model request handling with backoff and cooldown.
 *
 * Strategy:
 *   1. Wait for a cooldown if every model is mid-cooling (bounded wait).
 *   2. Try each available model in priority order with exponential backoff.
 *   3. On recoverable error → report to RetryManager, try the next model.
 *   4. On non-recoverable error → mark model exhausted for this session.
 *   5. Never throw errors to the caller — return typed failure instead.
 *
 * Console logging (visible to user in devtools):
 *   [Router] Current model: Gemma 4 (31B)
 *   [Router] Provider response: 429 upstream_rate_limit — Too Many Requests
 */
export class ModelRouter {
  private retryManager!: RetryManager;
  private activeRequest = false;

  constructor() {
    this.retryManager = new RetryManager(CHAT_MODELS);
  }

  /**
   * Route a chat request to the configured model.
   *
   * @param messages - OpenRouter-style message array.
   * @returns RouterResult — always resolves, never throws.
   */
  async route(messages: { role: string; content: string }[]): Promise<RouterResult> {
    this.activeRequest = true;
    this.lastErrorCode = "";

    try {
      let available = this.retryManager.getAvailableModels();

      if (available.length === 0) {
        // Model is cooling down (e.g. free-tier rate limits).
        // Wait for the cooldown to expire before giving up, so the
        // user doesn't get a "give me a moment" filler on every message.
        const waitMs = this.retryManager.getEarliestCooldownMs();
        if (waitMs > 0 && waitMs <= MAX_COOLDOWN_WAIT_MS) {
          log.warn(`Model cooling down — waiting ${Math.round(waitMs)}ms for recovery`);
          await this.sleep(waitMs);
          available = this.retryManager.getAvailableModels();
        }
      }

      if (available.length === 0) {
        log.warn("No models available — in cooldown or exhausted.");
        // Free-tier endpoints (e.g. Nvidia) overload intermittently; models
        // benched as "exhausted" must get a fresh try once everything is
        // down, and the CURRENT message should use that fresh try instead of
        // making the user send again.
        this.retryManager.recoverExhausted();
        available = this.retryManager.getAvailableModels();
      }

      if (available.length === 0) {
        return {
          text: "",
          modelUsed: null,
          failed: true,
        };
      }

      // Try every available model in priority order — a rate-limited
      // primary must never take the whole chat down when a fallback works.
      for (const model of available) {
        log.info(`Current model: ${model.label} (${model.name})`);

        const result = await this.tryModel(model, messages);

        if (result.success) {
          this.retryManager.reportSuccess(model.name);
          log.info(`Success: ${model.label}`);
          return { text: result.text, modelUsed: model.name, failed: false };
        }

        // Report failure and log provider response
        const errCode = result.errorCode || "unknown";
        const errMsg = result.errorMessage || "";
        log.warn(`Provider response: ${errCode}${errMsg ? ` — ${errMsg.slice(0, 120)}` : ""}`);
        this.lastErrorCode = errCode;

        if (errCode === "fatal") {
          // Bad API key / credits exhausted — no point trying the other models.
          this.retryManager.reportFailure(model.name);
          break;
        }

        if (errCode === "empty_response") {
          // 200 OK but empty content. On today's free tier this is usually a
          // transient overload symptom (the endpoint collapses under load),
          // not a structurally broken model — treat it like any other
          // recoverable failure so a short cooldown (not a 30 min bench)
          // governs the retry.
          log.warn(`${model.label} returned empty content — treating as transient.`);
          this.retryManager.reportFailure(model.name);
          continue;
        }

        this.retryManager.reportFailure(model.name);
      }

      // No model produced a reply — return typed failure instead of filler.
      log.error("All models failed — surfacing failure to caller.");
      return {
        text: "",
        modelUsed: null,
        failed: true,
      };
    } finally {
      this.activeRequest = false;
    }
  }

  // ── Internal ──────────────────────────────────────────

  private lastErrorCode = "";

  /**
   * Try a single model with exponential backoff.
   * Returns { success, text, errorCode, errorMessage } — never throws.
   */
  private async tryModel(
    model: ModelConfig,
    messages: { role: string; content: string }[],
  ): Promise<{
    success: boolean;
    text: string;
    errorCode?: string;
    errorMessage?: string;
  }> {
    let tokenBudget = model.maxTokens;

    // One starvation retry is allowed per model. A reasoning model that blows
    // through the whole budget thinking comes back with finish_reason "length"
    // and EMPTY content — indistinguishable from a broken endpoint at the
    // error-code level, but the fix is simply more tokens, not a cooldown.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.attempt(model, messages, tokenBudget);

      if (result.success || result.errorCode !== "token_starvation") return result;

      const bigger = Math.min(tokenBudget * 2, MAX_STARVATION_RETRY_TOKENS);
      if (bigger === tokenBudget) return result; // already at the ceiling
      log.warn(`${model.label} starved at ${tokenBudget} tokens — retrying with ${bigger}.`);
      tokenBudget = bigger;
    }

    return { success: false, text: "", errorCode: "token_starvation", errorMessage: "" };
  }

  /**
   * Try a single model with exponential backoff.
   * Returns { success, text, errorCode, errorMessage } — never throws.
   */
  private async attempt(
    model: ModelConfig,
    messages: { role: string; content: string }[],
    maxTokens: number,
  ): Promise<{
    success: boolean;
    text: string;
    errorCode?: string;
    errorMessage?: string;
  }> {
    const backoffMs = this.retryManager.getBackoffDelay(model.name);

    // Apply backoff delay before attempting
    if (backoffMs > 1000) {
      await this.sleep(backoffMs);
    }

    this.retryManager.markAttemptStart(model.name);
    const startedAt = performance.now();

    try {
      const data = await chat({
        data: {
          messages,
          model: model.name,
          jsonMode: model.supportsJsonMode,
          maxTokens,
          temperature: model.temperature,
          timeout: 30_000,
          excludeReasoning: model.excludeReasoning ?? false,
        },
      });

      const text: string = data.text;
      if (text) {
        const elapsed = performance.now() - startedAt;
        this.retryManager.reportLatency(model.name, elapsed);
        return { success: true, text };
      }

      // No content because generation ran out of budget, not because the model
      // is down — retry bigger instead of benching it in cooldown.
      if (data.finishReason === "length") {
        return {
          success: false,
          text: "",
          errorCode: "token_starvation",
          errorMessage: `No output within ${maxTokens} tokens (finish_reason=length)`,
        };
      }

      return {
        success: false,
        text: "",
        errorCode: "empty_response",
        errorMessage: "Model returned empty content",
      };
    } catch (err) {
      const modelErr = err as ModelError;

      if (isAccountError(err)) {
        // Non-recoverable (bad API key, credits exhausted) — abort this model
        this.retryManager.markExhausted(model.name);
        return {
          success: false,
          text: "",
          errorCode: "fatal",
          errorMessage: modelErr.message,
        };
      }

      return {
        success: false,
        text: "",
        errorCode: recoverableCode(err),
        errorMessage: modelErr.message,
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Human-readable summary of all model health states.
   */
  getSummary(): Record<string, { status: ModelStatus; failures: number; cooldownCycle: number }> {
    return this.retryManager.getSummary();
  }

  /** Reset router state (model cooldowns). */
  reset(): void {
    this.retryManager.reset();
    this.lastErrorCode = "";
  }
}
