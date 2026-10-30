import type { AudioFeatures } from "./AudioAnalyzer";
import { DanceDatabase } from "./DanceDatabase";
import type { DanceMetadata } from "./danceMetadata";
import { DanceScorer, type ScoredDance } from "./DanceScorer";
import { SectionTracker, type SongSection } from "./songSection";
import { buildDancePlan, type DancePlan, type PlanEntry } from "./dancePlan";

export type DanceIntensityPref = "low" | "normal" | "high" | "auto";

export const DEBUG_DANCE_SYNC = false;

export interface DanceDirectorConfig {
  analysisThrottleMs: number;
  minDanceDuration: number;
  minTimeBetweenSwitches: number;
  minTimeBeforeUpgrade: number;
  minTimeBeforeDowngrade: number;
  maxTransitionWait: number;
  hardMaxDuration: number;
  bpmRecheckIntervalMs: number;
  bpmChangeThresholdBpm: number;
  bpmChangedWindowMs: number;
  tierHoldTime: number;
  phraseLengthBeats: number;
  beatRecentWindowMs: number;
  phraseBoundaryWindowMs: number;
  topK: number;
  introMinBeats: number;
  introMaxMs: number;
  manualOverrideMs: number;
  debug: boolean;
}

export const DEFAULT_DANCE_DIRECTOR_CONFIG: DanceDirectorConfig = {
  analysisThrottleMs: 1000 / 25,
  minDanceDuration: 5,
  minTimeBetweenSwitches: 3.5,
  minTimeBeforeUpgrade: 3.5,
  minTimeBeforeDowngrade: 4,
  maxTransitionWait: 6,
  hardMaxDuration: 18,
  bpmRecheckIntervalMs: 4000,
  bpmChangeThresholdBpm: 6,
  bpmChangedWindowMs: 6000,
  tierHoldTime: 0.9,
  phraseLengthBeats: 8,
  beatRecentWindowMs: 260,
  phraseBoundaryWindowMs: 700,
  topK: 6,
  introMinBeats: 4,
  introMaxMs: 4500,
  manualOverrideMs: 8000,
  debug: DEBUG_DANCE_SYNC,
};

/** Gentle dances suitable for quiet intros / low energy. */
const GENTLE_DANCES = [
  "Belly Dance",
  "Bellydancing slow",
  "Rumba Dancing",
  "Twist Dance",
  "Ymca Dance",
  "Macarena Dance",
  "Booty Hip Hop Dance",
];

function tierFromIntensity(intensity: number): number {
  if (intensity < 0.2) return 0;
  if (intensity < 0.4) return 1;
  if (intensity < 0.6) return 2;
  if (intensity < 0.8) return 3;
  return 4;
}

function defaultFeatures(): AudioFeatures {
  return {
    overallEnergy: 0,
    bassEnergy: 0,
    midEnergy: 0,
    trebleEnergy: 0,
    spectralFlux: 0,
    beatStrength: 0,
    bpm: 120,
    bpmConfidence: 0,
    beatInterval: 0,
    energyTrend: "stable",
    intensity: 0,
  };
}

/**
 * Read-only beat clock for the layers that react to the music (floor rings,
 * future visualizers). Refreshed in place by `DanceDirector.update()` — never
 * rebuilt — so a consumer can hold the object and poll it every frame.
 *
 * `at`/`nextAt` are `performance.now()` timestamps, the same clock the render
 * loop runs on. `nextAt` exists so an effect can start a little BEFORE the
 * beat (anticipation) when the tempo is measured well enough to trust;
 * `reliable` is that trust signal, and it is false until the analyser has
 * actually measured a tempo and a beat has landed.
 */
export interface BeatPulse {
  readonly at: number;
  readonly strength: number;
  readonly nextAt: number;
  readonly reliable: boolean;
}

/**
 * BPM confidence at which the predicted beat is trusted enough to anticipate
 * on. Matches the confidence the director already requires before it acts on a
 * measured tempo (see the BPM recheck), so no second "is the tempo real"
 * notion is invented here.
 */
const BEAT_PREDICT_MIN_CONFIDENCE = 0.3;

/**
 * How stale the last detected beat may be (in beat periods) before the beat
 * clock stops predicting. The analyser holds a beat for ~100 ms and the update
 * loop runs at ~25 Hz, so a couple of periods of slack absorbs jitter and a
 * single missed beat without letting a dead tempo keep predicting forever.
 */
const BEAT_PREDICT_MAX_AGE_BEATS = 2.5;

export interface DanceDebugInfo {
  bpm: number;
  bpmConfidence: number;
  energy: number;
  bass: number;
  mid: number;
  treble: number;
  beat: boolean;
  beatStrength: number;
  beatInterval: number;
  phase: string;
  tier: number;
  desiredTier: number;
  currentDance: string | null;
  currentStyle: string | null;
  nextDance: string | null;
  currentScore: number;
  nextScore: number;
  bpmAtDanceStart: number;
  bpmRecheckDueInMs: number;
  bpmChangedPending: boolean;
  timeUntilNextAllowedTransition: number;
  section: string;
  planRole: string | null;
  planIndex: number;
  planFamily: string | null;
}

/**
 * Music Dance Director — decides WHEN and WHICH dance to play based on
 * real-time audio analysis. Pure decision logic; the animation state
 * machine consumes its decisions.
 */
export class DanceDirector {
  private readonly database: DanceDatabase;
  private readonly scorer: DanceScorer;
  private config: DanceDirectorConfig;

  private intensityPref: DanceIntensityPref = "auto";
  private danceSyncEnabled = true;

  private latestFeatures: AudioFeatures | null = null;
  private songVersion = -1;
  private phase: "idle" | "intro" | "active" = "idle";
  private introStart = 0;
  private introBeats = 0;
  /**
   * Live beat clock (one reused object, filled in `update()`) — the read-only
   * view other layers consume via `beatPulse`.
   */
  private readonly pulse: { at: number; strength: number; nextAt: number; reliable: boolean } = {
    at: 0,
    strength: 0,
    nextAt: 0,
    reliable: false,
  };

  private currentDance: DanceMetadata | null = null;
  private recentDances: DanceMetadata[] = [];
  private danceStartTime = 0;
  private danceStartTier = 0;
  private lastSwitchAt = 0;
  private manualOverrideUntil = 0;

  private lastAnalysisAt = 0;
  private lastBeatAt = 0;
  private lastBeatStrength = 0;
  /**
   * Beat-clock state (visuals only — the dance decisions never read it).
   *
   * `beatOnsetAt` is when the beat flag ROSE; `wasBeat` is the previous frame's
   * flag, so the onset is a genuine once-per-beat edge. This matters because
   * `lastBeatAt` is refreshed on every frame the flag stays high (the analyser
   * holds it for ~100 ms), so a prediction built from it would land *inside*
   * the beat it predicts instead of before it — which is exactly what broke
   * the first version of the anticipation window.
   */
  private beatOnsetAt = 0;
  private wasBeat = false;
  private phraseBeatCount = 0;
  private phraseBoundaryUntil = 0;
  private nextBeatPredictedAt = 0;

  // Periodic BPM recheck — flags tempo drift so the dance changes to match.
  private bpmRecheckAt = 0;
  private bpmAtDanceStart = 0;
  private bpmChangedUntil = 0;
  // True after a song change until the analyzer measures the new tempo —
  // the first confident BPM of the session snapshots as the new anchor.
  private awaitingNewBpm = true;

  private tierCandidate = 0;
  private tierHoldStart = 0;
  private currentTier = 0;

  private nextSelection: ScoredDance | null = null;

  // Song-structure choreography: rough section tracker + per-song plan.
  private sectionTracker = new SectionTracker();
  private songDurationSec = 0;
  private songElapsedMs = 0;
  private lastTrackerAt = 0;
  private sectionChangeUntil = 0;
  private dancePlan: DancePlan | null = null;
  private planIndex = 0;
  private planBuilt = false;
  private planErrorMs = 0;

  constructor(config?: Partial<DanceDirectorConfig>) {
    this.config = { ...DEFAULT_DANCE_DIRECTOR_CONFIG, ...config };
    this.database = new DanceDatabase();
    this.scorer = new DanceScorer(this.database);
    if (this.config.debug) {
      this.database.setDebug(true);
      this.scorer.setDebug(true);
    }
  }

  // ── Public config ─────────────────────────────────────────

  setIntensityPreference(pref: DanceIntensityPref): void {
    this.intensityPref = pref;
  }

  setDanceSyncEnabled(enabled: boolean): void {
    this.danceSyncEnabled = enabled;
  }

  /**
   * Beat clock for visual/haptic layers — the beat timing they react to, all of
   * it measured or predicted HERE so nothing downstream re-detects beats.
   *
   * Poll it once per frame; it is the same object every time (no allocation)
   * and it is never written back to, so a consumer can never steer the tempo.
   */
  get beatPulse(): BeatPulse {
    return this.pulse;
  }

  setDebug(enabled: boolean): void {
    this.config = { ...this.config, debug: enabled };
    this.database.setDebug(enabled);
    this.scorer.setDebug(enabled);
  }

  /** True when the director is actively driving dance selection. */
  isActive(): boolean {
    return this.danceSyncEnabled;
  }

  /** User picked an animation manually — pause auto-switching briefly. */
  manualOverride(): void {
    this.manualOverrideUntil = performance.now() + this.config.manualOverrideMs;
    this.lastSwitchAt = performance.now();
  }

  // ── Session lifecycle ─────────────────────────────────────

  /**
   * Song changed. IMPORTANT: keep `currentDance`, `danceStartTime` and
   * `lastSwitchAt` — the currently-playing dance continues (the ASM drives it);
   * wiping them here made the director treat the first song frame as a brand
   * new dance with 0 start time, collapsing every transition decision into a
   * single upgrade. Only musical tracking state is reset. `danceStartTier`
   * resets to 0 so the new song's energy triggers a proper upgrade switch.
   */
  private resetSession(): void {
    this.phase = "idle";
    this.introStart = 0;
    this.introBeats = 0;
    this.recentDances = [];
    this.danceStartTier = 0;
    this.lastBeatAt = 0;
    this.lastBeatStrength = 0;
    this.phraseBeatCount = 0;
    this.beatOnsetAt = 0;
    this.wasBeat = false;
    this.phraseBoundaryUntil = 0;
    this.nextBeatPredictedAt = 0;
    // A new song invalidates the beat clock: nothing may anticipate on the
    // previous song's tempo.
    this.pulse.at = 0;
    this.pulse.strength = 0;
    this.pulse.nextAt = 0;
    this.pulse.reliable = false;
    this.bpmRecheckAt = 0;
    this.bpmAtDanceStart = 0;
    this.bpmChangedUntil = 0;
    this.tierCandidate = 0;
    this.tierHoldStart = 0;
    this.currentTier = 0;
    this.nextSelection = null;
    this.awaitingNewBpm = true;
    this.database.reset();
    this.sectionTracker.reset();
    this.songDurationSec = 0;
    this.songElapsedMs = 0;
    this.lastTrackerAt = 0;
    this.sectionChangeUntil = 0;
    this.dancePlan = null;
    this.planIndex = 0;
    this.planBuilt = false;
    this.planErrorMs = 0;
  }

  // ── Per-frame update (throttled internally) ───────────────

  update(
    features: AudioFeatures | null,
    songVersion: number,
    dt: number,
    songDurationSec = 0,
  ): void {
    const now = performance.now();

    if (songVersion !== this.songVersion) {
      this.songVersion = songVersion;
      this.resetSession();
      // The analyzer restarts at bpm=120/confidence 0 on a song change; the
      // current dance keeps playing until the new tempo is actually measured.
      // When the first confident BPM arrives, the dance gets re-anchored and
      // switched if it no longer fits (see the recheck branch below) — no
      // decisions are made on stale or default BPM readings.
    }
    this.songDurationSec = songDurationSec;

    if (!features) {
      this.latestFeatures = null;
      return;
    }

    this.latestFeatures = features;

    if (this.phase === "idle") {
      this.phase = "intro";
      this.introStart = now;
    }

    // Beat / phrase tracking
    const isBeat = features.beatStrength > 0.5;
    if (isBeat) {
      this.lastBeatAt = now;
      this.lastBeatStrength = features.beatStrength;
      this.phraseBeatCount++;
      if (this.phraseBeatCount >= this.config.phraseLengthBeats) {
        this.phraseBoundaryUntil = now + this.config.phraseBoundaryWindowMs;
        this.phraseBeatCount = 0;
      }
    }

    // Predict the next beat so transitions stay musical even when beat
    // detections are sparse (advances through missed beats using BPM).
    const bpm = features.bpm;
    if (bpm > 45 && bpm < 220 && this.lastBeatAt > 0) {
      const beatIntervalMs = 60000 / bpm;
      this.nextBeatPredictedAt = this.lastBeatAt + beatIntervalMs;
      while (this.nextBeatPredictedAt < now - 100) {
        this.nextBeatPredictedAt += beatIntervalMs;
      }
    }

    // ── Beat clock (output only — no dance decision reads it) ────────────
    // One stamp per beat, written when the flag RISES, so a consumer has a
    // clean edge to react to instead of a value that keeps moving for ~100 ms.
    if (isBeat && !this.wasBeat) {
      this.beatOnsetAt = now;
      this.pulse.at = now;
      this.pulse.strength = features.beatStrength;
    }
    this.wasBeat = isBeat;

    // Predict the next beat from the ONSET plus the measured period, advancing
    // through beats the analyser missed (same 100 ms grace the dance prediction
    // uses). Derived from the onset so an anticipation window opens BEFORE the
    // beat rather than inside it.
    let fresh = false;
    if (this.beatOnsetAt > 0 && bpm > 45 && bpm < 220) {
      const intervalMs = 60000 / bpm;
      let nextAt = this.beatOnsetAt + intervalMs;
      // Only chase missed beats while the anchor is still recent: past that the
      // tempo has effectively gone away (music ended, source switched) and
      // predicting on would fire effects for beats nobody is playing.
      fresh = now - this.beatOnsetAt <= intervalMs * BEAT_PREDICT_MAX_AGE_BEATS;
      while (fresh && nextAt < now - 100) nextAt += intervalMs;
      this.pulse.nextAt = fresh ? nextAt : 0;
    }

    this.pulse.reliable =
      fresh && this.pulse.nextAt > now && features.bpmConfidence >= BEAT_PREDICT_MIN_CONFIDENCE;

    // Intro → active once rhythm is established
    if (this.phase === "intro") {
      if (isBeat) this.introBeats++;
      if (
        this.introBeats >= this.config.introMinBeats ||
        now - this.introStart >= this.config.introMaxMs
      ) {
        this.phase = "active";
        // Commit to a real dance as soon as possible after the intro.
        this.lastSwitchAt = 0;
      }
    }

    // Song-structure tracking — rough section labels from the energy curve.
    // Sections move the choreography plan forward and open a short window in
    // which shouldTransition() will switch the dance at the next musical moment.
    const trackerDt = Math.min(Math.max(now - this.lastTrackerAt, 16), 250);
    if (this.lastTrackerAt > 0) this.songElapsedMs += trackerDt;
    this.lastTrackerAt = now;
    const sectionState = this.sectionTracker.update(
      features.intensity,
      features.energyTrend,
      this.songElapsedMs,
      this.phase === "active",
      this.songDurationSec * 1000,
      trackerDt,
    );
    if (sectionState.changed) {
      this.sectionChangeUntil = now + this.config.bpmChangedWindowMs;
      if (this.dancePlan) this.advancePlanTo(sectionState.section);
    }

    // Periodic BPM recheck — re-verify the tempo against the BPM the current
    // dance was chosen for. On a meaningful drift, open a window in which
    // shouldTransition() will switch the dance to match the new tempo.
    if (this.phase === "active" && features.bpmConfidence >= 0.3) {
      if (this.awaitingNewBpm) {
        // First confident BPM of the song — re-anchor the dance to it and, if
        // it no longer fits, open a drift window right away. Also builds the
        // choreography plan for the song once the profile is known.
        this.awaitingNewBpm = false;
        this.bpmAtDanceStart = features.bpm;
        if (this.currentDance) {
          const fits =
            features.bpm >= this.currentDance.preferredBpmMin &&
            features.bpm <= this.currentDance.preferredBpmMax;
          if (!fits) {
            this.bpmChangedUntil = now + this.config.bpmChangedWindowMs;
          }
        }
        if (!this.planBuilt) this.buildPlan(features);
      } else if (this.bpmRecheckAt === 0) {
        this.bpmRecheckAt = now + this.config.bpmRecheckIntervalMs;
      } else if (now >= this.bpmRecheckAt) {
        this.bpmRecheckAt = now + this.config.bpmRecheckIntervalMs;
        if (this.bpmAtDanceStart > 0) {
          const drift = Math.abs(features.bpm - this.bpmAtDanceStart);
          if (drift >= this.config.bpmChangeThresholdBpm) {
            this.bpmChangedUntil = now + this.config.bpmChangedWindowMs;
          }
        }
      }
    }

    // Energy tier with hysteresis — track how long intensity stays in a band
    const desiredTier = tierFromIntensity(features.intensity);
    if (desiredTier !== this.tierCandidate) {
      this.tierCandidate = desiredTier;
      this.tierHoldStart = now;
    } else if (now - this.tierHoldStart > this.config.tierHoldTime * 1000) {
      if (this.currentTier !== desiredTier) {
        this.currentTier = desiredTier;
      }
    }

    // Plan drift — if the live energy keeps diverging from the planned arc
    // for this section (8+ seconds of mismatch), the song did not match our
    // estimate; rebuild the choreography from the current profile.
    if (
      this.phase === "active" &&
      this.dancePlan &&
      this.planIndex < this.dancePlan.entries.length
    ) {
      const entry = this.dancePlan.entries[this.planIndex];
      const error = Math.abs(features.intensity - entry.targetEnergy);
      if (error > 0.4) {
        this.planErrorMs += trackerDt;
        if (this.planErrorMs >= 8000) this.buildPlan(features);
      } else {
        this.planErrorMs = 0;
      }
    }

    // Keep a cheap cached next-selection for preloading/debugging
    if (now - this.lastAnalysisAt >= this.config.analysisThrottleMs) {
      this.lastAnalysisAt = now;
      this.nextSelection = this.computeNextSelection(this.currentDance);
    }

    if (this.config.debug && now % 2000 < 40) {
      const info = this.getDebugInfo();
      console.log(
        `[DanceDirector] bpm=${info.bpm.toFixed(0)} conf=${info.bpmConfidence.toFixed(2)} ` +
          `energy=${info.energy.toFixed(2)} tier=${info.tier}→${info.desiredTier} ` +
          `phase=${info.phase} section=${info.section} plan=${info.planRole ?? "—"}` +
          `${info.planIndex >= 0 ? `#${info.planIndex}` : ""} ` +
          `beat=${info.beat} dance=${info.currentDance ?? "—"} ` +
          `next=${info.nextDance ?? "—"} bpmDrift=${info.bpmChangedPending ? "yes" : "no"}`,
      );
    }
  }

  // ── Transition timing ─────────────────────────────────────

  shouldTransition(): boolean {
    if (!this.isActive()) return false;
    const now = performance.now();
    if (now < this.manualOverrideUntil) return false;
    if (!this.latestFeatures) return false;
    if (this.phase !== "active") return false;

    const dancingTime = (now - this.danceStartTime) / 1000;
    const sinceLastSwitch = (now - this.lastSwitchAt) / 1000;

    const beatRecent = now - this.lastBeatAt < this.config.beatRecentWindowMs;
    const predictedBeatRecent =
      this.nextBeatPredictedAt > 0 &&
      now >= this.nextBeatPredictedAt - 30 &&
      now <= this.nextBeatPredictedAt + 200;
    const phraseRecent = now < this.phraseBoundaryUntil;
    const musicalMoment = beatRecent || predictedBeatRecent || phraseRecent;
    const waitedEnough = sinceLastSwitch >= this.config.maxTransitionWait;

    // BPM drift — the song's tempo moved away from this dance (or a new song
    // started with a different BPM). Tempo-matching is time-critical: switch
    // at the next beat/phrase without waiting out the full dance duration,
    // while still respecting the minimum gap between switches.
    const bpmDrift = now < this.bpmChangedUntil;
    if (bpmDrift) {
      if (sinceLastSwitch < this.config.minTimeBetweenSwitches) return false;
      if (dancingTime < this.config.minDanceDuration * 0.5) return false;
      if (musicalMoment || waitedEnough) return true;
      return false;
    }

    // Section change — the song moved into a new part (the chorus hit, the
    // build crested, the drop emptied out). Shift the dance at the next
    // musical moment without waiting out the full dance duration.
    const sectionChange = now < this.sectionChangeUntil;
    if (sectionChange) {
      if (sinceLastSwitch < this.config.minTimeBetweenSwitches) return false;
      if (dancingTime < this.config.minDanceDuration * 0.5) return false;
      if (musicalMoment || waitedEnough) return true;
      return false;
    }

    if (dancingTime < this.config.minDanceDuration) return false;
    if (sinceLastSwitch < this.config.minTimeBetweenSwitches) return false;

    const tierChanged = this.currentTier !== this.danceStartTier;

    // Upgrade / downgrade — switch at a musical moment
    if (tierChanged) {
      const tierUp = this.currentTier > this.danceStartTier;
      const minTime = tierUp
        ? this.config.minTimeBeforeUpgrade
        : this.config.minTimeBeforeDowngrade;
      if (dancingTime < minTime) return false;
      if (musicalMoment || waitedEnough) return true;
      return false;
    }

    // Stable tier — keep a flowing variety of dances, timed to the music.
    // Musical moments (real or predicted beats, phrase boundaries) fire the
    // switch; waitedEnough guarantees progress even on sparse detections.
    if (dancingTime >= this.config.minDanceDuration + 3) {
      if (musicalMoment || waitedEnough) return true;
    }

    // Hard cap so the character never gets stuck on one dance
    if (dancingTime >= this.config.hardMaxDuration) return true;

    return false;
  }

  /** Ms remaining until the character may switch dances (for debug UI). */
  timeUntilNextAllowedTransition(): number {
    if (!this.isActive()) return Infinity;
    const now = performance.now();
    const dancingMs = now - this.danceStartTime;
    const sinceSwitchMs = now - this.lastSwitchAt;
    const remaining = Math.max(
      this.config.minDanceDuration * 1000 - dancingMs,
      this.config.minTimeBetweenSwitches * 1000 - sinceSwitchMs,
      this.manualOverrideUntil - now,
      0,
    );
    return remaining;
  }

  // ── Dance selection ───────────────────────────────────────

  /** Commit a selection for the next dance. Called once when a dance actually starts. */
  selectNext(currentDance: DanceMetadata | null): DanceMetadata {
    this.nextSelection = this.computeNextSelection(currentDance);
    return this.nextSelection.metadata;
  }

  /** Non-committing peek used for preloading. */
  peekNext(currentDance: DanceMetadata | null): DanceMetadata | null {
    if (this.nextSelection && (currentDance?.name ?? "") !== this.nextSelection.metadata.name) {
      return this.nextSelection.metadata;
    }
    return this.computeNextSelection(currentDance).metadata;
  }

  private computeNextSelection(currentDance: DanceMetadata | null): ScoredDance {
    const features = this.latestFeatures ?? defaultFeatures();
    const scored = this.scorer.scoreAll(
      features,
      currentDance,
      this.recentDances,
      this.intensityPref,
    );

    // BPM-locked pool: the routine follows the SONG's tempo, not the last
    // dance's — only dances whose preferred range fits the detected BPM can
    // play. dancesForBpm guarantees at least 2 candidates at every tempo.
    let poolBase: ScoredDance[] = scored;
    if (features.bpmConfidence >= 0.3 && features.bpm > 0) {
      const byBpm = this.dancesForBpm(features.bpm);
      const byBpmSet = new Set(byBpm.map((d) => d.name));
      const locked = scored.filter((s) => byBpmSet.has(s.metadata.name));
      if (locked.length >= 2) poolBase = locked;
    }

    // Calm start: keep the first dance gentle until the rhythm is established
    let pool: ScoredDance[];
    if (this.phase === "intro" || this.phase === "idle") {
      const gentle = poolBase.filter((s) => GENTLE_DANCES.includes(s.metadata.name));
      pool = gentle.length > 0 ? gentle : poolBase;
    } else {
      pool = poolBase;
    }

    // Never immediately repeat the current dance unless nothing else fits
    const notCurrent = pool.filter((s) => s.metadata.name !== (currentDance?.name ?? ""));

    // Choreography plan — resolve the current section's entry to concrete
    // dances (family + tempo fit). Its family may legitimately repeat (one
    // style carried through a chorus); every other family must differ from
    // the current dance so consecutive switches never look like the same clip.
    const planEntry = this.currentPlanEntry();
    const planNames = planEntry ? this.planNamesFor(planEntry, poolBase) : null;
    const currentFamily = currentDance ? this.familyOf(currentDance.name) : null;
    const otherFamilies = notCurrent.filter(
      (s) =>
        (planNames !== null && planNames.has(s.metadata.name)) ||
        this.familyOf(s.metadata.name) !== currentFamily,
    );
    const familyPool = otherFamilies.length > 0 ? otherFamilies : notCurrent;

    // Fresh families (not danced recently) get a gentle score bump so the
    // rotation cycles through different styles instead of looping a clique.
    // Plan-family dances get a stronger pull toward the section's energy.
    const recentFamilies = new Set(this.recentDances.map((d) => this.familyOf(d.name)));
    const adjusted = familyPool.map((s) => {
      let score = s.score + (recentFamilies.has(this.familyOf(s.metadata.name)) ? 0 : 0.06);
      if (planNames !== null && planNames.has(s.metadata.name)) {
        score += 0.18;
        if (planEntry) {
          const fit = Math.abs(s.metadata.intensity - planEntry.targetEnergy);
          score += fit < 0.25 ? 0.05 : 0;
        }
      }
      return { ...s, score };
    });

    // One candidate per family, best-scorer first, so the top slots above are
    // spread across distinct dances. Mid/high tempos are hip hop's home turf —
    // there the big hip hop family gets a second slot so it can roar louder.
    const midHighBpm =
      this.latestFeatures !== null &&
      this.latestFeatures.bpmConfidence >= 0.3 &&
      this.latestFeatures.bpm >= 110;
    const seenFamilies = new Set<string>();
    const diverse: ScoredDance[] = [];
    for (const s of adjusted.sort((a, b) => b.score - a.score)) {
      const fam = this.familyOf(s.metadata.name);
      if (fam === "Hip Hop Dancing") {
        const slots = midHighBpm ? 2 : 1;
        const used = diverse.filter((d) => this.familyOf(d.metadata.name) === fam).length;
        if (used >= slots) continue;
      } else {
        if (seenFamilies.has(fam)) continue;
        seenFamilies.add(fam);
      }
      diverse.push(s);
    }

    const top = diverse.slice(0, this.config.topK);
    const selected = this.pickWeighted(top);
    return selected;
  }

  /** Strips "(N)" suffixes so clone clips count as one visible dance. */
  private familyOf(name: string): string {
    return name.replace(/\s*\(\d+\)\s*$/, "").trim();
  }

  // ── Choreography plan ─────────────────────────────────────

  private buildPlan(features: AudioFeatures): void {
    this.planBuilt = true;
    this.planIndex = 0;
    this.planErrorMs = 0;
    const seed = Math.floor(Date.now() % 100000) + this.songVersion * 97;
    this.dancePlan = buildDancePlan({
      bpm: features.bpm,
      confidence: features.bpmConfidence,
      energy: features.intensity,
      seed,
    });
  }

  /** The plan entry for the current section (null before the plan exists). */
  private currentPlanEntry(): PlanEntry | null {
    if (!this.dancePlan || this.dancePlan.entries.length === 0) return null;
    return this.dancePlan.entries[Math.min(this.planIndex, this.dancePlan.entries.length - 1)];
  }

  /** Concrete dance names for a plan entry — family-resolved, tempo-fit first. */
  private planNamesFor(entry: PlanEntry, poolBase: ScoredDance[]): Set<string> {
    const names = new Set<string>();
    const poolByUrl = poolBase.map((s) => s.metadata);

    const soft = new Set([...GENTLE_DANCES]);
    const addIfPresent = (candidates: DanceMetadata[]) => {
      for (const d of candidates) {
        if (names.size >= 4) break;
        names.add(d.name);
      }
    };

    if (entry.familyKey === "main" && this.dancePlan) {
      const main = poolByUrl.filter((d) => d.style === this.dancePlan!.mainStyle);
      addIfPresent(main);
    } else if (entry.familyKey === "soft") {
      const softPool = poolByUrl.filter((d) => soft.has(d.name) && d.intensity <= 0.7);
      addIfPresent(softPool);
    } else {
      const gentle = poolByUrl.filter((d) => soft.has(d.name) && d.intensity <= 0.55);
      addIfPresent(gentle);
    }

    // Fallback — fill with whatever fits the section's energy best, so a plan
    // entry always has candidates even when the style has no tempo-fit clip.
    const byEnergy = [...poolByUrl].sort(
      (a, b) =>
        Math.abs(a.intensity - entry.targetEnergy) - Math.abs(b.intensity - entry.targetEnergy),
    );
    addIfPresent(byEnergy);
    return names;
  }

  /** Section changed — move the plan forward (outro entry = wind down). */
  private advancePlanTo(section: SongSection): void {
    if (!this.dancePlan) return;
    const entries = this.dancePlan.entries;
    this.planErrorMs = 0;

    if (this.planIndex >= entries.length - 1) {
      // Plan exhausted but the song keeps going — rebuild a fresh arc.
      if (section !== "OUTRO" && this.latestFeatures) this.buildPlan(this.latestFeatures);
      return;
    }

    // Prefer the next matching entry, otherwise advance one step.
    const match = entries.findIndex((e, i) => i > this.planIndex && e.section === section);
    if (match >= 0) {
      this.planIndex = Math.min(match, entries.length - 1);
    } else {
      this.planIndex = Math.min(this.planIndex + 1, entries.length - 1);
    }
  }

  /**
   * Dances that fit a detected BPM — always at least 2:
   *   1. exact range match, then
   *   2. relaxed ±12 BPM neighbors, then
   *   3. the whole catalog (extreme tempos still get a rotating pool).
   */
  private dancesForBpm(bpm: number): DanceMetadata[] {
    const all = this.database.getAll();
    const primary = all.filter((d) => bpm >= d.preferredBpmMin && bpm <= d.preferredBpmMax);
    if (primary.length >= 2) return primary;
    const relaxed = all.filter(
      (d) => bpm + 12 >= d.preferredBpmMin && bpm - 12 <= d.preferredBpmMax,
    );
    return relaxed.length >= 2 ? relaxed : all;
  }

  private pickWeighted(candidates: ScoredDance[]): ScoredDance {
    if (candidates.length <= 1) return candidates[0] ?? { ...this.synthesizeFallback() };

    const minScore = Math.min(...candidates.map((c) => c.score));
    const maxScore = Math.max(...candidates.map((c) => c.score));
    const span = Math.max(0.001, maxScore - minScore);

    const weights = candidates.map((c) => 0.5 + 0.5 * ((c.score - minScore) / span));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  private synthesizeFallback(): ScoredDance {
    const metas = this.database.getAll();
    const meta = metas[0];
    return {
      metadata: meta,
      score: 0,
      energyScore: 0,
      bpmScore: 0,
      styleScore: 0,
      rhythmScore: 0,
      intensityScore: 0,
      transitionScore: 0,
      repetitionPenalty: 0,
      cooldownPenalty: 0,
    };
  }

  /** Called by the ASM when a dance action actually starts playing. */
  onDanceStarted(meta: DanceMetadata | null): void {
    this.currentDance = meta;
    if (meta) {
      this.database.recordPlay(meta.name);
      this.recentDances.unshift(meta);
      if (this.recentDances.length > 6) this.recentDances.pop();
    }
    this.danceStartTime = performance.now();
    this.danceStartTier = this.currentTier;
    this.lastSwitchAt = this.danceStartTime;
    // Anchor the BPM the dance was chosen for — recheck compares against this.
    this.bpmAtDanceStart = this.latestFeatures?.bpm ?? 0;
    this.bpmChangedUntil = 0;
  }

  // ── Lookups ───────────────────────────────────────────────

  getByUrl(url: string): DanceMetadata | undefined {
    return this.database.getByUrl(url);
  }

  get databaseInstance(): DanceDatabase {
    return this.database;
  }

  // ── Debug ─────────────────────────────────────────────────

  getDebugInfo(): DanceDebugInfo {
    const f = this.latestFeatures ?? defaultFeatures();
    const now = performance.now();
    return {
      bpm: f.bpm,
      bpmConfidence: f.bpmConfidence,
      energy: f.intensity,
      bass: f.bassEnergy,
      mid: f.midEnergy,
      treble: f.trebleEnergy,
      beat: now - this.lastBeatAt < this.config.beatRecentWindowMs,
      beatStrength: this.lastBeatStrength,
      beatInterval: f.beatInterval,
      phase: this.phase,
      tier: this.danceStartTier,
      desiredTier: this.currentTier,
      currentDance: this.currentDance?.name ?? null,
      currentStyle: this.currentDance?.style ?? null,
      nextDance: this.nextSelection?.metadata.name ?? null,
      currentScore: this.nextSelection?.score ?? 0,
      nextScore: this.nextSelection?.score ?? 0,
      bpmAtDanceStart: this.bpmAtDanceStart,
      bpmRecheckDueInMs:
        this.bpmRecheckAt > 0
          ? Math.max(0, this.bpmRecheckAt - now)
          : this.config.bpmRecheckIntervalMs,
      bpmChangedPending: now < this.bpmChangedUntil,
      timeUntilNextAllowedTransition: this.timeUntilNextAllowedTransition(),
      section: this.sectionTracker.sectionLabel,
      planRole: this.currentPlanEntry()?.role ?? null,
      planIndex: this.dancePlan ? this.planIndex : -1,
      planFamily: this.currentPlanEntry()?.familyKey ?? null,
    };
  }
}
