/**
 * DynamicResolutionScaler — continuous render-resolution adaptation.
 *
 * Scope, deliberately narrow: this owns the render scale and nothing else.
 * Quality tiers keep owning shadows, AA, tone mapping and the animation /
 * physics budgets, so lowering resolution can never move a tier and no
 * visible feature jumps because of scaling.
 *
 * Control law
 * -----------
 *   ema = ema * (1 - α) + frameMs * α              (α = 0.05, ~20 frame memory)
 *
 *   ema > downMs  →  scale -= stepDown             (0.02 — reacts fast)
 *   ema < upMs    →  scale += stepUp               (0.01 — recovers slowly)
 *   in between    →  hold                          (dead band)
 *
 * Four properties fall out of that shape:
 *   • decrease faster than increase  → stepDown > stepUp
 *   • no oscillation                 → dead band between upMs and downMs,
 *                                      plus a cooldown so at most one step
 *                                      lands per window
 *   • bounded                        → clamped to [min, ceiling]
 *   • smooth                         → EMA rejects single-frame spikes
 *
 * The scaler never allocates and holds no references to the renderer, so it
 * is trivially testable without a WebGL context.
 *
 * A note on vsync-locked displays: a 60 Hz screen can never report more than
 * ~16.7 ms per frame, which lands inside the dead band. The scaler therefore
 * settles at the resolution that sustains the budget and *holds* there — it
 * does not climb back speculatively, because a periodic probe-and-pump is
 * precisely the oscillation this design avoids. Recovery happens when a real
 * headroom signal exists (a 120 Hz display, or frames genuinely under 13 ms).
 */

export interface DynamicResolutionConfig {
  /** Absolute floor — below this the image stops being worth looking at. */
  min: number;
  /** Ceiling = the active quality tier's `renderScale`. */
  base: number;
  /** Scale removed per down-step. */
  stepDown: number;
  /** Scale added per up-step. */
  stepUp: number;
  /** EMA smoothing factor for the frame-time sample. */
  emaAlpha: number;
  /** Sustained frame time above this (ms) means "too slow" → shrink. */
  downMs: number;
  /** Sustained frame time below this (ms) means "headroom" → grow. */
  upMs: number;
  /** Minimum wall-clock gap between two scale changes. */
  cooldownMs: number;
  /** Initial EMA assumption before the first real frame arrives. */
  initialEmaMs: number;
}

export const DEFAULT_DRS_CONFIG: DynamicResolutionConfig = {
  min: 0.5,
  base: 1,
  // 0.03 down / 0.015 up = a 2:1 descent ratio. At the 400 ms cooldown that
  // is ~6.8 s to fall 1.0 → 0.5 and ~13.6 s to climb back, so a real
  // slowdown is answered quickly while recovery stays gradual.
  stepDown: 0.03,
  stepUp: 0.015,
  emaAlpha: 0.05,
  // 20 ms ≈ below 50 fps → shrink; 13 ms ≈ above 77 fps → grow. The 7 ms gap
  // is the dead band that stops a machine sitting on the boundary from
  // hunting. A steady 60 Hz (16.7 ms) sits inside it and is left alone.
  downMs: 20,
  upMs: 13,
  cooldownMs: 400,
  initialEmaMs: 16.7,
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export class DynamicResolutionScaler {
  private ema: number;
  private current: number;
  private ceiling: number;
  private lastChangeAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly config: DynamicResolutionConfig = DEFAULT_DRS_CONFIG,
    initialScale: number = config.base,
  ) {
    this.ceiling = clamp(config.base, config.min, 1);
    this.current = clamp(initialScale, config.min, this.ceiling);
    this.ema = config.initialEmaMs;
  }

  /** Current render scale (this is what the renderer applies). */
  get scale(): number {
    return this.current;
  }

  /** Smoothed frame time in ms — exposed for diagnostics and tests. */
  get emaMs(): number {
    return this.ema;
  }

  /** Active ceiling, i.e. the tier's own render scale. */
  get maxScale(): number {
    return this.ceiling;
  }

  /**
   * Re-seat the ceiling when the quality tier changes.
   *
   * A downgrade may pull the current scale down immediately (the tier asked
   * for less resolution); an upgrade only raises the ceiling and lets the
   * controller earn its way back up through normal `sample()` calls. That
   * keeps the response monotonic and avoids a resolution pop on tier switch.
   *
   * @returns true when the applied scale actually moved.
   */
  setBase(base: number): boolean {
    const next = clamp(base, this.config.min, 1);
    if (next === this.ceiling) return false;
    this.ceiling = next;
    if (this.current > next) {
      this.current = next;
      return true;
    }
    return false;
  }

  /**
   * Feed one frame's duration.
   *
   * @param frameMs wall-clock milliseconds since the previous frame.
   * @param nowMs monotonic timestamp used for the cooldown.
   * @returns the new scale when it changed, otherwise `null`.
   */
  sample(frameMs: number, nowMs: number): number | null {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return null;

    const alpha = this.config.emaAlpha;
    this.ema = this.ema * (1 - alpha) + frameMs * alpha;

    if (nowMs - this.lastChangeAt < this.config.cooldownMs) return null;

    let next = this.current;
    if (this.ema > this.config.downMs) {
      next -= this.config.stepDown;
    } else if (this.ema < this.config.upMs) {
      next += this.config.stepUp;
    } else {
      return null; // dead band — hold exactly where we are
    }

    const clamped = clamp(next, this.config.min, this.ceiling);
    if (clamped === this.current) return null; // already pinned at a bound

    this.current = clamped;
    this.lastChangeAt = nowMs;
    return clamped;
  }
}
