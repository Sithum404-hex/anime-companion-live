import { AudioAnalyzer, type AudioFeatures } from "@/waifu/AudioAnalyzer";
import { StereoWidener } from "@/waifu/StereoWidener";
import { StudioReverb } from "@/waifu/StudioReverb";

export interface AudioEngineSettings {
  masterVolume: number;
  bassBoost: number;
  warmth: number;
  clarity: number;
  /** Haas-effect stereo image width, 0 (mono) to 1 (wide stage). */
  stereoWidth: number;
  /** Procedural plate-reverb ambience send, 0 (dry) to 1. */
  ambience: number;
}

export const DEFAULT_AUDIO_ENGINE_SETTINGS: AudioEngineSettings = {
  masterVolume: 1,
  bassBoost: 0.45,
  warmth: 0.35,
  clarity: 0.45,
  stereoWidth: 0.4,
  ambience: 0.16,
};

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

export class AudioPlayerManager {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyzer: AudioAnalyzer | null = null;
  private inputGain: GainNode | null = null;
  private outputGain: GainNode | null = null;
  private bassFilter: BiquadFilterNode | null = null;
  private warmthFilter: BiquadFilterNode | null = null;
  private clarityFilter: BiquadFilterNode | null = null;
  private airFilter: BiquadFilterNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  /** Studio chain: Haas widener + plate ambience, post-fader. */
  private widener: StereoWidener | null = null;
  private reverb: StudioReverb | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private playlist: File[] = [];
  private currentIndex = -1;
  private _playing = false;
  private _currentTrackName = "";
  private _intensity = 0;
  private _bass = 0;
  private _mid = 0;
  private _frequencyData = new Uint8Array(0);
  private _beat = false;
  private _beatHold = 0;
  private rafId: number | null = null;
  private ducked = false;
  private lastAdvanceAt = 0;
  private songVersion = 0;
  private lastAnalyzerTick = 0;
  private readonly ANALYZER_INTERVAL = 1000 / 25;
  private engineSettings: AudioEngineSettings = { ...DEFAULT_AUDIO_ENGINE_SETTINGS };

  onTrackChange?: (name: string) => void;
  onPlayStateChange?: (playing: boolean) => void;

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;

    const audio = new Audio();
    audio.preload = "auto";
    audio.loop = false;
    audio.addEventListener("ended", this.handleEnded);
    audio.addEventListener("error", this.handleError);
    this.audio = audio;
    return audio;
  }

  private ensureCtx(): AudioContext {
    if (this.ctx) return this.ctx;

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.65;
    this._frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyzer = new AudioAnalyzer(this.analyser);

    this.inputGain = this.ctx.createGain();
    this.inputGain.gain.value = 0.96;

    this.bassFilter = this.ctx.createBiquadFilter();
    this.bassFilter.type = "lowshelf";
    this.bassFilter.frequency.value = 90;

    this.warmthFilter = this.ctx.createBiquadFilter();
    this.warmthFilter.type = "peaking";
    this.warmthFilter.frequency.value = 260;
    this.warmthFilter.Q.value = 0.85;

    this.clarityFilter = this.ctx.createBiquadFilter();
    this.clarityFilter.type = "peaking";
    this.clarityFilter.frequency.value = 2800;
    this.clarityFilter.Q.value = 0.95;

    this.airFilter = this.ctx.createBiquadFilter();
    this.airFilter.type = "highshelf";
    this.airFilter.frequency.value = 8000;

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.012;
    this.compressor.release.value = 0.18;

    this.outputGain = this.ctx.createGain();

    const audio = this.ensureAudio();
    this.source = this.ctx.createMediaElementSource(audio);
    this.source.connect(this.inputGain);
    this.inputGain.connect(this.bassFilter);
    this.bassFilter.connect(this.warmthFilter);
    this.warmthFilter.connect(this.clarityFilter);
    this.clarityFilter.connect(this.airFilter);
    this.airFilter.connect(this.compressor);
    this.compressor.connect(this.analyser);
    this.analyser.connect(this.outputGain);

    // ── Studio chain (post-fader) ─────────────────────────
    // The analyser taps BEFORE the effects so dance analysis sees the true
    // mix. The widener carries the audible stage; ambience runs as a parallel
    // send off the same bus (classic console setup) so the tail stays clean.
    this.widener = new StereoWidener(this.ctx, this.outputGain, this.ctx.destination);
    this.reverb = new StudioReverb(this.ctx, this.outputGain, this.ctx.destination);

    this.applyEngineSettings(false);
    return this.ctx;
  }

  get playing(): boolean {
    return this._playing;
  }

  get currentTrackName(): string {
    return this._currentTrackName;
  }

  get intensity(): number {
    return this._intensity;
  }

  /** Low-frequency (bass) intensity, 0-1. Used for beat-reactive animation. */
  get bass(): number {
    return this._bass;
  }

  /** Mid-frequency intensity, 0-1. Used for body reactivity. */
  get mid(): number {
    return this._mid;
  }

  /** True when a strong beat is detected (bass spike). */
  get beat(): boolean {
    return this._beat;
  }

  get hasTracks(): boolean {
    return this.playlist.length > 0;
  }

  /** Rich audio features for the dance director. Null when nothing is playing. */
  getAudioFeatures(): AudioFeatures | null {
    if (!this._playing || !this.analyzer) return null;
    return this.analyzer.update();
  }

  /** Analyser bin count (fftSize/2) — lets visualizers size their buffers. */
  get spectrumBinCount(): number {
    return this.analyser?.frequencyBinCount ?? 512;
  }

  /**
   * Latest spectrum snapshot for UI visualizers. Copies the SAME frequency
   * data the AudioAnalyzer already read at ~25 Hz — no second AnalyserNode,
   * no extra FFT reads. Returns false when nothing is playing.
   */
  getSpectrum(target: Uint8Array): boolean {
    if (!this._playing || !this.analyzer) return false;
    return this.analyzer.getFrequencySnapshot(target);
  }

  /** Increments every time a new track is loaded or playback is stopped. */
  getSongVersion(): number {
    return this.songVersion;
  }

  /** Total length of the current track in seconds (0 when unknown). */
  get duration(): number {
    const d = this.audio?.duration;
    return typeof d === "number" && Number.isFinite(d) ? d : 0;
  }

  get settings(): AudioEngineSettings {
    return { ...this.engineSettings };
  }

  setEngineSettings(settings: Partial<AudioEngineSettings>): void {
    this.engineSettings = {
      masterVolume: clamp(settings.masterVolume ?? this.engineSettings.masterVolume, 0, 1.5),
      bassBoost: clamp(settings.bassBoost ?? this.engineSettings.bassBoost),
      warmth: clamp(settings.warmth ?? this.engineSettings.warmth),
      clarity: clamp(settings.clarity ?? this.engineSettings.clarity),
      stereoWidth: clamp(settings.stereoWidth ?? this.engineSettings.stereoWidth),
      ambience: clamp(settings.ambience ?? this.engineSettings.ambience),
    };
    this.applyEngineSettings(true);
  }

  loadFiles(files: File[]): void {
    const audioFiles = files.filter(
      (f) => f.type.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name),
    );
    if (audioFiles.length === 0) return;

    const wasPlaying = this._playing;
    this.playlist = audioFiles;
    this.currentIndex = 0;
    this.loadTrack(this.currentIndex, wasPlaying);
  }

  play(): void {
    if (this.playlist.length === 0) return;

    if (this.currentIndex < 0) {
      this.currentIndex = 0;
      this.loadTrack(0, false);
    }

    void this.startPlayback();
  }

  pause(): void {
    const audio = this.audio;
    if (!audio || !this._playing) return;

    audio.pause();
    this.setPlaying(false);
  }

  resume(): void {
    this.play();
  }

  skip(): void {
    if (this.playlist.length === 0) return;
    this.next();
  }

  duck(): void {
    if (this.ducked) return;
    this.ducked = true;
    this.applyEngineSettings(true);
  }

  unduck(): void {
    if (!this.ducked) return;
    this.ducked = false;
    this.applyEngineSettings(true);
  }

  stop(): void {
    this.stopInternal(true);
    this.setPlaying(false);
    this._currentTrackName = "";
    this.songVersion++;
    this.resetAnalysis();
    this.onTrackChange?.("");
  }

  private loadTrack(index: number, autoplay: boolean): void {
    if (index < 0 || index >= this.playlist.length) return;

    const audio = this.ensureAudio();
    this.ensureCtx();

    audio.pause();
    this.revokeObjectUrl();

    this.currentIndex = index;
    this.songVersion++;
    this.resetAnalysis();
    const file = this.playlist[index];
    this._currentTrackName = file.name.replace(/\.[^.]+$/, "");
    this.onTrackChange?.(this._currentTrackName);

    this.objectUrl = URL.createObjectURL(file);
    audio.src = this.objectUrl;
    audio.currentTime = 0;
    audio.load();

    this.startAnalyzerLoop();

    if (autoplay) {
      void this.startPlayback();
    }
  }

  private async startPlayback(): Promise<void> {
    const audio = this.audio;
    if (!audio) return;
    if (this._playing && !audio.paused) return;

    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }

    try {
      await audio.play();
      this.setPlaying(true);
      this.startAnalyzerLoop();
    } catch (error) {
      console.warn("[AudioPlayer] Playback failed:", error);
      this.setPlaying(false);
    }
  }

  private next(): void {
    if (this.playlist.length === 0) return;

    // Suppress double-advance races: the 'ended' event and the analyzer loop can
    // both fire for the same ended track, which skips a track and interrupts an
    // in-flight play() — dropping the playing state (and stopping the dance).
    const now = Date.now();
    if (now - this.lastAdvanceAt < 300) return;
    this.lastAdvanceAt = now;

    const keepPlaying = this._playing;
    const nextIndex = (this.currentIndex + 1) % this.playlist.length;
    this.loadTrack(nextIndex, keepPlaying);
  }

  private handleEnded = () => {
    this.next();
  };

  private handleError = () => {
    console.warn("[AudioPlayer] Track failed, skipping to the next file");
    this.next();
  };

  private setPlaying(playing: boolean): void {
    if (this._playing === playing) return;
    this._playing = playing;
    this.onPlayStateChange?.(playing);
  }

  private applyEngineSettings(smooth: boolean): void {
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const setValue = (param: AudioParam, value: number, timeConstant = 0.08) => {
      if (smooth) {
        param.setTargetAtTime(value, now, timeConstant);
      } else {
        param.value = value;
      }
    };

    if (this.bassFilter) {
      setValue(this.bassFilter.gain, this.engineSettings.bassBoost * 8);
    }
    if (this.warmthFilter) {
      setValue(this.warmthFilter.gain, this.engineSettings.warmth * 4 - 0.5);
    }
    if (this.clarityFilter) {
      setValue(this.clarityFilter.gain, this.engineSettings.clarity * 5 - 0.5);
    }
    if (this.airFilter) {
      setValue(this.airFilter.gain, this.engineSettings.clarity * 2.5);
    }
    if (this.outputGain) {
      const duckScale = this.ducked ? 0.16 : 1;
      setValue(this.outputGain.gain, this.engineSettings.masterVolume * duckScale, 0.12);
    }

    // Studio chain follows the same smoothed parameter ramp.
    this.widener?.setWiden(this.engineSettings.stereoWidth);
    // Ducking pulls the ambience down harder than the dry signal — speech
    // stays intimate while she talks over the music.
    const ambience = this.engineSettings.ambience * (this.ducked ? 0.4 : 1);
    this.reverb?.setMix(ambience);
  }

  private stopInternal(clearSource: boolean): void {
    this.stopAnalyzerLoop();

    if (this.audio) {
      this.audio.pause();
      if (clearSource) {
        this.audio.removeAttribute("src");
        this.audio.load();
      }
    }

    if (clearSource) {
      this.revokeObjectUrl();
    }
  }

  private startAnalyzerLoop(): void {
    if (this.rafId !== null) return;

    const tick = (ts: number) => {
      if (!this.analyser) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      if (!this._playing) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      if (this.audio?.ended) {
        this.next();
        this.rafId = requestAnimationFrame(tick);
        return;
      }

      // Rich audio analysis throttled to ~25 FPS; the rest is cheap.
      if (ts - this.lastAnalyzerTick >= this.ANALYZER_INTERVAL && this.analyzer) {
        this.lastAnalyzerTick = ts;
        const f = this.analyzer.update();
        this._bass = f.bassEnergy;
        this._mid = f.midEnergy;
        this._intensity = f.intensity;
        this._beat = f.beatStrength > 0.5;
        this._beatHold = this._beat ? 5 : this._beatHold;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private stopAnalyzerLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resetAnalysis();
  }

  private resetAnalysis(): void {
    this._intensity = 0;
    this._bass = 0;
    this._mid = 0;
    this._beat = false;
    this._beatHold = 0;
    this.lastAnalyzerTick = 0;
    this.analyzer?.reset();
  }

  private revokeObjectUrl(): void {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  dispose(): void {
    this.stopInternal(true);
    this.setPlaying(false);
    this.playlist = [];
    this.currentIndex = -1;

    if (this.audio) {
      this.audio.removeEventListener("ended", this.handleEnded);
      this.audio.removeEventListener("error", this.handleError);
      this.audio = null;
    }

    this.source?.disconnect();
    this.inputGain?.disconnect();
    this.bassFilter?.disconnect();
    this.warmthFilter?.disconnect();
    this.clarityFilter?.disconnect();
    this.airFilter?.disconnect();
    this.compressor?.disconnect();
    this.analyser?.disconnect();
    this.outputGain?.disconnect();
    this.widener?.disconnect();
    this.widener = null;
    this.reverb?.disconnect();
    this.reverb = null;

    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }

    this.source = null;
    this.inputGain = null;
    this.bassFilter = null;
    this.warmthFilter = null;
    this.clarityFilter = null;
    this.airFilter = null;
    this.compressor = null;
    this.analyser = null;
    this.analyzer = null;
    this.outputGain = null;
  }
}
