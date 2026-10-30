import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { BoneClassifier, type ClassifiedBone } from "./BoneClassifier";
import {
  PhysicsBone,
  PhysicsBoneChain,
  organicWave,
  getGravity,
  impulseChainsAt,
  dragChainsAt,
  hipInertiaChains,
  type HipInertiaDrive,
} from "./PhysicsBone";
import { PHYSICS_CONFIG, stateMotion } from "../physicsConfig";
import type { BodyColliders } from "./BodyColliders";
import type { ColliderSet } from "../physicsConfig";

/**
 * HairPhysics — realistic hair secondary motion using Verlet integration.
 *
 * Simulates each hair strand as a chain of spring-damper bones.
 * Hair lags behind head movement, reacts to body motion, and includes
 * natural flutter and sway from idle breathing.
 *
 * Features:
 *   • Verlet integration with distance constraints
 *   • Head-collision avoidance
 *   • Motion inheritance from head velocity
 *   • Per-strand phase offset for natural variety
 *   • Tunable stiffness, damping, and gravity per hair type
 */
export class HairPhysics {
  /** Physics chains (one per hair strand/tail). */
  private chains: PhysicsBoneChain[] = [];
  /** The head bone used for collision and velocity tracking. */
  private headBone: THREE.Object3D | null = null;
  /** Previous frame head position for velocity computation. */
  private prevHeadPos = new THREE.Vector3();
  /** Current head velocity. */
  private headVelocity = new THREE.Vector3();
  /** Elapsed time for organic wave functions. */
  private t = 0;
  /** Whether any hair bones were found. */
  private _hasHair = false;

  // Hot-loop scratch — update() owns these exclusively (no nested calls).
  private _headPos = new THREE.Vector3();
  private _gravity = new THREE.Vector3();
  private _force = new THREE.Vector3();
  private _speed = new THREE.Vector3();

  constructor(private vrm: VRM) {
    this.initialize();
  }

  /** Whether hair physics bones were found and initialized. */
  get hasHair(): boolean {
    return this._hasHair;
  }

  /** Number of active hair chains. */
  get chainCount(): number {
    return this.chains.length;
  }

  /**
   * Mean Verlet speed of the non-root hair points — an observable proxy for
   * "is the simulation alive" (diagnostics/e2e). Resting hair sits near zero,
   * dances and beat kicks spike it.
   */
  get energy(): number {
    return this.lastEnergy;
  }
  private lastEnergy = 0;

  private initialize(): void {
    const classifier = new BoneClassifier(this.vrm);
    const hairChains = classifier.getChainsByCategory("hair");

    if (hairChains.length === 0) {
      this._hasHair = false;
      return;
    }

    this.headBone = classifier.head;
    if (this.headBone) {
      this.prevHeadPos.setFromMatrixPosition(this.headBone.matrixWorld);
    }

    for (const chain of hairChains) {
      const physicsChain = this.buildChain(chain);
      if (physicsChain) {
        this.chains.push(physicsChain);
      }
    }

    this._hasHair = this.chains.length > 0;
  }

  /**
   * Build a PhysicsBoneChain from a classified bone chain.
   */
  private buildChain(classifiedChain: ClassifiedBone[]): PhysicsBoneChain | null {
    if (classifiedChain.length < 2) return null;

    const physicsBones: PhysicsBone[] = [];
    let prevPhysicsBone: PhysicsBone | null = null;

    for (let i = 0; i < classifiedChain.length; i++) {
      const cb = classifiedChain[i];
      const bone = cb.bone;

      // Get world position of this bone
      const worldPos = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);

      // Compute rest offset in local space of parent
      let restOffset = new THREE.Vector3(0, -0.05, 0);
      if (bone.parent) {
        const parentWorldPos = new THREE.Vector3().setFromMatrixPosition(bone.parent.matrixWorld);
        restOffset = new THREE.Vector3().subVectors(worldPos, parentWorldPos);
        if (restOffset.lengthSq() < 0.0001) {
          restOffset.set(0, -0.05 * (i + 1), 0);
        }
      }

      const pb: PhysicsBone = new PhysicsBone(bone, prevPhysicsBone, worldPos, restOffset);

      // Tune parameters based on position in chain
      const tuning = PHYSICS_CONFIG.hair.boneTuning;
      if (i === 0) {
        // Root hair: stiffer, less gravity
        pb.stiffness = tuning.root.stiffness;
        pb.damping = tuning.root.damping;
        pb.gravityInfluence = tuning.root.gravityInfluence;
        pb.airResistance = tuning.root.airResistance;
      } else if (i === classifiedChain.length - 1) {
        // Tip hair: most loose, most gravity
        pb.stiffness = tuning.tip.stiffness;
        pb.damping = tuning.tip.damping;
        pb.gravityInfluence = tuning.tip.gravityInfluence;
        pb.airResistance = tuning.tip.airResistance;
      } else {
        // Mid hair: moderate
        const ratio = i / (classifiedChain.length - 1);
        pb.stiffness = tuning.mid.stiffnessBase - ratio * tuning.mid.stiffnessSpan;
        pb.damping = tuning.mid.dampingBase - ratio * tuning.mid.dampingSpan;
        pb.gravityInfluence = tuning.mid.gravityBase + ratio * tuning.mid.gravitySpan;
        pb.airResistance = tuning.mid.airBase + ratio * tuning.mid.airSpan;
      }

      // Side-based offset for natural asymmetry
      const side = cb.side;
      pb.applyForce(new THREE.Vector3(side * PHYSICS_CONFIG.hair.sideForce, 0, 0));

      physicsBones.push(pb);
      prevPhysicsBone = pb;
    }

    return new PhysicsBoneChain(physicsBones);
  }

  /**
   * Update hair physics.
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
    if (!this._hasHair) return;

    dt = Math.min(dt, PHYSICS_CONFIG.global.dtClamp);
    this.t += dt;

    // 1. Compute head velocity
    if (this.headBone) {
      const headPos = this._headPos.setFromMatrixPosition(this.headBone.matrixWorld);
      this.headVelocity.subVectors(headPos, this.prevHeadPos).divideScalar(Math.max(dt, 0.001));
      // Clamp velocity to prevent explosions
      this.headVelocity.clampLength(0, PHYSICS_CONFIG.hair.velocityClamp);
      this.prevHeadPos.copy(headPos);
    }

    // 2. Determine motion intensity from state
    const stateMotion = this.getStateIntensity(animState);

    // 3. Compute gravity with head-motion influence (instance scratch — the
    //    shared gravity vector must never be mutated)
    const gravity = this._gravity.copy(getGravity());

    // Add inertia from head movement (opposite direction of head acceleration)
    const inertiaFactor = PHYSICS_CONFIG.hair.inertiaFactor;
    gravity.x -= this.headVelocity.x * inertiaFactor;
    gravity.z -= this.headVelocity.z * inertiaFactor;

    // 4. Add organic sway force
    const swayAmp =
      PHYSICS_CONFIG.hair.swayAmpBase + stateMotion * PHYSICS_CONFIG.hair.swayAmpMotion;
    const flutterAmp =
      opts?.flutter === false
        ? 0
        : PHYSICS_CONFIG.hair.flutterAmpBase + stateMotion * PHYSICS_CONFIG.hair.flutterAmpMotion;

    // 5. Simulate each chain
    for (let i = 0; i < this.chains.length; i++) {
      const chain = this.chains[i];
      const phase = i * 1.37;

      // Per-chain organic wind force
      const swayX = organicWave(this.t, 0.8 + i * 0.05, swayAmp, phase);
      const swayZ = organicWave(this.t + 2.0, 0.6 + i * 0.04, swayAmp * 0.7, phase);
      const flutterDY = organicWave(this.t * 1.5, 2.3 + i * 0.1, flutterAmp, phase * 1.3);

      // Apply as external force to each bone in chain
      for (let j = 0; j < chain.length; j++) {
        const bone = chain.bones[j];
        const ratio = j / chain.length;
        const tipMultiplier =
          PHYSICS_CONFIG.hair.tipForceBase + ratio * PHYSICS_CONFIG.hair.tipForceSpan;

        // Skip root bone (it's pinned to head)
        if (j === 0) continue;

        bone.applyForce(
          this._force.set(swayX * tipMultiplier, flutterDY * tipMultiplier, swayZ * tipMultiplier),
        );
      }

      // Simulate the chain
      chain.simulate(
        dt,
        gravity,
        this.headVelocity,
        opts?.iterations ?? PHYSICS_CONFIG.hair.iterations,
      );

      // Body collision (skip root bone)
      const body = opts?.body;
      if (body) {
        const colliders = opts?.colliders ?? "full";
        for (let j = 1; j < chain.length; j++) {
          body.collideBone(chain.bones[j], PHYSICS_CONFIG.hair.headCollisionPush, colliders);
        }
      }
    }

    // Observable simulation energy (mean speed across non-root points).
    let speedSum = 0;
    let count = 0;
    for (const chain of this.chains) {
      for (let j = 1; j < chain.length; j++) {
        speedSum += this._speed
          .subVectors(chain.bones[j].position, chain.bones[j].previous)
          .length();
        count++;
      }
    }
    this.lastEnergy = count > 0 ? speedSum / count : 0;
  }

  /**
   * Map animation state to motion intensity (0–1).
   */
  private getStateIntensity(animState: string): number {
    return stateMotion(PHYSICS_CONFIG.hair.stateIntensity, animState);
  }

  /**
   * Choreography inertia — the PRIMARY dance force. Reads the hip drive (built
   * from the hips' world motion) and pushes every strand the opposite way, with
   * the tail of each strand reacting most. Called once per fixed substep.
   */
  applyHipInertia(drive: HipInertiaDrive): void {
    if (!this._hasHair) return;
    hipInertiaChains(
      this.chains,
      PHYSICS_CONFIG.hair.impulseTipBase,
      PHYSICS_CONFIG.hair.impulseTipSpan,
      PHYSICS_CONFIG.global.hipInertia.familyGain.hair,
      drive,
    );
  }

  /**
   * Impulse applied to every non-root hair bone (beat reactions, pokes).
   * Force units are small — Verlet integrates acceleration × dt².
   */
  applyImpulse(force: THREE.Vector3): void {
    if (!this._hasHair) return;
    for (const chain of this.chains) {
      for (let j = 1; j < chain.length; j++) {
        const ratio = j / chain.length;
        chain.bones[j].applyForce(
          this._force
            .copy(force)
            .multiplyScalar(
              PHYSICS_CONFIG.hair.impulseTipBase + ratio * PHYSICS_CONFIG.hair.impulseTipSpan,
            ),
        );
      }
    }
  }

  /**
   * Directional poke — pushes strands away from a world-space touch point
   * with quadratic falloff. Only strands near the finger react strongly.
   */
  applyImpulseAt(
    at: THREE.Vector3,
    radius: number = PHYSICS_CONFIG.hair.pokeRadius,
    strength: number = PHYSICS_CONFIG.hair.pokeStrength,
  ): void {
    if (!this._hasHair) return;
    impulseChainsAt(this.chains, at, radius, strength);
  }

  /**
   * Continuous pointer-drag spring — strands near the grab point are pulled
   * toward the projected pointer target (see dragChainsAt). Called once per
   * fixed substep by SecondaryPhysicsManager while a drag is active.
   */
  applyDragAt(target: THREE.Vector3, anchor: THREE.Vector3): void {
    if (!this._hasHair) return;
    const cfg = PHYSICS_CONFIG.drag;
    dragChainsAt(this.chains, target, anchor, cfg.radius, cfg.strength, cfg.maxForce);
  }

  /** Reset all hair physics to rest pose. */
  reset(): void {
    this.t = 0;
    for (const chain of this.chains) {
      chain.reset();
    }
    if (this.headBone) {
      this.prevHeadPos.setFromMatrixPosition(this.headBone.matrixWorld);
    }
    this.headVelocity.set(0, 0, 0);
  }

  dispose(): void {
    this.chains = [];
    this._hasHair = false;
  }
}
