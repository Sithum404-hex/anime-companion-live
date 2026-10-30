/**
 * Haptics — mobile vibration feedback (output only).
 *
 * Design rules (see IMPROVEMENTS.md §1.6):
 *
 *   • Output only. Nothing here reads or writes animation, physics or dance
 *     state, and no caller may branch on a return value to change behaviour —
 *     a vibration can never change what she does.
 *   • Capability-checked. `navigator.vibrate` is missing on iOS Safari and in
 *     several embedded webviews; every path degrades to a no-op instead of
 *     throwing.
 *   • Rate-limited. A `vibrate()` call cancels the previous pattern, so a naive
 *     per-frame beat pulse degrades into a stuttery buzz. The beat path fires
 *     on the rising edge of the beat flag only and refuses anything closer than
 *     `BEAT_MIN_INTERVAL_MS`, which also keeps long dances from draining the
 *     battery with a permanent 60 Hz rumble.
 *   • Silent on failure. Browsers without sticky user activation, and hidden
 *     documents, reject the call (or log an intervention warning). Failures are
 *     swallowed, never surfaced to the user.
 */

/** Poke tick — the original, already-shipped pattern. */
const POKE_MS = 12;

/** Subtle beat pulse: soft for a quiet beat, still soft for a loud one. */
const BEAT_MIN_MS = 7;
const BEAT_RANGE_MS = 7;
/** Minimum gap between beat pulses (~4.5 pulses/second ceiling). */
const BEAT_MIN_INTERVAL_MS = 220;

/** True when this browser can actually vibrate. */
export function isHapticsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

function canVibrate(): boolean {
  if (!isHapticsSupported()) return false;
  // A hidden document rejects vibration; skipping avoids a console warning.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  return true;
}

function vibrate(pattern: number | number[]): boolean {
  if (!canVibrate()) return false;
  try {
    return navigator.vibrate(pattern) === true;
  } catch {
    // Some webviews expose `vibrate` but throw when called (no user
    // activation, permission policy). Feedback is never worth an error.
    return false;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Small stateful front-end over the Vibration API.
 *
 * One instance lives on the character controller: the setting decides whether
 * it may fire, the beat edge/debounce state lives here so no caller has to
 * track it, and every method is safe to call on an unsupported device.
 */
export class Haptics {
  private enabled = true;
  /** Rising-edge memory for the audio beat flag (which is true for several frames). */
  private beatActive = false;
  private lastBeatAt = Number.NEGATIVE_INFINITY;

  /** Master switch — drives the "Haptic feedback" setting. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    // Turning it off cancels anything already buzzing and forgets the current
    // beat, so re-enabling mid-beat cannot fire a stale pulse.
    this.reset();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Stop any in-flight vibration and drop beat state. */
  reset(): void {
    this.beatActive = false;
    this.lastBeatAt = Number.NEGATIVE_INFINITY;
    if (isHapticsSupported()) {
      try {
        navigator.vibrate(0);
      } catch {
        /* unsupported / not activated — nothing to stop */
      }
    }
  }

  /** Short tick confirming a touch landed on her. Returns whether it fired. */
  poke(): boolean {
    if (!this.enabled) return false;
    return vibrate(POKE_MS);
  }

  /**
   * Subtle pulse on a beat. Call once per frame with the current beat flag.
   *
   * @param beatActive current beat flag from the audio analyser.
   * @param intensity 0..1 music intensity — only nudges the pulse length.
   * @param now monotonic ms (injectable for tests).
   * @returns whether a pulse actually fired.
   */
  beat(beatActive: boolean, intensity = 0, now = performance.now()): boolean {
    if (!beatActive) {
      this.beatActive = false;
      return false;
    }
    if (this.beatActive) return false; // rising edge only
    this.beatActive = true;
    if (!this.enabled) return false;
    if (now - this.lastBeatAt < BEAT_MIN_INTERVAL_MS) return false;
    this.lastBeatAt = now;
    const ms = Math.round(BEAT_MIN_MS + clamp01(intensity) * BEAT_RANGE_MS);
    return vibrate(ms);
  }
}
