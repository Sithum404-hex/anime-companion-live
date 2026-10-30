/**
 * AdaptiveQualityGovernor — decides *when* the renderer may change quality tier.
 *
 * The renderer still owns the decision of *which* tier to use; this class owns
 * only the timing question, which is the part that used to go wrong. Without a
 * quiet period, a machine sitting on the threshold ping-pongs:
 *
 *     medium @ 24 fps  →  degrade to low  →  low @ 50 fps  →  upgrade to medium  →  …
 *
 * Each hop is visible (shadows switch off, the render-scale base moves), so the
 * bouncing is far more objectionable than the single tier the machine actually
 * needs. Two properties kill it:
 *
 *   • A **cooldown** after any tier change, in *both* directions. One-sided
 *     cooldowns just move the oscillation rather than removing it.
 *   • **Streaks are dropped while cooling down.** Evidence gathered before the
 *     new tier settled says nothing about the new tier, so the first decision
 *     after the window must be built from fresh frames only.
 *
 * Every threshold below is the renderer's pre-existing value; the only new
 * behaviour is the cooldown. The class is pure and DOM-free, so the
 * anti-oscillation logic is unit-testable without a WebGL context.
 */

import type { QualityTier } from "./performance";

/** Ladder order, weakest first. Index ±1 is one step. */
export const TIER_ORDER: readonly QualityTier[] = ["low", "medium", "high"];

export interface AdaptiveQualityConfig {
  /** Below this average FPS the machine is struggling. */
  minFps: number;
  /** Above this average FPS the machine has demonstrable headroom. */
  maxFps: number;
  /** Seconds of simulated time between two evaluations. */
  evalIntervalSec: number;
  /** Consecutive slow evaluations required before stepping down. */
  downgradeThreshold: number;
  /** Consecutive fast evaluations required before stepping up. */
  upgradeThreshold: number;
  /** Quiet window after *any* tier change, in either direction. */
  cooldownSec: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveQualityConfig = {
  minFps: 25,
  maxFps: 45,
  evalIntervalSec: 2,
  downgradeThreshold: 2,
  upgradeThreshold: 4,
  // 10 s is the figure the performance notes have always asked for. It is long
  // enough to outlast the worst streak (upgrade needs 4 × 2 s = 8 s), so the
  // governor can still act inside a post-change window rather than being
  // latched off until something else disturbs it.
  cooldownSec: 10,
};

export class AdaptiveQualityGovernor {
  private tier: QualityTier;
  private downgradeStreak = 0;
  private upgradeStreak = 0;
  private lastChangeAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly config: AdaptiveQualityConfig = DEFAULT_ADAPTIVE_CONFIG,
    initialTier: QualityTier = "medium",
  ) {
    this.tier = initialTier;
  }

  /** The tier the governor currently believes is active. */
  get currentTier(): QualityTier {
    return this.tier;
  }

  /**
   * Seconds between evaluations. The renderer owns the frame loop and reads
   * this so the cadence has a single source of truth next to the thresholds it
   * is paired with — drift between the two would silently change how many
   * frames back each decision actually rests on.
   */
  get evalIntervalSec(): number {
    return this.config.evalIntervalSec;
  }

  /**
   * Record a tier change that happened *outside* the governor — in practice a
   * user picking a tier in the settings panel.
   *
   * Starting the cooldown here is what stops the adaptive loop from immediately
   * undoing a deliberate choice: without it, picking "high" on a machine that
   * measures 30 fps gets reverted within a few seconds and the setting looks
   * broken.
   */
  notifyTierChanged(tier: QualityTier, nowMs: number): void {
    this.tier = tier;
    this.resetStreaks();
    this.lastChangeAt = nowMs;
  }

  /** Milliseconds left in the quiet window — 0 when changes are allowed. */
  cooldownRemainingMs(nowMs: number): number {
    return Math.max(0, this.config.cooldownSec * 1000 - (nowMs - this.lastChangeAt));
  }

  /**
   * Feed one evaluation.
   *
   * @returns the tier to switch to, or `null` to hold the current one.
   */
  evaluate(avgFps: number, nowMs: number): QualityTier | null {
    if (this.cooldownRemainingMs(nowMs) > 0) {
      this.resetStreaks();
      return null;
    }
    if (!Number.isFinite(avgFps)) {
      this.resetStreaks();
      return null;
    }

    if (avgFps < this.config.minFps) {
      this.downgradeStreak++;
      this.upgradeStreak = 0;
      if (this.downgradeStreak < this.config.downgradeThreshold) return null;
      return this.step(-1, nowMs);
    }

    if (avgFps > this.config.maxFps) {
      this.upgradeStreak++;
      this.downgradeStreak = 0;
      if (this.upgradeStreak < this.config.upgradeThreshold) return null;
      return this.step(1, nowMs);
    }

    // Dead band: neither struggling nor clearly headroom. Any partial streak is
    // stale by definition, so both ladders start over.
    this.resetStreaks();
    return null;
  }

  private step(direction: -1 | 1, nowMs: number): QualityTier | null {
    const idx = TIER_ORDER.indexOf(this.tier) + direction;
    const next = TIER_ORDER[idx] as QualityTier | undefined;
    // At a ladder edge there is nowhere to go: clear the streak so the edge is
    // not latched on, but report no change.
    this.resetStreaks();
    if (!next) return null;
    this.tier = next;
    this.lastChangeAt = nowMs;
    return next;
  }

  private resetStreaks(): void {
    this.downgradeStreak = 0;
    this.upgradeStreak = 0;
  }
}
