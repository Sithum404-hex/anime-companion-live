import { EventBus } from "./EventBus";
import { MicInput } from "../micInput";
import type { FaceTracker } from "../faceTracker";
import type { QualitySettings } from "../performance";

/**
 * InputController owns mic and webcam motion capture.
 * No other module accesses microphone or webcam hardware.
 */
export class InputController {
  readonly mic: MicInput;
  private motion: FaceTracker | null = null;
  private motionLoad: Promise<FaceTracker> | null = null;
  private readonly motionResolution: number;
  private motionFrameSkip: number;
  private bus: EventBus;
  private unsubs: (() => void)[] = [];
  /** Last readMotion() result — shared across callers within the same frame. */
  private lastMotionAt = 0;
  private lastMotion: { x: number; y: number; score: number } | null = null;

  constructor(bus: EventBus, quality: QualitySettings) {
    this.bus = bus;
    this.mic = new MicInput();
    this.motionResolution = quality.motionDetectRes;

    if (quality.tier === "low") {
      this.mic.setFftSize(quality.fftSize);
      this.motionFrameSkip = 6;
    } else {
      this.motionFrameSkip = 3;
    }
  }

  /** Load the large MediaPipe bundle only when webcam tracking is enabled. */
  private async getMotionTracker(): Promise<FaceTracker> {
    if (this.motion) return this.motion;
    if (!this.motionLoad) {
      this.motionLoad = import("../faceTracker").then(({ FaceTracker }) => {
        const tracker = new FaceTracker(this.motionResolution);
        tracker.setFrameSkip(this.motionFrameSkip);
        this.motion = tracker;
        return tracker;
      });
    }
    return this.motionLoad;
  }

  // ── Mic ──

  async startMic(): Promise<void> {
    await this.mic.start();
  }

  stopMic(): void {
    this.mic.stop();
  }

  get micActive(): boolean {
    return this.mic.active;
  }

  micLevel(): number {
    return this.mic.level();
  }

  setMicFftSize(size: number): void {
    this.mic.setFftSize(size);
  }

  // ── Motion ──

  async startMotion(): Promise<void> {
    const motion = await this.getMotionTracker();
    await motion.start();
  }

  stopMotion(): void {
    this.motion?.stop();
  }

  get motionActive(): boolean {
    return this.motion?.active ?? false;
  }

  readMotion(): { x: number; y: number; score: number } | null {
    // InteractionManager and the render loop both sample motion — reuse the
    // same detection within one frame so FaceTracker.tick() isn't advanced
    // twice (that would halve the effective detection rate).
    const now = performance.now();
    if (now - this.lastMotionAt < 8) return this.lastMotion;
    const m = this.motion?.tick();
    if (!m || m.score < 0.05) {
      this.lastMotion = null;
    } else {
      this.lastMotion = { x: -m.cx, y: m.cy, score: m.score };
    }
    this.lastMotionAt = now;
    return this.lastMotion;
  }

  setMotionFrameSkip(n: number): void {
    this.motionFrameSkip = n;
    this.motion?.setFrameSkip(n);
  }

  // ── Cleanup ──

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.mic.stop();
    this.motion?.stop();
  }
}
