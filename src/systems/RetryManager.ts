import { CHAT_MODELS, ROUTER_SETTINGS, type ModelConfig, type ModelStatus } from "@/config/models";

/**
 * Per-model runtime state tracked by RetryManager.
 */
interface ModelState {
  config: ModelConfig;
  consecutiveFailures: number;
  cooldownCycle: number; // how many times this model has entered cooldown
  cooldownUntil: number; // performance.now() timestamp; 0 = available
  exhaustedUntil: number; // performance.now() timestamp; 0 = not exhausted
  lastLatencyMs: number; // measured latency of the most recent successful call
  slowUntil: number; // performance.now() timestamp; while set the model is deprioritized
  currentAttemptStart: number; // performance.now() when the current attempt started
}

/** How long a model stays out of rotation after a fatal error (ms). */
const EXHAUSTED_MS = 30 * 60 * 1000;

/**
 * RetryManager — tracks per-model health and implements exponential backoff.
 *
 * Each model has:
 *   • consecutiveFailures — resets on success
 *   • cooldownCycle — increments each time the model enters cooldown
 *   • cooldownUntil — timestamp after which the model is tried again
 *
 * Cooldown duration: baseCooldownMs * 2 ^ cooldownCycle (capped at 300s).
 * After a model succeeds, its cooldownCycle resets to 0.
 */
export class RetryManager {
  private models: Map<string, ModelState> = new Map();

  constructor(models: ModelConfig[] = CHAT_MODELS) {
    for (const config of models) {
      this.models.set(config.name, {
        config,
        consecutiveFailures: 0,
        cooldownCycle: 0,
        cooldownUntil: 0,
        exhaustedUntil: 0,
        lastLatencyMs: 0,
        slowUntil: 0,
        currentAttemptStart: 0,
      });
    }
  }

  // ── Public API ────────────────────────────────────────

  /** Get status of a specific model. */
  getStatus(modelName: string): ModelStatus {
    const state = this.models.get(modelName);
    if (!state) return "exhausted";
    const now = performance.now();
    if (state.exhaustedUntil > 0 && now < state.exhaustedUntil) return "exhausted";
    if (state.cooldownUntil > 0 && now < state.cooldownUntil) return "cooldown";
    if (state.consecutiveFailures >= state.config.maxConsecutiveFailures) {
      return "cooldown";
    }
    return "available";
  }

  /** Get all available (non-cooldown) models, fast ones first. */
  getAvailableModels(): ModelConfig[] {
    const available: ModelConfig[] = [];
    for (const [, state] of this.models) {
      if (this.getStatus(state.config.name) === "available") {
        available.push(state.config);
      }
    }
    // Preserve original priority order, then bubble slow models to the back
    available.sort((a, b) => {
      const aSlow = this.isSlow(a.name);
      const bSlow = this.isSlow(b.name);
      if (aSlow !== bSlow) return aSlow ? 1 : -1;
      return CHAT_MODELS.indexOf(a) - CHAT_MODELS.indexOf(b);
    });
    return available;
  }

  /** Whether the model is currently demoted for being slow. */
  isSlow(modelName: string): boolean {
    const state = this.models.get(modelName);
    if (!state) return false;
    if (state.slowUntil > 0 && performance.now() < state.slowUntil) return true;
    state.slowUntil = 0;
    return false;
  }

  /** Mark the start of an attempt so latency can be measured. */
  markAttemptStart(modelName: string): void {
    const state = this.models.get(modelName);
    if (!state) return;
    state.currentAttemptStart = performance.now();
  }

  /** Report the measured latency of a successful call. */
  reportLatency(modelName: string, elapsedMs: number): void {
    const state = this.models.get(modelName);
    if (!state) return;
    state.lastLatencyMs = elapsedMs;
    if (elapsedMs > ROUTER_SETTINGS.slowModelMs) {
      state.slowUntil = performance.now() + ROUTER_SETTINGS.slowPenaltyMs;
      console.log(
        `[RetryManager] ${state.config.label} is slow (${Math.round(elapsedMs / 1000)}s) — ` +
          `demoted for ${Math.round(ROUTER_SETTINGS.slowPenaltyMs / 1000)}s`,
      );
    }
  }

  /**
   * Compute backoff delay for the current attempt.
   * Implements exponential backoff: base * multiplier ^ attempt, capped at max.
   */
  getBackoffDelay(modelName: string): number {
    const state = this.models.get(modelName);
    if (!state) return ROUTER_SETTINGS.baseBackoffMs;
    const attempt = state.consecutiveFailures;
    const delay = Math.min(
      ROUTER_SETTINGS.baseBackoffMs * Math.pow(ROUTER_SETTINGS.backoffMultiplier, attempt),
      ROUTER_SETTINGS.maxBackoffMs,
    );
    // Add jitter (±25%) to avoid thundering herd
    const jitter = delay * (0.75 + Math.random() * 0.5);
    return Math.round(jitter);
  }

  /** Report a successful call — resets failure count, cooldown, and slowness. */
  reportSuccess(modelName: string): void {
    const state = this.models.get(modelName);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.cooldownCycle = 0;
    state.cooldownUntil = 0;
    state.exhaustedUntil = 0;
    state.slowUntil = 0;
  }

  /** Report a failure — increments counter and may trigger cooldown. */
  reportFailure(modelName: string): void {
    const state = this.models.get(modelName);
    if (!state) return;

    state.consecutiveFailures++;

    if (state.consecutiveFailures >= state.config.maxConsecutiveFailures) {
      const cooldownMs = Math.min(
        state.config.baseCooldownMs * Math.pow(2, state.cooldownCycle),
        300_000, // cap at 5 minutes
      );
      state.cooldownUntil = performance.now() + cooldownMs;
      state.cooldownCycle++;
      state.consecutiveFailures = 0; // reset counter for next cooldown cycle

      const remaining = Math.round(cooldownMs / 1000);
      console.log(
        `[RetryManager] ${state.config.label} cooldown for ${remaining}s ` +
          `(cycle ${state.cooldownCycle})`,
      );
    }
  }

  /** Mark a model as exhausted — removed from rotation until EXHAUSTED_MS passes. */
  markExhausted(modelName: string): void {
    const state = this.models.get(modelName);
    if (!state) return;
    state.exhaustedUntil = performance.now() + EXHAUSTED_MS;
    state.consecutiveFailures = state.config.maxConsecutiveFailures;
    console.log(
      `[RetryManager] ${state.config.label} exhausted — out of rotation for ` +
        `${Math.round(EXHAUSTED_MS / 60000)}min`,
    );
  }

  /**
   * Clear exhaustion flags so the next message gets a fresh try.
   * Called when every model is unavailable, letting a session self-heal
   * as soon as the provider is reachable again.
   */
  recoverExhausted(): void {
    for (const [, state] of this.models) {
      if (state.exhaustedUntil > 0) {
        state.exhaustedUntil = 0;
        console.log(`[RetryManager] ${state.config.label} exhaustion cleared — will retry.`);
      }
    }
  }

  /** Whether any models are available for use. */
  get hasAvailable(): boolean {
    return this.getAvailableModels().length > 0;
  }

  /**
   * Milliseconds until the soonest non-exhausted model finishes its cooldown.
   * Returns 0 when a model is already available or every model is exhausted.
   */
  getEarliestCooldownMs(): number {
    const now = performance.now();
    let earliest = Infinity;
    for (const [, state] of this.models) {
      if (state.exhaustedUntil > 0 && now < state.exhaustedUntil) continue;
      if (state.cooldownUntil > 0 && now < state.cooldownUntil) {
        earliest = Math.min(earliest, state.cooldownUntil - now);
      }
    }
    return Number.isFinite(earliest) ? Math.max(0, earliest) : 0;
  }

  /** Get human-readable summary of all model states. */
  getSummary(): Record<
    string,
    { status: ModelStatus; failures: number; cooldownCycle: number; latencyMs: number }
  > {
    const summary: Record<
      string,
      { status: ModelStatus; failures: number; cooldownCycle: number; latencyMs: number }
    > = {};
    for (const [name, state] of this.models) {
      summary[name] = {
        status: this.getStatus(name),
        failures: state.consecutiveFailures,
        cooldownCycle: state.cooldownCycle,
        latencyMs: state.lastLatencyMs,
      };
    }
    return summary;
  }

  /** Reset all state (e.g. after a long idle period). */
  reset(): void {
    for (const [, state] of this.models) {
      state.consecutiveFailures = 0;
      state.cooldownCycle = 0;
      state.cooldownUntil = 0;
      state.exhaustedUntil = 0;
      state.slowUntil = 0;
      state.lastLatencyMs = 0;
    }
  }
}
