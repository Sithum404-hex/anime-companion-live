// Anime-style TTS using SpeechSynthesis routed through WebAudio for filter/lipsync.
// Browsers don't expose TTS audio as a stream, so we run an analyser on a synthetic
// envelope that tracks utterance progress for lip-sync, while the SpeechSynthesis
// engine actually plays the sound. This is the standard browser-only approach.

export interface SpeakOptions {
  pitch?: number;
  rate?: number;
  volume?: number;
  emotionPitchOffset?: number;
}

export type LipSyncSampler = () => number; // 0..1 mouth openness

export class VoiceEngine {
  private ctx: AudioContext | null = null;
  private envGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArr: Uint8Array | null = null;
  private speaking = false;
  onStart?: () => void;
  onEnd?: () => void;

  ensureCtx() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;
    // Build a tiny oscillator-driven envelope so we have a real audio graph for the analyser.
    const osc = ctx.createOscillator();
    osc.frequency.value = 220;
    const env = ctx.createGain();
    env.gain.value = 0;
    const filt = ctx.createBiquadFilter();
    filt.type = "highshelf";
    filt.frequency.value = 2000;
    filt.gain.value = 6;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    osc.connect(env).connect(filt).connect(analyser);
    // Do NOT connect analyser to destination — speechSynthesis plays the real audio.
    osc.start();
    this.envGain = env;
    this.analyser = analyser;
    this.dataArr = new Uint8Array(analyser.frequencyBinCount);
    return ctx;
  }

  isSpeaking() {
    return this.speaking;
  }

  getLipSyncSampler(): LipSyncSampler {
    return () => {
      if (!this.analyser || !this.dataArr) return 0;
      this.analyser.getByteTimeDomainData(this.dataArr as unknown as Uint8Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < this.dataArr.length; i++) {
        const v = (this.dataArr[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this.dataArr.length);
      // amplify, clamp
      return Math.max(0, Math.min(1, (rms - 0.02) * 6));
    };
  }

  async speak(text: string, opts: SpeakOptions = {}) {
    if (!("speechSynthesis" in window)) return;
    this.ensureCtx();
    await this.ctx?.resume();
    window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(text);
    u.pitch = Math.max(0, Math.min(2, (opts.pitch ?? 1.6) + (opts.emotionPitchOffset ?? 0)));
    u.rate = Math.max(0.1, Math.min(2, opts.rate ?? 1.1));
    u.volume = Math.max(0, Math.min(1, opts.volume ?? 1));

    // Try to pick a higher-pitched voice if available
    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => /female|girl|samantha|google.*female/i.test(v.name)) ||
      voices.find((v) => /en-?US|en-?GB/i.test(v.lang));
    if (preferred) u.voice = preferred;

    return new Promise<void>((resolve) => {
      const env = this.envGain;
      u.onstart = () => {
        this.speaking = true;
        this.onStart?.();
        // Drive synthetic envelope with a wobble while speaking
        if (env && this.ctx) {
          const now = this.ctx.currentTime;
          env.gain.cancelScheduledValues(now);
          env.gain.setValueAtTime(0.0, now);
          // rough phoneme-like pulses
          const dur = Math.max(0.5, text.length * 0.06);
          const steps = Math.ceil(dur * 8);
          for (let i = 0; i < steps; i++) {
            const t = now + (i / steps) * dur;
            const v = 0.15 + Math.random() * 0.55;
            env.gain.linearRampToValueAtTime(v, t + 0.04);
            env.gain.linearRampToValueAtTime(0.05, t + 0.1);
          }
          env.gain.linearRampToValueAtTime(0, now + dur + 0.1);
        }
      };
      const finish = () => {
        this.speaking = false;
        if (env && this.ctx) {
          env.gain.cancelScheduledValues(this.ctx.currentTime);
          env.gain.setValueAtTime(0, this.ctx.currentTime);
        }
        this.onEnd?.();
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;
      window.speechSynthesis.speak(u);
    });
  }

  cancel() {
    window.speechSynthesis.cancel();
    this.speaking = false;
    if (this.envGain && this.ctx) {
      this.envGain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.envGain.gain.setValueAtTime(0, this.ctx.currentTime);
    }
  }
}
