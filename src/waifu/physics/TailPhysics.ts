import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { BoneClassifier, type ClassifiedBone } from "./BoneClassifier";
import {
  PhysicsBone,
  PhysicsBoneChain,
  smoothNoise,
  getGravity,
  impulseChainsAt,
  dragChainsAt,
  hipInertiaChains,
  type HipInertiaDrive,
} from "./PhysicsBone";
import { PHYSICS_CONFIG, stateMotion, type ColliderSet } from "../physicsConfig";
import type { BodyColliders } from "./BodyColliders";

/**
 * TailPhysics — dynamic tail motion using multi-bone chain simulation.
 *
 * Simulates the tail as a spring-damper chain with idle sway oscillation,
 * follow-through motion from body movement, and organic wagging.
 *
 * Features:
 *   • Verlet integration with distance constraints
 *   • Multi-bone chain for smooth curved motion
 *   • Idle sway with Perlin-like noise for natural appearance
 *   • Follow-through when body rotates
 *   • Wagging behavior for happy/excited states
 *   • Side-based asymmetry for natural tail carriage
 */
export class TailPhysics {
  /** Tail physics chains (usually 1, but some models have multi-tails). */
  private chains: PhysicsBoneChain[] = [];
  /** Hip bone for body velocity tracking. */
  private hips: THREE.Object3D | null = null;
  /** Previous hip position for velocity computation. */
  private prevHipsPos = new THREE.Vector3();
  /** Body angular velocity (computed from hip rotation change). */
  private angularVelocity = new THREE.Vector3();
  /** Previous hip quaternion for angular velocity. */
  private prevHipsQuat = new THREE.Quaternion();
  /** Elapsed time. */
  private t = 0;
  /** Tail wag phase (speeds up when happy/excited). */
  private wagPhase = 0;
  /** Whether tail bones were found. */
  private _hasTail = false;

  constructor(private vrm: VRM) {
    this.initialize();
  }

  /** Whether tail physics bones were found. */
  get hasTail(): boolean {
    return this._hasTail;
  }

  get chainCount(): number {
    return this.chains.length;
  }

  private initialize(): void {
    const classifier = new BoneClassifier(this.vrm);
    const tailChains = classifier.getChainsByCategory("tail");

    if (tailChains.length === 0) {
      this._hasTail = false;
      return;
    }

    this.hips = classifier.hips;
    if (this.hips) {
      this.prevHipsPos.setFromMatrixPosition(this.hips.matrixWorld);
      this.prevHipsQuat.copy(this.hips.quaternion);
    }

    for (const chain of tailChains) {
      const physicsChain = this.buildChain(chain);
      if (physicsChain) {
        this.chains.push(physicsChain);
      }
    }

    this._hasTail = this.chains.length > 0;
  }

  private buildChain(classifiedChain: ClassifiedBone[]): PhysicsBoneChain | null {
    if (classifiedChain.length < 2) return null;

    const physicsBones: PhysicsBone[] = [];
    let prevPhysicsBone: PhysicsBone | null = null;
    const chainLen = classifiedChain.length;

    for (let i = 0; i < chainLen; i++) {
      const cb = classifiedChain[i];
      const bone = cb.bone;

      const worldPos = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);

      let restOffset = new THREE.Vector3(0, -0.03, 0.03);
      if (bone.parent) {
        const parentWorldPos = new THREE.Vector3().setFromMatrixPosition(bone.parent.matrixWorld);
        restOffset = new THREE.Vector3().subVectors(worldPos, parentWorldPos);
        if (restOffset.lengthSq() < 0.0001) {
          restOffset.set(0, -0.03 * (i + 1), 0.03 * (i + 1));
        }
      }

      const pb: PhysicsBone = new PhysicsBone(bone, prevPhysicsBone, worldPos, restOffset);

      // Tail stiffness increases toward base, decreases toward tip
      const ratio = i / (chainLen - 1);

      // Base: stiffer and damped
      // Tip: loose and responsive
      pb.stiffness =
        PHYSICS_CONFIG.tail.boneTuning.stiffnessBase -
        ratio * PHYSICS_CONFIG.tail.boneTuning.stiffnessSpan;
      pb.damping =
        PHYSICS_CONFIG.tail.boneTuning.dampingBase -
        ratio * PHYSICS_CONFIG.tail.boneTuning.dampingSpan;
      pb.gravityInfluence =
        PHYSICS_CONFIG.tail.boneTuning.gravityBase +
        ratio * PHYSICS_CONFIG.tail.boneTuning.gravitySpan;
      pb.airResistance =
        PHYSICS_CONFIG.tail.boneTuning.airBase + ratio * PHYSICS_CONFIG.tail.boneTuning.airSpan;

      physicsBones.push(pb);
      prevPhysicsBone = pb;
    }

    return new PhysicsBoneChain(physicsBones);
  }

  /**
   * Update tail physics.
   * @param dt Delta time in seconds (capped at 33ms).
   * @param animState Current animation state string.
   */
  update(
    dt: number,
    animState: string,
    opts?: {
      iterations?: number;
      flutter?: boolean;
      colliders?: ColliderSet;
      body?: BodyColliders;
    },
  ): void {
    if (!this._hasTail) return;

    dt = Math.min(dt, PHYSICS_CONFIG.global.dtClamp);
    this.t += dt;

    // 1. Compute body velocity and angular velocity
    const bodyVel = new THREE.Vector3();
    if (this.hips) {
      const hipsPos = new THREE.Vector3().setFromMatrixPosition(this.hips.matrixWorld);
      bodyVel.subVectors(hipsPos, this.prevHipsPos).divideScalar(Math.max(dt, 0.001));
      bodyVel.clampLength(0, PHYSICS_CONFIG.tail.velocityClamp);
      this.prevHipsPos.copy(hipsPos);

      // Angular velocity from hip rotation change
      const dq = new THREE.Quaternion()
        .copy(this.hips.quaternion)
        .multiply(this.prevHipsQuat.clone().invert());
      const angle = 2 * Math.acos(Math.max(-1, Math.min(1, dq.w)));
      const axis = new THREE.Vector3();
      if (angle > 0.001) {
        axis
          .set(dq.x, dq.y, dq.z)
          .normalize()
          .multiplyScalar(angle / Math.max(dt, 0.001));
      }
      this.angularVelocity.lerp(axis, Math.min(1, dt * PHYSICS_CONFIG.tail.angularVelLerp));
      this.prevHipsQuat.copy(this.hips.quaternion);
    }

    // 2. Compute motion intensity
    const stateMotion = this.getStateIntensity(animState);

    // 3. Tail wagging (fast oscillation for happy states)
    const isHappy = animState === "happy" || animState === "surprised" || animState === "dance";
    const wagSpeed = isHappy
      ? PHYSICS_CONFIG.tail.wagHappySpeedBase +
        stateMotion * PHYSICS_CONFIG.tail.wagHappySpeedMotion
      : PHYSICS_CONFIG.tail.wagIdleSpeedBase + stateMotion * PHYSICS_CONFIG.tail.wagIdleSpeedMotion;
    const wagAmp = isHappy
      ? PHYSICS_CONFIG.tail.wagHappyAmpBase + stateMotion * PHYSICS_CONFIG.tail.wagHappyAmpMotion
      : PHYSICS_CONFIG.tail.wagIdleAmpBase + stateMotion * PHYSICS_CONFIG.tail.wagIdleAmpMotion;
    this.wagPhase += dt * wagSpeed;

    // 4. Compute gravity with body inertia and angular velocity
    const gravity = getGravity().clone();
    const inertiaFactor = PHYSICS_CONFIG.tail.inertiaFactor;
    gravity.x -= bodyVel.x * inertiaFactor;
    gravity.z -= bodyVel.z * inertiaFactor;

    // Angular velocity causes tail to swing outward
    const angularSway = this.angularVelocity
      .clone()
      .multiplyScalar(PHYSICS_CONFIG.tail.angularSwayScale);
    gravity.x += angularSway.x;
    gravity.z += angularSway.z;

    // 5. Simulate each chain
    for (let i = 0; i < this.chains.length; i++) {
      const chain = this.chains[i];
      const phase = i * 2.1;
      const side = i % 2 === 0 ? 1 : -1;

      // Idle sway using smooth noise
      const swayNoise = smoothNoise(this.t * 0.5 + phase, 0);
      const idleSwayX =
        swayNoise * PHYSICS_CONFIG.tail.idleSwayAmp +
        Math.sin(this.t * 0.7 + phase) * PHYSICS_CONFIG.tail.idleSwaySineAmp;
      const idleSwayZ =
        smoothNoise(this.t * 0.4 + phase + 10, 1) * PHYSICS_CONFIG.tail.idleSwayZAmp;

      // Wagging (stronger at tip)
      const wagX = Math.sin(this.wagPhase + phase) * wagAmp;
      const wagZ =
        Math.cos(this.wagPhase * 0.7 + phase * 1.2) * wagAmp * PHYSICS_CONFIG.tail.wagZScale;

      // Follow-through: tail continues moving in the direction of body rotation
      const followThroughX = this.angularVelocity.z * PHYSICS_CONFIG.tail.followThroughScale;
      const followThroughZ = -this.angularVelocity.x * PHYSICS_CONFIG.tail.followThroughScale;

      for (let j = 0; j < chain.length; j++) {
        if (j === 0) continue; // Root is pinned
        const bone = chain.bones[j];
        const ratio = j / (chain.length - 1);
        const tipMul = PHYSICS_CONFIG.tail.tipForceBase + ratio * PHYSICS_CONFIG.tail.tipForceSpan;

        // Combined force
        const fx = (idleSwayX + wagX * side + followThroughX) * tipMul;
        const fy =
          opts?.flutter === false
            ? 0
            : smoothNoise(this.t * 1.2 + j, 3 + i) * PHYSICS_CONFIG.tail.flutterYAmp * tipMul;
        const fz = (idleSwayZ + wagZ * side + followThroughZ) * tipMul;

        bone.applyForce(new THREE.Vector3(fx, fy, fz));

        // Lower stiffness when wagging for more organic motion
        if (isHappy) {
          bone.stiffness = Math.max(
            PHYSICS_CONFIG.tail.wagMinStiffness,
            bone.stiffness - dt * PHYSICS_CONFIG.tail.wagStiffnessDecay,
          );
        }
      }

      chain.simulate(dt, gravity, bodyVel, opts?.iterations ?? PHYSICS_CONFIG.tail.iterations);

      const body = opts?.body;
      if (body) {
        const colliders = opts?.colliders ?? "full";
        for (let j = 0; j < chain.length; j++) {
          body.collideBone(chain.bones[j], PHYSICS_CONFIG.bone.collisionPush, colliders);
        }
      }
    }
  }

  private getStateIntensity(animState: string): number {
    return stateMotion(PHYSICS_CONFIG.tail.stateIntensity, animState);
  }

  reset(): void {
    this.t = 0;
    this.wagPhase = 0;
    for (const chain of this.chains) {
      chain.reset();
    }
    if (this.hips) {
      this.prevHipsPos.setFromMatrixPosition(this.hips.matrixWorld);
      this.prevHipsQuat.copy(this.hips.quaternion);
    }
    this.angularVelocity.set(0, 0, 0);
  }

  /**
   * Choreography inertia — the tail follows the hips' world motion with a
   * lagged, damped response (heavier than hair, so a lower family gain).
   */
  applyHipInertia(drive: HipInertiaDrive): void {
    if (!this._hasTail) return;
    hipInertiaChains(
      this.chains,
      PHYSICS_CONFIG.tail.impulseTipBase,
      PHYSICS_CONFIG.tail.impulseTipSpan,
      PHYSICS_CONFIG.global.hipInertia.familyGain.tail,
      drive,
    );
  }

  /** Impulse applied to every non-root tail bone (beat reactions, pokes). */
  applyImpulse(force: THREE.Vector3): void {
    if (!this._hasTail) return;
    for (const chain of this.chains) {
      for (let j = 1; j < chain.length; j++) {
        const ratio = j / chain.length;
        chain.bones[j].applyForce(
          force
            .clone()
            .multiplyScalar(
              PHYSICS_CONFIG.tail.impulseTipBase + ratio * PHYSICS_CONFIG.tail.impulseTipSpan,
            ),
        );
      }
    }
  }

  /** Directional poke — the tail whips away from the touch point. */
  applyImpulseAt(
    at: THREE.Vector3,
    radius: number = PHYSICS_CONFIG.tail.pokeRadius,
    strength: number = PHYSICS_CONFIG.tail.pokeStrength,
  ): void {
    if (!this._hasTail) return;
    impulseChainsAt(this.chains, at, radius, strength);
  }

  /**
   * Continuous pointer-drag spring — tail segments near the grab point are
   * pulled toward the projected pointer target (see dragChainsAt). Called
   * once per fixed substep by SecondaryPhysicsManager while a drag is active.
   */
  applyDragAt(target: THREE.Vector3, anchor: THREE.Vector3): void {
    if (!this._hasTail) return;
    const cfg = PHYSICS_CONFIG.drag;
    dragChainsAt(this.chains, target, anchor, cfg.radius, cfg.strength, cfg.maxForce);
  }

  dispose(): void {
    this.chains = [];
    this._hasTail = false;
  }
}
