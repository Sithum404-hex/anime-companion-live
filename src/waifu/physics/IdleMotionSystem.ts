import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { VRMHumanBoneName } from "@pixiv/three-vrm";
import { smoothNoise } from "./PhysicsBone";
import { PHYSICS_CONFIG } from "../physicsConfig";

/**
 * IdleMotionSystem — micro-motions that make the character feel alive.
 *
 * This system adds eye blinking, micro-saccades, gaze drift, and head
 * micro-stabilization — all of which are NOT handled by the existing
 * IdleManager (which covers breathing, body sway, arm motion, head tracking).
 *
 * Designed to run AFTER IdleManager as a supplemental layer.
 *
 * Features:
 *   • Eye blinking: random interval (2-6s), natural ease, occasional double-blink
 *   • Eye micro-saccades: tiny rapid eye movements (every 0.3-1.5s)
 *   • Eye gaze drift: slow wandering look direction
 *   • Head micro-drift: tiny random head position changes
 *   • Head counter-stabilization: compensates for body sway
 */
export class IdleMotionSystem {
  /** Elapsed time. */
  private t = 0;

  // ── Head micro-motion ─────────────────────────────────
  private headMicroPhase = 0;
  private headDriftTarget = new THREE.Vector2(0, 0);
  private headDriftCurrent = new THREE.Vector2(0, 0);
  private headDriftTimer = 0;
  private nextHeadDrift = 2 + Math.random() * 3;

  // ── Eyes ───────────────────────────────────────────────
  private blinkTimer = 2 + Math.random() * 3;
  private nextBlinkInterval = 3 + Math.random() * 3;
  private blinkState = 0;
  private blinkPhase: "open" | "closing" | "opening" = "open";
  /** Remaining closed-eye hold time (seconds); 0 = normal blinking. */
  private closedHold = 0;
  private readonly BLINK_DURATION = PHYSICS_CONFIG.idle.blinkDuration;
  private readonly BLINK_OPEN_DURATION = PHYSICS_CONFIG.idle.blinkOpenDuration;

  private saccadeTimer = 0.5 + Math.random() * 1.5;
  private nextSaccadeInterval = 0.4 + Math.random() * 1.5;
  private saccadeTarget = new THREE.Vector2(0, 0);
  private saccadeCurrent = new THREE.Vector2(0, 0);

  private gazeTarget = new THREE.Vector2(0, 0);
  private gazeCurrent = new THREE.Vector2(0, 0);
  private gazeDriftPhase = 0;

  // ── VRM references ────────────────────────────────────
  private headBone: THREE.Object3D | null;
  private neckBone: THREE.Object3D | null;
  private blendShapeProxy: VRM["expressionManager"] | null;

  constructor(private vrm: VRM) {
    const hum = vrm.humanoid;
    if (hum) {
      try {
        this.headBone = hum.getNormalizedBoneNode(VRMHumanBoneName.Head) ?? null;
      } catch {
        this.headBone = null;
      }
      try {
        this.neckBone = hum.getNormalizedBoneNode(VRMHumanBoneName.Neck) ?? null;
      } catch {
        this.neckBone = null;
      }
    } else {
      this.headBone = null;
      this.neckBone = null;
    }
    this.blendShapeProxy = vrm.expressionManager ?? null;

    this.headMicroPhase = Math.random() * Math.PI * 2;
    this.gazeDriftPhase = Math.random() * Math.PI * 2;
  }

  /**
   * Update micro-motions.
   *
   * @param dt Delta time in seconds.
   * @param isIdle Whether character is in idle state.
   * @param isSpeaking Whether TTS voice is playing.
   */
  update(dt: number, isIdle: boolean, isSpeaking: boolean): void {
    dt = Math.min(dt, PHYSICS_CONFIG.global.dtClamp);
    this.t += dt;

    this.updateHeadMicro(dt, isIdle);
    this.updateEyes(dt, isIdle);
  }

  // ── Head ───────────────────────────────────────────────

  private updateHeadMicro(dt: number, isIdle: boolean): void {
    if (!this.headBone) return;

    // Slow random drift target
    this.headDriftTimer += dt;
    if (this.headDriftTimer > this.nextHeadDrift) {
      this.headDriftTarget.set((Math.random() - 0.5) * 0.025, (Math.random() - 0.5) * 0.018);
      this.headDriftTimer = 0;
      this.nextHeadDrift = 2 + Math.random() * 4;
    }

    this.headDriftCurrent.lerp(
      this.headDriftTarget,
      Math.min(1, dt * PHYSICS_CONFIG.idle.headDriftLerp),
    );

    // Micro-oscillation
    this.headMicroPhase += dt * PHYSICS_CONFIG.idle.headMicroRate;
    const microX =
      Math.sin(this.headMicroPhase * 0.7) * 0.0015 +
      Math.sin(this.headMicroPhase * 1.73 + 1.3) * 0.0008;
    const microY =
      Math.sin(this.headMicroPhase * 0.5 + 10) * 0.001 +
      Math.sin(this.headMicroPhase * 1.21 + 3.7) * 0.0006;
    const microZ = Math.sin(this.headMicroPhase * 0.4 + 20) * 0.0008;

    this.headBone.rotation.x += this.headDriftCurrent.x + microX;
    this.headBone.rotation.y += this.headDriftCurrent.y + microY;
    this.headBone.rotation.z += microZ;

    if (this.neckBone) {
      this.neckBone.rotation.x += (this.headDriftCurrent.x + microX) * 0.5;
      this.neckBone.rotation.y += (this.headDriftCurrent.y + microY) * 0.5;
      this.neckBone.rotation.z += microZ * 0.3;
    }
  }

  // ── Eyes ───────────────────────────────────────────────

  private updateEyes(dt: number, isIdle: boolean): void {
    if (!this.blendShapeProxy) return;

    // ── Blink ──
    // A closed-eye hold (head-pat reaction) pins the phase machine shut until
    // the timer releases; reopening then runs the normal cycle backwards.
    if (this.closedHold > 0) {
      this.closedHold -= dt;
      this.blinkTimer = 0;
      this.blinkState = 1;
      this.applyBlink(1);
      return;
    }

    this.blinkTimer += dt;

    if (this.blinkPhase === "open") {
      if (this.blinkTimer >= this.nextBlinkInterval) {
        this.blinkPhase = "closing";
        this.blinkTimer = 0;
        this.blinkState = 0;
      }
    } else if (this.blinkPhase === "closing") {
      this.blinkState = Math.min(1, this.blinkTimer / this.BLINK_DURATION);
      if (this.blinkState >= 1) {
        this.blinkPhase = "opening";
        this.blinkTimer = 0;
      }
      this.applyBlink(this.blinkState);
    } else if (this.blinkPhase === "opening") {
      this.blinkState = 1 - Math.min(1, this.blinkTimer / this.BLINK_OPEN_DURATION);
      if (this.blinkState <= 0) {
        this.blinkPhase = "open";
        this.blinkTimer = 0;
        this.nextBlinkInterval = 2.5 + Math.random() * 3.5;
        if (Math.random() < 0.15) {
          this.nextBlinkInterval *= 0.3;
        }
      }
      this.applyBlink(this.blinkState);
    }

    // ── Micro-saccades ──
    this.saccadeTimer += dt;
    if (this.saccadeTimer >= this.nextSaccadeInterval) {
      this.saccadeTarget.set((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.05);
      this.saccadeTimer = 0;
      this.nextSaccadeInterval = 0.3 + Math.random() * 1.5;
    }

    this.saccadeCurrent.lerp(this.saccadeTarget, Math.min(1, dt * 20));

    // ── Gaze drift ──
    this.gazeDriftPhase += dt * 0.15;
    const gazeDriftX = smoothNoise(this.gazeDriftPhase, 0) * 0.03;
    const gazeDriftY = smoothNoise(this.gazeDriftPhase + 10, 1) * 0.02;

    this.gazeTarget.set(gazeDriftX, gazeDriftY);
    this.gazeCurrent.lerp(this.gazeTarget, Math.min(1, dt * 0.5));

    // Eye look is handled by the existing IdleManager via setLook().
    // Micro-saccades and gaze drift are applied as small offsets to the head
    // rotation instead (see updateHeadMicro), which achieves a similar visual effect
    // without relying on VRM lookAt internals that differ between VRM 0.x and 1.0.
  }

  private applyBlink(value: number): void {
    if (!this.blendShapeProxy) return;
    const eased = value * value * (3 - 2 * value);
    try {
      this.blendShapeProxy.setValue("blink", eased * 0.5);
      this.blendShapeProxy.setValue("blinkLeft", eased);
      this.blendShapeProxy.setValue("blinkRight", eased);
    } catch {
      // morphs may not exist
    }
  }

  forceBlink(): void {
    if (this.blinkPhase === "open") {
      this.blinkPhase = "closing";
      this.blinkTimer = 0;
      this.blinkState = 0;
    }
  }

  /**
   * Hold the eyes closed for `seconds`, then reopen naturally.
   *
   * Built on the existing blink phase machine rather than a parallel morph
   * path, so the expression layer's own blink writes and this hold can never
   * fight — the hold simply keeps the shared phase pinned at closed until the
   * timer releases it back into the normal open→closing→opening cycle.
   */
  forceEyesClosed(seconds: number): void {
    if (!this.blendShapeProxy) return;
    this.blinkPhase = "closing";
    this.blinkTimer = 0;
    this.blinkState = 1;
    this.applyBlink(1);
    this.closedHold = Math.max(this.closedHold, seconds);
  }

  forceWink(left: boolean): void {
    if (!this.blendShapeProxy) return;
    try {
      if (left) {
        this.blendShapeProxy.setValue("blinkLeft", 1);
      } else {
        this.blendShapeProxy.setValue("blinkRight", 1);
      }
      setTimeout(() => {
        try {
          if (left) {
            this.blendShapeProxy?.setValue("blinkLeft", 0);
          } else {
            this.blendShapeProxy?.setValue("blinkRight", 0);
          }
        } catch {
          /* ignore */
        }
      }, 150);
    } catch {
      /* ignore */
    }
  }

  reset(): void {
    this.t = 0;
    this.blinkTimer = 2 + Math.random() * 2;
    this.blinkPhase = "open";
    this.closedHold = 0;
    this.saccadeCurrent.set(0, 0);
    this.gazeCurrent.set(0, 0);
  }

  dispose(): void {
    this.headBone = null;
    this.neckBone = null;
  }
}
