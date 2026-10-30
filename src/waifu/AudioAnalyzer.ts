export interface AudioFeatures {
  overallEnergy: number;
  bassEnergy: number;
  midEnergy: number;
  trebleEnergy: number;
  spectralFlux: number;
  beatStrength: number;
  bpm: number;
  bpmConfidence: number;
  beatInterval: number;
  energyTrend: "rising" | "stable" | "falling";
  intensity: number;
}

export interface AudioAnalysisSnapshot {
  features: AudioFeatures | null;
  songVersion: number;
  /** Current track length in seconds (0 when unknown) — used for OUTRO detection. */
  songDuration?: number;
}

interface BeatInfo {
  timestamp: number;
  strength: number;
}

const ANALYSIS_FPS = 25;
const ANALYSIS_INTERVAL = 1000 / ANALYSIS_FPS;
const ENERGY_HISTORY_SIZE = 60;
const BEAT_HISTORY_SIZE = 30;
const MIN_BEAT_INTERVAL = 60000 / 220;
const MAX_BEAT_INTERVAL = 60000 / 50;

/**
 * Real-time audio feature extractor. Reuses an existing AnalyserNode so no
 * extra analysers are created for the same song. Runs at ~25 FPS internally —
 * the caller should call update() each frame; cheap throttling keeps it cheap.
 */
export class AudioAnalyzer {
  private analyser: AnalyserNode;
  private audioContext: AudioContext;
  private frequencyData: Uint8Array<ArrayBuffer>;
  private previousFrequencyData: Uint8Array<ArrayBuffer>;

  private energyHistory: number[] = [];
  private bassHistory: number[] = [];
  private beatHistory: BeatInfo[] = [];

  private lastAnalysisTime = 0;
  private lastBeatTime = 0;
  private beatCooldown = 0;

  private smoothedEnergy = 0;
  private smoothedBass = 0;
  private smoothedIntensity = 0;
  private cachedFeatures: AudioFeatures;

  private currentBpm = 120;
  private bpmConfidence = 0;

  private debug = false;

  constructor(analyser: AnalyserNode) {
    this.analyser = analyser;
    this.audioContext = analyser.context as AudioContext;
    this.frequencyData = new Uint8Array(analyser.frequencyBinCount);
    this.previousFrequencyData = new Uint8Array(analyser.frequencyBinCount);
    this.cachedFeatures = this.buildFeatures(0);
  }

  update(): AudioFeatures {
    const now = this.audioContext.currentTime * 1000;
    if (now - this.lastAnalysisTime < ANALYSIS_INTERVAL) {
      return this.cachedFeatures;
    }
    this.lastAnalysisTime = now;

    this.analyser.getByteFrequencyData(this.frequencyData);

    const len = this.frequencyData.length;
    const bassBins = Math.max(1, Math.floor(len * 0.12));
    const midBins = Math.max(1, Math.floor(len * 0.35));
    const trebleBins = Math.max(1, len - bassBins - midBins);

    let sum = 0;
    let bassSum = 0;
    let midSum = 0;
    let trebleSum = 0;

    for (let i = 0; i < len; i++) {
      const val = this.frequencyData[i] / 255;
      sum += val;
      if (i < bassBins) bassSum += val;
      else if (i < bassBins + midBins) midSum += val;
      else trebleSum += val;
    }

    const overallEnergy = sum / len;
    const bassEnergy = bassSum / bassBins;
    const midEnergy = midSum / midBins;
    const trebleEnergy = trebleSum / trebleBins;

    let spectralFlux = 0;
    for (let i = 0; i < len; i++) {
      const diff = this.frequencyData[i] - this.previousFrequencyData[i];
      if (diff > 0) spectralFlux += diff;
    }
    spectralFlux /= len * 255;
    this.previousFrequencyData.set(this.frequencyData);

    this.energyHistory.push(overallEnergy);
    if (this.energyHistory.length > ENERGY_HISTORY_SIZE) this.energyHistory.shift();

    this.bassHistory.push(bassEnergy);
    if (this.bassHistory.length > BEAT_HISTORY_SIZE) this.bassHistory.shift();

    const beatResult = this.detectBeat(bassEnergy, now);
    const beatStrength = beatResult.isBeat ? beatResult.strength : 0;

    if (beatResult.isBeat) {
      this.beatHistory.push({ timestamp: now, strength: beatResult.strength });
      if (this.beatHistory.length > BEAT_HISTORY_SIZE) this.beatHistory.shift();
      this.updateBpm(now);
    }

    this.smoothedEnergy = this.smoothedEnergy * 0.85 + overallEnergy * 0.15;
    this.smoothedBass = this.smoothedBass * 0.8 + bassEnergy * 0.2;
    this.smoothedIntensity = this.smoothedIntensity * 0.85 + overallEnergy * 0.15;

    const energyTrend = this.calculateEnergyTrend();
    const normalizedIntensity = this.normalizeEnergy(this.smoothedIntensity);
    const beatInterval =
      this.beatHistory.length >= 2
        ? this.beatHistory[this.beatHistory.length - 1].timestamp -
          this.beatHistory[this.beatHistory.length - 2].timestamp
        : 0;

    this.cachedFeatures = {
      overallEnergy,
      bassEnergy,
      midEnergy,
      trebleEnergy,
      spectralFlux,
      beatStrength,
      bpm: this.currentBpm,
      bpmConfidence: this.bpmConfidence,
      beatInterval,
      energyTrend,
      intensity: normalizedIntensity,
    };

    if (this.debug && Math.random() < 0.02) {
      console.log("[AudioAnalyzer]", {
        energy: overallEnergy.toFixed(3),
        bass: bassEnergy.toFixed(3),
        mid: midEnergy.toFixed(3),
        treble: trebleEnergy.toFixed(3),
        flux: spectralFlux.toFixed(4),
        beat: beatResult.isBeat,
        beatStrength: beatStrength.toFixed(3),
        bpm: this.currentBpm.toFixed(1),
        confidence: this.bpmConfidence.toFixed(2),
        trend: energyTrend,
        intensity: normalizedIntensity.toFixed(3),
      });
    }

    return this.cachedFeatures;
  }

  /**
   * Copies the most recent frequency snapshot into `target` — the exact buffer
   * the 25 Hz analysis already read, so visualizers cost ZERO extra
   * AnalyserNode/FFT reads. Returns false until the first pass has run.
   */
  getFrequencySnapshot(target: Uint8Array): boolean {
    if (this.lastAnalysisTime === 0) return false;
    const n = Math.min(target.length, this.frequencyData.length);
    target.set(this.frequencyData.subarray(0, n));
    return true;
  }

  private buildFeatures(intensity: number): AudioFeatures {
    return {
      overallEnergy: intensity,
      bassEnergy: 0,
      midEnergy: 0,
      trebleEnergy: 0,
      spectralFlux: 0,
      beatStrength: 0,
      bpm: this.currentBpm,
      bpmConfidence: this.bpmConfidence,
      beatInterval: 0,
      energyTrend: "stable",
      intensity,
    };
  }

  private detectBeat(bassEnergy: number, now: number): { isBeat: boolean; strength: number } {
    if (this.beatCooldown > 0) {
      this.beatCooldown--;
      return { isBeat: false, strength: 0 };
    }

    if (this.bassHistory.length < 8) {
      return { isBeat: false, strength: 0 };
    }

    const recentBass = this.bassHistory.slice(-8);
    const avgBass = recentBass.reduce((a, b) => a + b, 0) / recentBass.length;

    // Near-silence guard — don't fire beats during quiet intros / fades.
    if (avgBass < 0.035) {
      return { isBeat: false, strength: 0 };
    }

    const maxBass = Math.max(...recentBass);
    const minBass = Math.min(...recentBass);
    const bassRange = maxBass - minBass;

    // Threshold derived from the bass band itself. Note: overall energy is
    // deliberately NOT part of the gate — a single `overallEnergy * x` term
    // suppressed kicks on mid/treble-heavy tracks.
    const dynamicThreshold = avgBass + Math.max(0.02, bassRange * 0.5);
    const adaptiveThreshold = Math.max(0.15, dynamicThreshold);

    const bassIncrease = bassEnergy - avgBass;
    const relativeIncrease = bassEnergy / Math.max(0.001, avgBass);

    if (bassEnergy > adaptiveThreshold && bassIncrease > 0.012 && relativeIncrease > 1.15) {
      const timeSinceLastBeat = now - this.lastBeatTime;
      if (timeSinceLastBeat >= MIN_BEAT_INTERVAL) {
        const strength = Math.min(1, 0.45 + relativeIncrease * 0.35);
        this.lastBeatTime = now;
        this.beatCooldown = Math.max(1, Math.floor(MIN_BEAT_INTERVAL / ANALYSIS_INTERVAL));
        return { isBeat: true, strength };
      }
    }

    return { isBeat: false, strength: 0 };
  }

  /**
   * BPM estimation by clustering beat intervals. Half/double-time detections
   * (missed beats, ghost beats) are folded into the 50–200 BPM range, then the
   * densest histogram cluster wins. Confidence reflects cluster share and
   * within-cluster variance.
   */
  private updateBpm(now: number): void {
    if (this.beatHistory.length < 3) return;

    const candidates: number[] = [];
    for (let i = 1; i < this.beatHistory.length; i++) {
      const interval = this.beatHistory[i].timestamp - this.beatHistory[i - 1].timestamp;
      if (interval < MIN_BEAT_INTERVAL || interval > MAX_BEAT_INTERVAL * 2) continue;
      let bpm = 60000 / interval;
      // Fold half/double-time detections into 50..200 BPM
      while (bpm > 200) bpm /= 2;
      while (bpm < 50) bpm *= 2;
      candidates.push(bpm);
    }
    if (candidates.length < 2) return;

    // Histogram in 2-BPM bins over 50..200
    const BIN_SIZE = 2;
    const BINS = 76; // (200-50)/2
    const bins = new Array<number>(BINS).fill(0);
    for (const bpm of candidates) {
      const idx = Math.min(BINS - 1, Math.max(0, Math.floor((bpm - 50) / BIN_SIZE)));
      bins[idx]++;
    }

    let bestIdx = 0;
    for (let i = 1; i < BINS; i++) {
      if (bins[i] > bins[bestIdx]) bestIdx = i;
    }
    if (bins[bestIdx] < 2) return;

    const centerBpm = 50 + bestIdx * BIN_SIZE;
    const inCluster = candidates.filter((b) => Math.abs(b - centerBpm) <= 8);
    if (inCluster.length === 0) return;

    const clusterBpm = inCluster.reduce((a, b) => a + b, 0) / inCluster.length;
    const share = inCluster.length / candidates.length;

    const variance =
      inCluster.reduce((s, b) => s + Math.pow(b - clusterBpm, 2), 0) / inCluster.length;
    const cv = Math.sqrt(variance) / Math.max(1, clusterBpm);
    const stability = Math.max(0, 1 - cv / 0.18);

    const confidence = Math.max(0, Math.min(1, stability * 0.65 + share * 0.35));
    this.bpmConfidence = this.bpmConfidence * 0.6 + confidence * 0.4;

    const blend = 0.15 + 0.55 * this.bpmConfidence;
    if (this.bpmConfidence > 0.25) {
      this.currentBpm = this.currentBpm * (1 - blend) + clusterBpm * blend;
    }
  }

  private calculateEnergyTrend(): "rising" | "stable" | "falling" {
    if (this.energyHistory.length < 30) return "stable";
    const recent = this.energyHistory.slice(-24);
    const older = this.energyHistory.slice(-48, -24);
    if (older.length < 5) return "stable";

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    const diff = recentAvg - olderAvg;

    if (diff > 0.025) return "rising";
    if (diff < -0.025) return "falling";
    return "stable";
  }

  private normalizeEnergy(rawEnergy: number): number {
    if (this.energyHistory.length < 20) {
      return Math.min(1, rawEnergy * 2.5);
    }

    const sorted = [...this.energyHistory].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const range = p90 - p10;

    if (range < 0.01) return Math.min(1, rawEnergy * 2.5);

    let normalized = (rawEnergy - p10) / range;
    normalized = Math.max(0, Math.min(1, normalized));
    return normalized;
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  reset(): void {
    this.energyHistory = [];
    this.bassHistory = [];
    this.beatHistory = [];
    this.smoothedEnergy = 0;
    this.smoothedBass = 0;
    this.smoothedIntensity = 0;
    this.currentBpm = 120;
    this.bpmConfidence = 0;
    this.lastBeatTime = 0;
    this.beatCooldown = 0;
    this.cachedFeatures = this.buildFeatures(0);
  }

  dispose(): void {
    // Analyser node ownership stays with the audio player — do not disconnect it here.
  }
}
