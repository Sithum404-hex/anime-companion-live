import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { VRMExpressionManager } from "@pixiv/three-vrm";
import type { AudioFrame } from "../voiceEngine";

const PHONEMES = ["aa", "ee", "ih", "oh", "ou"] as const;

const SILENCE_THRESHOLD = 0.03;
const BREATH_FREQ = 1.5;
const BREATH_AMP = 0.06;
const LERP_FACTOR = 0.15;
const BUFFER_SIZE = 3;

export class LipSyncController {
  private exp: VRMExpressionManager | null = null;
  private currentPhoneme: string | null = null;
  private levelBuffer: number[] = [];
  private bandBuffer: number[][] = [];
  private breathTimer = 0;

  constructor(
    private vrm: VRM,
    private getFrame: () => AudioFrame,
  ) {
    this.exp = vrm?.expressionManager ?? null;
  }

  setFrameSource(getFrame: () => AudioFrame): void {
    this.getFrame = getFrame;
  }

  update(dt: number): void {
    const exp = this.exp;
    if (!exp) return;

    const frame = this.getFrame();

    this.levelBuffer.push(frame.level);
    if (this.levelBuffer.length > BUFFER_SIZE) this.levelBuffer.shift();
    const smoothedLevel = this.levelBuffer.reduce((a, b) => a + b, 0) / this.levelBuffer.length;

    this.bandBuffer.push(frame.bands);
    if (this.bandBuffer.length > BUFFER_SIZE) this.bandBuffer.shift();
    const smoothedBands = Array.from(
      { length: 5 },
      (_, i) => this.bandBuffer.reduce((s, b) => s + b[i], 0) / this.bandBuffer.length,
    );

    const isSilent = smoothedLevel < SILENCE_THRESHOLD;

    if (isSilent) {
      this.currentPhoneme = null;

      this.breathTimer += dt;
      const breathPhase = Math.sin(this.breathTimer * BREATH_FREQ) * 0.5 + 0.5;
      const breathValue = breathPhase * BREATH_AMP;

      for (const p of PHONEMES) {
        const target = p === "aa" ? breathValue : 0;
        const cur = exp.getValue(p) ?? 0;
        const val = THREE.MathUtils.lerp(cur, target, LERP_FACTOR);
        exp.setValue(p, Math.max(0, Math.min(1, val)));
      }
    } else {
      this.breathTimer = 0;

      const maxBand = smoothedBands.indexOf(Math.max(...smoothedBands));
      const detected = PHONEMES[maxBand] || "aa";

      if (this.currentPhoneme !== detected) {
        this.currentPhoneme = detected;
      }

      for (const p of PHONEMES) {
        const target = p === this.currentPhoneme ? Math.min(1, smoothedLevel * 4) : 0;
        const cur = exp.getValue(p) ?? 0;
        const val = THREE.MathUtils.lerp(cur, target, LERP_FACTOR);
        exp.setValue(p, Math.max(0, Math.min(1, val)));
      }
    }
  }

  dispose(): void {
    this.exp = null;
  }
}
