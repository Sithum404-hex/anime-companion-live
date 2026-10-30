import { synthesizeSpeech, type TtsOptions } from "@/systems/ttsSystem";

export interface SpeakOptions extends TtsOptions {
  volume?: number;
}

export type LipSyncSampler = () => number;

export interface AudioFrame {
  level: number;
  bands: number[];
}

/**
 * Lifecycle of a TTS playback session. "PAUSED" is reserved for future use —
 * a session never enters it today.
 */
export type TtsSessionState =
  | "IDLE"
  | "REQUESTING"
  | "READY"
  | "PLAYING"
  | "PAUSED"
  | "ENDED"
  | "ERROR"
  | "CANCELLED";

export interface TtsSessionInfo {
  /** Monotonic id of the active (latest) session; 0 = none yet. */
  id: number;
  state: TtsSessionState;
}

const BAND_RANGES = [
  [2, 8],
  [8, 16],
  [16, 26],
  [26, 40],
  [40, 60],
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Typecast latency can spike; cap how long a session waits before ERROR. */
const TTS_SYNTHESIS_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class VoiceEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private masterGain: GainNode | null = null;
  private dataArr: Uint8Array | null = null;
  private freqArr: Uint8Array | null = null;
  private speaking = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private fftSize = 512;

  // ── TTS session controller ────────────────────────────
  // One session per speak() call. Sessions are superseded via playbackToken:
  // any callback or play-step checks its token against the current one and
  // aborts if a newer session (or a cancel) took over. Typecast is the ONLY
  // voice source — there is no browser speech fallback.
  private playbackToken = 0;
  private activeSessionId = 0;
  private sessionState: TtsSessionState = "IDLE";

  onStart?: () => void;
  onEnd?: () => void;
  onSessionChange?: (info: TtsSessionInfo) => void;

  setFftSize(size: number) {
    this.fftSize = size;
    if (this.analyser) {
      try {
        this.analyser.fftSize = size;
        const len = size / 2;
        this.dataArr = new Uint8Array(len);
        this.freqArr = new Uint8Array(len);
      } catch {
        // Ignored
      }
    }
  }

  ensureCtx() {
    if (this.ctx) return this.ctx;

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();

    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.fftSize;
    analyser.smoothingTimeConstant = 0.6;

    const masterGain = ctx.createGain();
    analyser.connect(masterGain);
    masterGain.connect(ctx.destination);

    this.ctx = ctx;
    this.analyser = analyser;
    this.masterGain = masterGain;
    const len = analyser.frequencyBinCount;
    this.dataArr = new Uint8Array(len);
    this.freqArr = new Uint8Array(len);

    return ctx;
  }

  isSpeaking() {
    return this.speaking;
  }

  /** Current session id + state of the session controller. */
  getTtsSession(): TtsSessionInfo {
    return { id: this.activeSessionId, state: this.sessionState };
  }

  private setSession(id: number, state: TtsSessionState): void {
    this.sessionState = state;
    this.onSessionChange?.({ id, state });
  }

  getLipSyncSampler(): LipSyncSampler {
    return () => {
      if (!this.speaking || !this.analyser || !this.dataArr) return 0;

      this.analyser.getByteTimeDomainData(this.dataArr as unknown as Uint8Array<ArrayBuffer>);

      let sum = 0;
      const data = this.dataArr;
      for (let i = 0; i < data.length; i++) {
        const sample = (data[i] - 128) / 128;
        sum += sample * sample;
      }

      const rms = Math.sqrt(sum / data.length);
      return Math.max(0, Math.min(1, (rms - 0.01) * 8));
    };
  }

  getAudioFrame(): AudioFrame {
    if (!this.speaking || !this.analyser || !this.dataArr || !this.freqArr) {
      return { level: 0, bands: [0, 0, 0, 0, 0] };
    }

    this.analyser.getByteTimeDomainData(this.dataArr as unknown as Uint8Array<ArrayBuffer>);
    this.analyser.getByteFrequencyData(this.freqArr as unknown as Uint8Array<ArrayBuffer>);

    let sum = 0;
    const td = this.dataArr;
    for (let i = 0; i < td.length; i++) {
      const sample = (td[i] - 128) / 128;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / td.length);
    const level = Math.max(0, Math.min(1, (rms - 0.01) * 8));

    const freq = this.freqArr;
    const bands = BAND_RANGES.map(([lo, hi]) => {
      let e = 0;
      const count = Math.min(hi, freq.length - 1) - lo + 1;
      for (let j = lo; j <= hi && j < freq.length; j++) {
        e += freq[j];
      }
      return count > 0 ? e / (count * 255) : 0;
    });

    return { level, bands };
  }

  /** Pre-warm AudioContext so it's ready for playback.
   *  Call this early in a user-gesture handler (before any `await`)
   *  so the browser doesn't block audio. */
  warmup(): void {
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }

  /**
   * Speak text using the Typecast cloud voice exclusively. Synthesis runs
   * through the normal pipeline (proxy first, then the server function) and
   * there is NO browser-speech fallback — the browser must never replace her
   * real voice. If synthesis stalls or fails, the session enters ERROR and
   * the error propagates to the caller (chat itself is unaffected).
   */
  async speak(text: string, opts: SpeakOptions = {}) {
    const ctx = this.ensureCtx();

    // Stop any playback from a previous session (the state of the new
    // session below takes over immediately).
    this.stopSource();

    const token = ++this.playbackToken;
    this.activeSessionId = token;
    this.setSession(token, "REQUESTING");

    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      if (token !== this.playbackToken) return;

      const audioData = await withTimeout(
        synthesizeSpeech(text, opts),
        TTS_SYNTHESIS_TIMEOUT_MS,
        "Typecast TTS synthesis",
      );
      if (token !== this.playbackToken) return;

      if (!audioData || audioData.byteLength === 0) {
        this.speaking = false;
        this.setSession(token, "ERROR");
        this.onEnd?.();
        throw new Error("[VoiceEngine] TTS returned empty audio.");
      }

      this.setSession(token, "READY");

      const audioBuffer = await ctx.decodeAudioData(audioData.slice(0));
      if (token !== this.playbackToken) return;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.analyser!);

      if (this.masterGain) {
        this.masterGain.gain.value = clamp(opts.volume ?? 1, 0, 2);
      }

      this.currentSource = source;
      this.speaking = true;
      this.setSession(token, "PLAYING");
      this.onStart?.();

      console.log(
        `[VoiceEngine] Playing Typecast audio (session ${token}, ${audioData.byteLength} bytes).`,
      );

      await new Promise<void>((resolve) => {
        let finished = false;

        const finish = () => {
          if (finished) return;
          finished = true;

          if (this.currentSource === source) {
            this.currentSource = null;
          }

          if (token === this.playbackToken) {
            this.speaking = false;
            this.setSession(token, "ENDED");
            this.onEnd?.();
          }

          resolve();
        };

        source.onended = finish;
        source.start(0);
      });
    } catch (err) {
      // Superseded sessions log quietly, active ones surface as ERROR.
      if (token === this.playbackToken) {
        console.error("[VoiceEngine] TTS failed:", err);
        this.speaking = false;
        this.setSession(token, "ERROR");
        this.onEnd?.();
      }
      throw err;
    }
  }

  /** Stop all playback and supersede the active session. */
  cancel() {
    this.speaking = false;
    if (
      this.activeSessionId > 0 &&
      this.sessionState !== "ENDED" &&
      this.sessionState !== "ERROR"
    ) {
      this.setSession(this.activeSessionId, "CANCELLED");
    }
    this.playbackToken += 1;
    this.stopSource();
  }

  private stopSource() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // Ignored
      }

      this.currentSource.disconnect();
      this.currentSource = null;
    }
  }
}
