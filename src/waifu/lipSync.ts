import type { VRM } from "@pixiv/three-vrm";
import type { LipSyncSampler } from "./voiceEngine";

export class LipSync {
  vrm: VRM;
  sampler: LipSyncSampler;
  private smoothed = 0;

  constructor(vrm: VRM, sampler: LipSyncSampler) {
    this.vrm = vrm;
    this.sampler = sampler;
  }

  update(dt: number) {
    const exp = this.vrm.expressionManager;
    if (!exp) return;
    const raw = this.sampler();
    // smoothing + noise clamp
    const target = raw < 0.05 ? 0 : raw;
    this.smoothed += (target - this.smoothed) * Math.min(1, dt * 18);
    exp.setValue("aa", Math.max(0, Math.min(1, this.smoothed)));
  }
}
