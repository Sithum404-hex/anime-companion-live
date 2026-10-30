/**
 * Rough song-structure estimator on top of the live audio features.
 *
 * Real-time beat/downbeat detection gives confidence, but no waveform source
 * can reliably segment a song's arrangement. Instead we watch the rolling
 * energy curve and classify segments with hysteresis:
 *
 *   INTRO  – before the rhythm establishes (phase handled by the director)
 *   VERSE  – steady low/medium energy
 *   BUILD  – energy rising toward the peak
 *   CHORUS – sustained high energy
 *   BREAK  – the peak collapses (bridge / drop-out)
 *   OUTRO  – last stretch of the song, winds down
 *
 * Everything is driven by sustained state (>=1500-2500ms of the same regime)
 * so transient spikes do not flicker the section label.
 */

export type SongSection = "INTRO" | "VERSE" | "BUILD" | "CHORUS" | "BREAK" | "OUTRO";

export interface SectionState {
  section: SongSection;
  /** Increments on every section change since the song started. */
  sectionIndex: number;
  /** True only on the frame a section change happened. */
  changed: boolean;
  /** Highest intensity observed since the song started. */
  peakEnergy: number;
}

const TIER_HIGH_MS = 2500;
const TIER_CALM_MS = 2000;
const RISE_BEGIN_MS = 1300;
const RISE_ESTABLISHED_MS = 1600;
const OUTRO_WINDOW_MS = 25_000;
const MIN_SONG_FOR_OUTRO_MS = 90_000;

function tierOf(intensity: number): number {
  if (intensity >= 0.8) return 4;
  if (intensity >= 0.6) return 3;
  if (intensity >= 0.4) return 2;
  if (intensity >= 0.2) return 1;
  return 0;
}

export class SectionTracker {
  private section: SongSection = "INTRO";
  private sectionIndex = 0;
  private changed = false;
  private peakEnergy = 0;
  private active = false;

  private highMs = 0;
  private calmMs = 0;
  private risingMs = 0;
  private introducedMs = 0;

  reset(): void {
    this.section = "INTRO";
    this.sectionIndex = 0;
    this.changed = false;
    this.peakEnergy = 0;
    this.active = false;
    this.highMs = 0;
    this.calmMs = 0;
    this.risingMs = 0;
    this.introducedMs = 0;
  }

  /** Current section label (debug/UI). */
  get sectionLabel(): SongSection {
    return this.section;
  }

  /**
   * @param intensity  0..1 rolling energy
   * @param trend      "rising" | "stable" | "falling"
   * @param elapsedMs  ms since the song started
   * @param phaseActive true once the director decides the rhythm is established
   * @param songDurationMs  total song length in ms (0 when unknown)
   * @param dtMs       simulation/frame delta
   */
  update(
    intensity: number,
    trend: "rising" | "stable" | "falling",
    elapsedMs: number,
    phaseActive: boolean,
    songDurationMs: number,
    dtMs: number,
  ): SectionState {
    this.changed = false;

    if (dtMs > 0 && intensity > this.peakEnergy) this.peakEnergy = intensity;
    if (this.active && phaseActive) this.introducedMs += dtMs;

    if (!phaseActive) {
      if (this.active) {
        this.section = "INTRO";
        this.sectionIndex++;
        this.changed = true;
        this.active = false;
      }
      return this.state();
    }
    if (!this.active) {
      this.active = true;
      this.introducedMs = dtMs;
      this.section = "INTRO";
      this.sectionIndex++;
      this.changed = true;
      // The INTRO → VERSE hop happens on the next frame so a single tick can
      // never emit two section transitions (no sub-frame flicker).
      return this.state();
    }

    const tier = tierOf(intensity);

    // Sustained energy regime timers
    this.highMs = tier >= 3 ? this.highMs + dtMs : 0;
    this.calmMs = tier <= 1 ? this.calmMs + dtMs : 0;
    this.risingMs = trend === "rising" ? this.risingMs + dtMs : 0;

    // OUTRO — last stretch of a long track winds down
    if (songDurationMs >= MIN_SONG_FOR_OUTRO_MS && elapsedMs >= songDurationMs - OUTRO_WINDOW_MS) {
      this.setSection("OUTRO");
      return this.state();
    }

    let next: SongSection = this.section;
    switch (this.section) {
      case "INTRO":
        next = "VERSE";
        break;
      case "VERSE":
        if (this.highMs >= TIER_HIGH_MS) next = "CHORUS";
        else if (this.risingMs >= RISE_ESTABLISHED_MS && tier >= 2) next = "BUILD";
        else if (this.calmMs >= TIER_CALM_MS) next = "VERSE";
        break;
      case "BUILD":
        if (this.highMs >= TIER_HIGH_MS) next = "CHORUS";
        else if (this.calmMs >= TIER_CALM_MS) next = "VERSE";
        break;
      case "CHORUS":
        if (this.calmMs >= TIER_CALM_MS) next = "BREAK";
        break;
      case "BREAK":
        if (this.risingMs >= RISE_BEGIN_MS && tier >= 2) next = "BUILD";
        else if (this.calmMs >= TIER_CALM_MS) next = "VERSE";
        break;
      case "OUTRO":
        break;
    }
    this.setSection(next);
    return this.state();
  }

  private setSection(next: SongSection): void {
    if (next === this.section) return;
    this.section = next;
    this.sectionIndex++;
    this.changed = true;
    this.highMs = 0;
    this.calmMs = 0;
    this.risingMs = 0;
  }

  private state(): SectionState {
    return {
      section: this.section,
      sectionIndex: this.sectionIndex,
      changed: this.changed,
      peakEnergy: this.peakEnergy,
    };
  }
}
