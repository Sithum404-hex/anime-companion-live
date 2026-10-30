/**
 * StereoWidener — Haas-effect stereo imaging for AudioPlayerManager.
 *
 * Creates a subtle delay (5-15ms) between left and right channels to
 * produce a wide, immersive soundstage. Delay depth is modulated by
 * the widenAmount parameter (0 = mono, 1 = wide).
 *
 * Integration (add these 3 lines to AudioPlayerManager.ts):
 *
 *   // In the imports:
 *   import { StereoWidener } from "@/waifu/StereoWidener";
 *
 *   // Add as a member:
 *   private widener: StereoWidener | null = null;
 *
 *   // At the end of ensureCtx(), after the outputGain → destination line:
 *   this.widener = new StereoWidener(this.ctx, this.outputGain, this.analyser);
 *   this.widener.setWiden(0.55);  // 55% width
 *
 *   // In dispose(), before this.ctx.close():
 *   this.widener?.disconnect();
 *   this.widener = null;
 *
 *   // Optional: expose a setter for real-time tuning
 *   setStereoWiden(amount: number): void {
 *     this.widener?.setWiden(amount);
 *   }
 */

export class StereoWidener {
  private splitter: ChannelSplitterNode;
  private delayL: DelayNode;
  private delayR: DelayNode;
  private gainL: GainNode;
  private gainR: GainNode;
  private merger: ChannelMergerNode;
  private dryGain: GainNode;
  private wetGain: GainNode;

  /**
   * Insert the widener between `source` and `destination`.
   * The signal path becomes: source → [dry + wet(split→delay→merge)] → destination
   */
  constructor(ctx: AudioContext, source: AudioNode, destination: AudioNode) {
    const sampleRate = ctx.sampleRate;

    // Dry path
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 0.7;

    // Wet path
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0.3;

    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);

    // Left channel: 7ms delay + slight volume cut
    this.delayL = ctx.createDelay(0.02);
    this.delayL.delayTime.value = 0.007;
    this.gainL = ctx.createGain();
    this.gainL.gain.value = 0.85;

    // Right channel: 11ms delay + slight volume cut
    this.delayR = ctx.createDelay(0.02);
    this.delayR.delayTime.value = 0.011;
    this.gainR = ctx.createGain();
    this.gainR.gain.value = 0.82;

    // Wet routing: source → splitter → delayL → gainL → merger[0]
    //                               → delayR → gainR → merger[1]
    this.splitter.connect(this.delayL, 0);
    this.splitter.connect(this.delayR, 1);
    this.delayL.connect(this.gainL);
    this.delayR.connect(this.gainR);
    this.gainL.connect(this.merger, 0, 0);
    this.gainR.connect(this.merger, 0, 1);

    // Source → dry + wet → destination
    source.connect(this.dryGain);
    source.connect(this.splitter);
    this.dryGain.connect(destination);
    this.merger.connect(this.wetGain);
    this.wetGain.connect(destination);
  }

  /** Set stereo width. 0 = no effect (dry only), 1 = full wet. */
  setWiden(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    const dry = 1 - a * 0.6;
    const wet = 0.15 + a * 0.5;
    const delaySpread = 0.004 + a * 0.012;

    this.dryGain.gain.setTargetAtTime(dry, this.dryGain.context.currentTime, 0.05);
    this.wetGain.gain.setTargetAtTime(wet, this.wetGain.context.currentTime, 0.05);

    const now = this.delayL.context.currentTime;
    this.delayL.delayTime.setTargetAtTime(0.005 + delaySpread, now, 0.05);
    this.delayR.delayTime.setTargetAtTime(0.005 + delaySpread * 1.4, now, 0.05);

    this.gainL.gain.setTargetAtTime(1 - a * 0.25, now, 0.05);
    this.gainR.gain.setTargetAtTime(1 - a * 0.3, now, 0.05);
  }

  /** Tear down and bypass the widener. */
  disconnect(): void {
    this.splitter.disconnect();
    this.delayL.disconnect();
    this.delayR.disconnect();
    this.gainL.disconnect();
    this.gainR.disconnect();
    this.merger.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
  }
}
