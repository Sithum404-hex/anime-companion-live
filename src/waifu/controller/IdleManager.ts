import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { VRMHumanBoneName } from "@pixiv/three-vrm";
import type { AnimState } from "./AnimationStateMachine";

interface BoneCache {
  hips: THREE.Object3D | null;
  spine: THREE.Object3D | null;
  chest: THREE.Object3D | null;
  neck: THREE.Object3D | null;
  head: THREE.Object3D | null;
  lShoulder: THREE.Object3D | null;
  rShoulder: THREE.Object3D | null;
  lUpperArm: THREE.Object3D | null;
  rUpperArm: THREE.Object3D | null;
  lLowerArm: THREE.Object3D | null;
  rLowerArm: THREE.Object3D | null;
  lHand: THREE.Object3D | null;
  rHand: THREE.Object3D | null;
}

function organicWave(t: number, baseFreq: number, amp: number): number {
  return (
    Math.sin(t * baseFreq) * amp +
    Math.sin(t * baseFreq * 1.73 + 1.3) * amp * 0.4 +
    Math.sin(t * baseFreq * 0.51 + 2.7) * amp * 0.25
  );
}

export class IdleManager {
  private bones!: BoneCache;
  private t = 0;
  private weightPhase = 0;
  private weightTarget = 0;
  private weightTimer = 0;
  private nextWeightShift = 3 + Math.random() * 4;
  private shoulderPhase = Math.random() * Math.PI * 2;
  private lookTarget = new THREE.Vector2(0, 0);
  private lookSmoothed = new THREE.Vector2(0, 0);
  private headOffset = new THREE.Euler(0, 0, 0);
  private armBlend = 0;
  private talkBlend = 0;

  constructor(private vrm: VRM) {
    this.cacheBones();
  }

  private cacheBones(): void {
    const hum = this.vrm.humanoid;
    if (!hum) {
      this.bones = {} as BoneCache;
      return;
    }
    this.bones = {
      hips: hum.getNormalizedBoneNode(VRMHumanBoneName.Hips),
      spine: hum.getNormalizedBoneNode(VRMHumanBoneName.Spine),
      chest:
        hum.getNormalizedBoneNode(VRMHumanBoneName.UpperChest) ||
        hum.getNormalizedBoneNode(VRMHumanBoneName.Chest),
      neck: hum.getNormalizedBoneNode(VRMHumanBoneName.Neck),
      head: hum.getNormalizedBoneNode(VRMHumanBoneName.Head),
      lShoulder: hum.getNormalizedBoneNode(VRMHumanBoneName.LeftShoulder),
      rShoulder: hum.getNormalizedBoneNode(VRMHumanBoneName.RightShoulder),
      lUpperArm: hum.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm),
      rUpperArm: hum.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm),
      lLowerArm: hum.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm),
      rLowerArm: hum.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm),
      lHand: hum.getNormalizedBoneNode(VRMHumanBoneName.LeftHand),
      rHand: hum.getNormalizedBoneNode(VRMHumanBoneName.RightHand),
    };
  }

  setLook(x: number, y: number): void {
    this.lookTarget.set(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
  }

  update(dt: number, animState: AnimState, hasIdleAction: boolean, isPlaying: boolean): void {
    dt = Math.min(dt, 0.033);
    this.t += dt;

    const isNonIdle =
      animState !== "idle" &&
      animState !== "talking" &&
      animState !== "listening" &&
      animState !== "thinking";
    const idleFamily = !isNonIdle;
    const isProcedural = !isPlaying && !hasIdleAction;
    const allowProceduralBody = isProcedural && idleFamily;

    const T = this.t;
    const b = this.bones;

    // ── Breathing — additive layer, ALWAYS on in idle-family states ──
    // A person never stops breathing, even while a VRMA loop plays.
    // Layering a subtle chest rise on top of the clip keeps her alive
    // without fighting the clip's keyframes. (When no clip is loaded the
    // procedural block below owns the torso absolutely instead.)
    if (idleFamily && !allowProceduralBody) {
      const breathCycle = Math.sin(T * 1.25) * 0.5 + 0.5;
      const breathAmp = 0.02;
      if (b.chest) b.chest.rotation.x += breathCycle * breathAmp * 0.65;
      if (b.spine) b.spine.rotation.x += breathCycle * breathAmp * 0.3;
      if (b.hips) b.hips.rotation.z += organicWave(T, 0.3, 0.003);
      if (b.hips) b.hips.rotation.x += organicWave(T + 1.4, 0.22, 0.002);
    }

    if (allowProceduralBody) {
      const breathCycle = Math.sin(T * 1.25) * 0.5 + 0.5;
      const breathAmp = 0.02;
      if (b.spine) {
        b.spine.rotation.x = breathCycle * breathAmp * 0.3;
      }
      if (b.chest) {
        b.chest.rotation.x = breathCycle * breathAmp;
      }
      this.weightTimer += dt;
      if (this.weightTimer > this.nextWeightShift) {
        this.weightTarget = (Math.random() - 0.5) * 2;
        this.weightTimer = 0;
        this.nextWeightShift = 3 + Math.random() * 5;
      }
      this.weightPhase = THREE.MathUtils.lerp(
        this.weightPhase,
        this.weightTarget,
        Math.min(1, dt * 0.8),
      );

      if (b.hips) {
        b.hips.rotation.z = this.weightPhase * 0.012;
        b.hips.rotation.x = organicWave(T, 0.3, 0.003);
        b.hips.rotation.y = this.weightPhase * 0.008;
      }
      if (b.spine) {
        b.spine.rotation.z = -this.weightPhase * 0.005;
        b.spine.rotation.y = -this.weightPhase * 0.004;
      }
      if (b.chest) {
        b.chest.rotation.z = organicWave(T, 0.45, 0.004) + this.weightPhase * 0.003;
        b.chest.rotation.y = organicWave(T, 0.35, 0.003);
      }

      this.shoulderPhase += dt * 0.7;
      const lShoulderDrift = organicWave(T + 1.0, 0.4, 0.005);
      const rShoulderDrift = organicWave(T + 3.5, 0.38, 0.005);
      if (b.lShoulder) {
        b.lShoulder.rotation.z = lShoulderDrift;
        b.lShoulder.rotation.x = organicWave(T, 0.25, 0.003);
      }
      if (b.rShoulder) {
        b.rShoulder.rotation.z = rShoulderDrift;
        b.rShoulder.rotation.x = organicWave(T + 2.0, 0.27, 0.003);
      }

      if (b.lUpperArm) {
        b.lUpperArm.rotation.z = 0.05 + organicWave(T, 0.55, 0.01);
        b.lUpperArm.rotation.x = organicWave(T, 0.3, 0.005);
        b.lUpperArm.rotation.y = organicWave(T, 0.2, 0.005);
      }
      if (b.rUpperArm) {
        b.rUpperArm.rotation.z = -0.05 + organicWave(T + 1.8, 0.52, 0.01);
        b.rUpperArm.rotation.x = organicWave(T + 1.8, 0.28, 0.005);
        b.rUpperArm.rotation.y = -organicWave(T + 1.0, 0.2, 0.005);
      }
      if (b.lLowerArm) {
        b.lLowerArm.rotation.z = organicWave(T + 0.5, 0.3, 0.008);
        b.lLowerArm.rotation.x = organicWave(T + 1.2, 0.25, 0.005);
      }
      if (b.rLowerArm) {
        b.rLowerArm.rotation.z = -organicWave(T + 2.0, 0.3, 0.008);
        b.rLowerArm.rotation.x = organicWave(T + 2.5, 0.25, 0.005);
      }
      if (b.lHand) b.lHand.rotation.x = organicWave(T + 0.3, 0.5, 0.008);
      if (b.rHand) b.rHand.rotation.x = organicWave(T + 3.0, 0.5, 0.008);
    }

    const allowIdleOverrides = idleFamily && !hasIdleAction && !isPlaying;

    // ── Head & neck look tracking (idle-family states only) ──
    // The VRMA gesture/dance clips own the head outside idle-family states;
    // overwriting them with absolute rotations makes gestures look head-dead.
    this.lookSmoothed.lerp(this.lookTarget, Math.min(1, dt * 2));

    const gazeX = this.lookSmoothed.x;
    const gazeY = this.lookSmoothed.y;
    const idleDriftX = organicWave(T, 0.15, 0.02);
    const idleDriftY = organicWave(T + 5.0, 0.12, 0.015);

    if (idleFamily) {
      const targetYaw = gazeX * 0.4 + idleDriftX;
      const targetPitch = -gazeY * 0.4 + idleDriftY;

      this.headOffset.y = THREE.MathUtils.lerp(
        this.headOffset.y,
        THREE.MathUtils.clamp(targetYaw, -0.5, 0.5),
        Math.min(1, dt * 3),
      );
      this.headOffset.x = THREE.MathUtils.lerp(
        this.headOffset.x,
        THREE.MathUtils.clamp(targetPitch, -0.3, 0.3),
        Math.min(1, dt * 3),
      );

      const headTilt = this.weightPhase * 0.008 + organicWave(T, 0.3, 0.005);

      const pitchLimit = 0.15;
      const yawLimit = 0.2;
      const tiltLimit = 0.08;

      if (b.neck) {
        const ny = THREE.MathUtils.clamp(this.headOffset.y * 0.5, -yawLimit, yawLimit);
        const nx = THREE.MathUtils.clamp(this.headOffset.x * 0.5, -pitchLimit, pitchLimit);
        const nz = THREE.MathUtils.clamp(headTilt * 0.3, -tiltLimit, tiltLimit);
        b.neck.rotation.y = ny;
        b.neck.rotation.x = nx;
        b.neck.rotation.z = nz;
      }
      if (b.head) {
        const hy = THREE.MathUtils.clamp(this.headOffset.y * 0.7, -yawLimit, yawLimit);
        const hx = THREE.MathUtils.clamp(this.headOffset.x * 0.7, -pitchLimit, pitchLimit);
        const hz = THREE.MathUtils.clamp(headTilt * 0.4, -tiltLimit, tiltLimit);
        b.head.rotation.y = hy;
        b.head.rotation.x = hx;
        b.head.rotation.z = hz;
      }
    } else {
      // Let the clip drive the head; drift our overrides back to zero
      // so there's no snap when returning to an idle-family state.
      this.headOffset.x = THREE.MathUtils.lerp(this.headOffset.x, 0, Math.min(1, dt * 3));
      this.headOffset.y = THREE.MathUtils.lerp(this.headOffset.y, 0, Math.min(1, dt * 3));
    }

    if (allowIdleOverrides) {
      this.armBlend = THREE.MathUtils.lerp(
        this.armBlend,
        (animState as AnimState) === "happy" ? 1 : 0,
        Math.min(1, dt * 3),
      );
      if (this.armBlend > 0.01) {
        const bounce = Math.sin(T * 5.5) * 0.01 * this.armBlend;
        if (b.chest) b.chest.rotation.x += bounce;
        if (b.spine) b.spine.rotation.z += Math.sin(T * 4.2) * 0.006 * this.armBlend;
        if (b.hips) {
          b.hips.rotation.y += Math.sin(T * 3.8) * 0.008 * this.armBlend;
        }
      }

      this.talkBlend = THREE.MathUtils.lerp(
        this.talkBlend,
        animState === "talking" ? 1 : 0,
        Math.min(1, dt * 4),
      );
      if (this.talkBlend > 0.01) {
        if (b.rUpperArm) {
          b.rUpperArm.rotation.x -= 0.05 * this.talkBlend;
        }
        if (b.rLowerArm) {
          b.rLowerArm.rotation.x -= 0.08 * this.talkBlend;
        }
        if (b.rHand) {
          b.rHand.rotation.x -= 0.05 * this.talkBlend;
        }
      }
    }

    // ── State-specific additive poses (safe to layer over the idle clip) ──
    if (idleFamily) {
      if (animState === "thinking") {
        const thinkNod = organicWave(T * 0.6, 0.5, 0.03);
        if (b.neck) {
          b.neck.rotation.x += thinkNod;
          b.neck.rotation.z += 0.08;
        }
        if (b.head) {
          b.head.rotation.x += thinkNod * 0.5;
          b.head.rotation.z += 0.05;
        }
        if (b.lUpperArm) {
          b.lUpperArm.rotation.x += 0.15 + Math.sin(T * 0.8) * 0.04;
        }
      }

      if (animState === "listening") {
        const lean = Math.sin(T * 0.5) * 0.02 + 0.03;
        if (b.spine) b.spine.rotation.x += lean;
        if (b.chest) b.chest.rotation.x += lean;
        if (b.neck) b.neck.rotation.x += 0.02;
      }
    }
  }

  dispose(): void {
    this.bones = {} as BoneCache;
  }
}
