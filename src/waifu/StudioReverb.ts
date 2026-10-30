/**
 * StudioReverb — procedural plate-style ambience for the music player.
 *
 * Generates a short exponentially-decaying stereo noise impulse response at
 * construction (no external IR asset needed) and runs it through a
 * ConvolverNode. A pre-delay keeps transients dry and tight; a lowpass in the
 * wet path tames harsh tail sibilance. Mix is wet/dry crossfade.
 */
export class StudioReverb {
  private input: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private convolver: ConvolverNode;
  private tone: BiquadFilterNode;

  constructor(ctx: AudioContext, source: AudioNode, destination: AudioNode, seconds = 1.6) {
    this.input = ctx.createGain();

    this.dry = ctx.createGain();
    this.dry.gain.value = 1;

    // Pre-delay — separates the direct signal from the tail for clarity.
    const preDelay = ctx.createDelay(0.1);
    preDelay.delayTime.value = 0.02;

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.buildImpulse(ctx, seconds);

    // Warm the tail: roll off the highs of the reverb only.
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.tone.frequency.value = 6500;
    this.tone.Q.value = 0.4;

    this.wet = ctx.createGain();
    this.wet.gain.value = 0; // starts fully dry

    source.connect(this.input);
    this.input.connect(this.dry);
    this.dry.connect(destination);

    this.input.connect(preDelay);
    preDelay.connect(this.convolver);
    this.convolver.connect(this.tone);
    this.tone.connect(this.wet);
    this.wet.connect(destination);
  }

  /** Wet/dry mix. 0 = bone dry, 1 = cathedral. Sensible range: 0–0.35. */
  setMix(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    const now = this.dry.context.currentTime;
    this.wet.gain.setTargetAtTime(a * 0.9, now, 0.08);
    this.dry.gain.setTargetAtTime(1 - a * 0.35, now, 0.08);
  }

  /**
   * Synthesize a natural-sounding IR: decaying filtered noise with early
   * reflections. Deterministic seed so every session sounds identical.
   */
  private buildImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = ctx.createBuffer(2, length, rate);

    let seed = 22222;
    const rand = () => {
      // xorshift32 — stable across browsers/sessions.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 100000) / 100000;
    };

    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const decay = Math.pow(1 - t, 2.4);
        const noise = rand() * 2 - 1;
        lp += (noise - lp) * 0.28; // gentle lowpass per-sample
        data[i] = lp * decay;
      }
      // A few discrete early reflections for a "room" feel.
      const taps = [0.011, 0.019, 0.031, 0.047, 0.062];
      taps.forEach((tap, k) => {
        const idx = Math.floor(tap * rate) + ch * 37;
        if (idx < length) data[idx] += (k % 2 === 0 ? 0.55 : -0.45) / (k + 1);
      });
    }
    return buffer;
  }

  disconnect(): void {
    this.input.disconnect();
    this.dry.disconnect();
    this.convolver.disconnect();
    this.tone.disconnect();
    this.wet.disconnect();
  }
}
