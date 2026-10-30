import { AudioFeatures } from "./AudioAnalyzer";
import { DanceMetadata } from "./danceMetadata";
import { DanceDatabase } from "./DanceDatabase";

export interface ScoredDance {
  metadata: DanceMetadata;
  score: number;
  energyScore: number;
  bpmScore: number;
  styleScore: number;
  rhythmScore: number;
  intensityScore: number;
  transitionScore: number;
  repetitionPenalty: number;
  cooldownPenalty: number;
}

interface ScoringWeights {
  energy: number;
  bpm: number;
  style: number;
  rhythm: number;
  intensity: number;
  transition: number;
  repetition: number;
  cooldown: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  energy: 1.0,
  bpm: 0.7,
  style: 0.5,
  rhythm: 0.5,
  intensity: 0.4,
  transition: 0.3,
  repetition: 0.8,
  cooldown: 0.6,
};

const STYLE_BPM_MAP: Record<string, { min: number; max: number }> = {
  hiphop: { min: 70, max: 170 },
  breakdance: { min: 90, max: 180 },
  latin: { min: 70, max: 190 },
  other: { min: 60, max: 160 },
};

export class DanceScorer {
  private database: DanceDatabase;
  private weights: ScoringWeights;
  private debug = false;

  constructor(database: DanceDatabase, weights?: Partial<ScoringWeights>) {
    this.database = database;
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  scoreAll(
    features: AudioFeatures,
    currentDance: DanceMetadata | null,
    recentDances: DanceMetadata[],
    intensityPreference: "low" | "normal" | "high" | "auto" = "auto",
  ): ScoredDance[] {
    const candidates = this.database.getAll();
    const now = Date.now();

    const scored: ScoredDance[] = candidates.map((meta) => {
      const energyScore = this.calculateEnergyScore(meta, features.intensity);
      const bpmScore = this.calculateBpmScore(meta, features);
      const styleScore = this.calculateStyleScore(meta, features);
      const rhythmScore = this.calculateRhythmScore(meta, features);
      const intensityScore = this.calculateIntensityScore(meta, features, intensityPreference);
      const transitionScore = this.calculateTransitionScore(meta, currentDance);
      const repetitionPenalty = this.calculateRepetitionPenalty(meta, recentDances);
      const cooldownPenalty = this.calculateCooldownPenalty(meta, now);

      const score =
        energyScore * this.weights.energy +
        bpmScore * this.weights.bpm +
        styleScore * this.weights.style +
        rhythmScore * this.weights.rhythm +
        intensityScore * this.weights.intensity +
        transitionScore * this.weights.transition -
        repetitionPenalty * this.weights.repetition -
        cooldownPenalty * this.weights.cooldown;

      return {
        metadata: meta,
        score,
        energyScore,
        bpmScore,
        styleScore,
        rhythmScore,
        intensityScore,
        transitionScore,
        repetitionPenalty,
        cooldownPenalty,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    if (this.debug && Math.random() < 0.05) {
      console.log(
        "[DanceScorer] Top 5:",
        scored.slice(0, 5).map((s) => ({
          name: s.metadata.name,
          score: s.score.toFixed(3),
          energy: s.energyScore.toFixed(2),
          bpm: s.bpmScore.toFixed(2),
          style: s.styleScore.toFixed(2),
          rhythm: s.rhythmScore.toFixed(2),
          intensity: s.intensityScore.toFixed(2),
          transition: s.transitionScore.toFixed(2),
          repetition: s.repetitionPenalty.toFixed(2),
          cooldown: s.cooldownPenalty.toFixed(2),
        })),
      );
    }

    return scored;
  }

  private calculateEnergyScore(meta: DanceMetadata, intensity: number): number {
    if (intensity >= meta.energyMin && intensity <= meta.energyMax) {
      const range = meta.energyMax - meta.energyMin;
      const center = (meta.energyMin + meta.energyMax) / 2;
      const distFromCenter = Math.abs(intensity - center) / (range / 2);
      return 1 - distFromCenter * 0.5;
    }

    const belowMin = meta.energyMin - intensity;
    const aboveMax = intensity - meta.energyMax;
    const penalty = Math.max(belowMin, aboveMax, 0);
    return Math.max(0, 1 - penalty * 3);
  }

  private calculateBpmScore(meta: DanceMetadata, features: AudioFeatures): number {
    if (features.bpmConfidence < 0.3) {
      return 0.5;
    }

    const bpm = features.bpm;
    if (bpm >= meta.preferredBpmMin && bpm <= meta.preferredBpmMax) {
      const range = meta.preferredBpmMax - meta.preferredBpmMin;
      const center = (meta.preferredBpmMin + meta.preferredBpmMax) / 2;
      const distFromCenter = Math.abs(bpm - center) / (range / 2);
      return 1 - distFromCenter * 0.4;
    }

    const belowMin = meta.preferredBpmMin - bpm;
    const aboveMax = bpm - meta.preferredBpmMax;
    const penalty = Math.max(belowMin, aboveMax, 0) / 50;
    return Math.max(0, 1 - penalty);
  }

  private calculateStyleScore(meta: DanceMetadata, features: AudioFeatures): number {
    const styleRange = STYLE_BPM_MAP[meta.style] || { min: 60, max: 180 };
    const bpm = features.bpm;

    let styleAffinity = 0;
    if (bpm >= styleRange.min && bpm <= styleRange.max) {
      styleAffinity = 1;
    } else {
      const dist = Math.min(Math.abs(bpm - styleRange.min), Math.abs(bpm - styleRange.max));
      styleAffinity = Math.max(0, 1 - dist / 50);
    }

    const energyStyleMatch = this.getEnergyStyleMatch(meta.style, features.intensity);

    // Hip hop roars at mid/high tempos — once the song climbs past ~110 BPM
    // the street clips get an extra nudge so they hit harder than the rest.
    if (meta.style === "hiphop" && features.bpmConfidence >= 0.3 && features.bpm >= 110) {
      const ramp = Math.min(1, (features.bpm - 110) / 40);
      return Math.min(1, styleAffinity * 0.6 + energyStyleMatch * 0.4 + 0.12 * ramp);
    }

    return styleAffinity * 0.6 + energyStyleMatch * 0.4;
  }

  private getEnergyStyleMatch(style: string, intensity: number): number {
    switch (style) {
      case "breakdance":
        return intensity > 0.7 ? 1 : intensity > 0.5 ? 0.6 : 0.2;
      case "hiphop":
        return intensity > 0.65 ? 1 : intensity > 0.5 ? 0.85 : intensity > 0.3 ? 0.6 : 0.35;
      case "latin":
        return intensity > 0.25 && intensity <= 0.95 ? 1 : intensity > 0.15 ? 0.6 : 0.2;
      case "other":
        return intensity > 0.3 ? 0.7 : 0.4;
      default:
        return 0.5;
    }
  }

  private calculateRhythmScore(meta: DanceMetadata, features: AudioFeatures): number {
    if (features.beatStrength <= 0) return 0.3;

    const beatRegularity = features.bpmConfidence;
    const bassEnergy = features.bassEnergy;
    const spectralFlux = features.spectralFlux;

    let rhythmAffinity = 0;
    switch (meta.style) {
      case "breakdance":
        rhythmAffinity = beatRegularity * 0.5 + bassEnergy * 0.5;
        break;
      case "hiphop":
        rhythmAffinity = beatRegularity * 0.4 + bassEnergy * 0.4 + spectralFlux * 0.2;
        break;
      case "latin":
        rhythmAffinity = beatRegularity * 0.6 + features.midEnergy * 0.4;
        break;
      default:
        rhythmAffinity = beatRegularity * 0.5 + features.overallEnergy * 0.5;
    }

    return Math.min(1, rhythmAffinity * 1.5);
  }

  private calculateIntensityScore(
    meta: DanceMetadata,
    features: AudioFeatures,
    preference: "low" | "normal" | "high" | "auto",
  ): number {
    if (preference === "auto") {
      return meta.intensity;
    }

    const targetIntensity = preference === "low" ? 0.3 : preference === "high" ? 0.85 : 0.55;
    const diff = Math.abs(meta.intensity - targetIntensity);
    return 1 - diff;
  }

  private calculateTransitionScore(
    meta: DanceMetadata,
    currentDance: DanceMetadata | null,
  ): number {
    if (!currentDance) return 1;

    if (currentDance.style === meta.style) return 0.8;

    const styleCompatibility: Record<string, Record<string, number>> = {
      hiphop: { hiphop: 1, breakdance: 0.7, latin: 0.3, other: 0.5 },
      breakdance: { hiphop: 0.7, breakdance: 1, latin: 0.2, other: 0.4 },
      latin: { hiphop: 0.3, breakdance: 0.2, latin: 1, other: 0.5 },
      other: { hiphop: 0.5, breakdance: 0.4, latin: 0.5, other: 1 },
    };

    return styleCompatibility[currentDance.style]?.[meta.style] ?? 0.5;
  }

  private calculateRepetitionPenalty(meta: DanceMetadata, recentDances: DanceMetadata[]): number {
    let penalty = 0;
    for (let i = 0; i < recentDances.length; i++) {
      if (recentDances[i].name === meta.name) {
        penalty += 1 / (i + 1);
      }
    }
    return Math.min(1, penalty);
  }

  private calculateCooldownPenalty(meta: DanceMetadata, now: number): number {
    const timeSincePlayed = now - this.database.getTimeSinceLastPlayed(meta.name);
    if (timeSincePlayed < meta.cooldown * 1000) {
      return 1 - timeSincePlayed / (meta.cooldown * 1000);
    }
    return 0;
  }

  setWeights(weights: Partial<ScoringWeights>): void {
    this.weights = { ...this.weights, ...weights };
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }
}
