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
import { PHYSICS_CONFIG, stateMotion, type ColliderSet } from "../physicsConfig";
import type { BodyColliders } from "./BodyColliders";

/**
 * AccessoryPhysics — spring-damper physics for dangling items.
 *
 * Handles ribbons, bows, pendants, necklaces, charms, tassels, and other
 * decorative elements that should sway and dangle with movement.
 * Uses simple spring-damper with high damping to prevent excessive wobble
 * while maintaining responsive follow-through.
 *
 * Features:
 *   • Single and double-bone spring physics
 *   • High damping for stable motion (no jitter)
 *   • Delayed follow-through (accessories react slightly later than body)
 *   • Collision with body to prevent clipping
 *   • Subtle idle sway from breathing
 */
export class AccessoryPhysics {
  /** Physics chains for accessories (usually 1-2 bone chains). */
  private chains: PhysicsBoneChain[] = [];
  /** Body bones for velocity tracking. */
  private headBone: THREE.Object3D | null = null;
  private chestBone: THREE.Object3D | null = null;
  /** Previous frame positions. */
  private prevHeadPos = new THREE.Vector3();
  private prevChestPos = new THREE.Vector3();
  /** Body velocity (blended from multiple sources). */
  private bodyVelocity = new THREE.Vector3();
  /** Elapsed time. */
  private t = 0;
  /** Whether accessory bones were found. */
  private _hasAccessories = false;

  constructor(private vrm: VRM) {
    this.initialize();
  }

  /** Whether accessory physics bones were found. */
  get hasAccessories(): boolean {
    return this._hasAccessories;
  }

  get chainCount(): number {
    return this.chains.length;
  }

  private initialize(): void {
    const classifier = new BoneClassifier(this.vrm);
    const accessoryChains = classifier.getChainsByCategory("accessory");

    // Also handle ear bones (animal ears get their own physics)
    const earChains = classifier.getChainsByCategory("ear");

    if (accessoryChains.length === 0 && earChains.length === 0) {
      this._hasAccessories = false;
      return;
    }

    this.headBone = classifier.head;
    this.chestBone = classifier.chest;

    if (this.headBone) {
      this.prevHeadPos.setFromMatrixPosition(this.headBone.matrixWorld);
    }
    if (this.chestBone) {
      this.prevChestPos.setFromMatrixPosition(this.chestBone.matrixWorld);
    }

    // Build accessory chains
    for (const chain of accessoryChains) {
      const physicsChain = this.buildChain(chain, "accessory");
      if (physicsChain) {
        this.chains.push(physicsChain);
      }
    }

    // Build ear chains with ear-specific parameters
    for (const chain of earChains) {
      const physicsChain = this.buildChain(chain, "ear");
      if (physicsChain) {
        this.chains.push(physicsChain);
      }
    }

    this._hasAccessories = this.chains.length > 0;
  }

  private buildChain(
    classifiedChain: ClassifiedBone[],
    kind: "accessory" | "ear",
  ): PhysicsBoneChain | null {
    if (classifiedChain.length < 1) return null;

    const isEar = kind === "ear";
    const isSingleBone = classifiedChain.length === 1;

    // For single-bone accessories, create a virtual parent chain
    const physicsBones: PhysicsBone[] = [];
    let prevPhysicsBone: PhysicsBone | null = null;

    for (let i = 0; i < classifiedChain.length; i++) {
      const cb = classifiedChain[i];
      const bone = cb.bone;

      const worldPos = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);

      let restOffset = new THREE.Vector3();
      if (bone.parent) {
        const parentWorldPos = new THREE.Vector3().setFromMatrixPosition(bone.parent.matrixWorld);
        restOffset = new THREE.Vector3().subVectors(worldPos, parentWorldPos);
        if (restOffset.lengthSq() < 0.0001) {
          restOffset.set(0, isEar ? 0.04 : -0.03, isEar ? 0 : 0);
        }
      } else {
        restOffset.set(0, -0.03, 0);
      }

      const pb: PhysicsBone = new PhysicsBone(bone, prevPhysicsBone, worldPos, restOffset);

      if (isEar) {
        // Ears: responsive with subtle twitch
        if (i === 0) {
          pb.stiffness = PHYSICS_CONFIG.accessories.ear.root.stiffness;
          pb.damping = PHYSICS_CONFIG.accessories.ear.root.damping;
          pb.gravityInfluence = PHYSICS_CONFIG.accessories.ear.root.gravityInfluence;
          pb.airResistance = PHYSICS_CONFIG.accessories.ear.root.airResistance;
        } else if (i === classifiedChain.length - 1) {
          pb.stiffness = PHYSICS_CONFIG.accessories.ear.tip.stiffness;
          pb.damping = PHYSICS_CONFIG.accessories.ear.tip.damping;
          pb.gravityInfluence = PHYSICS_CONFIG.accessories.ear.tip.gravityInfluence;
          pb.airResistance = PHYSICS_CONFIG.accessories.ear.tip.airResistance;
        } else {
          pb.stiffness = PHYSICS_CONFIG.accessories.ear.mid.stiffness;
          pb.damping = PHYSICS_CONFIG.accessories.ear.mid.damping;
          pb.gravityInfluence = PHYSICS_CONFIG.accessories.ear.mid.gravityInfluence;
          pb.airResistance = PHYSICS_CONFIG.accessories.ear.mid.airResistance;
        }
      } else {
        // Accessories: damped with delayed response
        if (i === 0) {
          pb.stiffness = PHYSICS_CONFIG.accessories.accessory.root.stiffness;
          pb.damping = PHYSICS_CONFIG.accessories.accessory.root.damping;
          pb.gravityInfluence = PHYSICS_CONFIG.accessories.accessory.root.gravityInfluence;
          pb.airResistance = PHYSICS_CONFIG.accessories.accessory.root.airResistance;
        } else {
          pb.stiffness = PHYSICS_CONFIG.accessories.accessory.mid.stiffness;
          pb.damping = PHYSICS_CONFIG.accessories.accessory.mid.damping;
          pb.gravityInfluence = PHYSICS_CONFIG.accessories.accessory.mid.gravityInfluence;
          pb.airResistance = PHYSICS_CONFIG.accessories.accessory.mid.airResistance;
        }
      }

      // Side offset for natural asymmetry
      const side = cb.side;
      if (side !== 0) {
        pb.applyForce(new THREE.Vector3(side * PHYSICS_CONFIG.accessories.sideForce, 0, 0));
      }

      physicsBones.push(pb);
      prevPhysicsBone = pb;
    }

    return new PhysicsBoneChain(physicsBones);
  }

  /**
   * Update accessory and ear physics.
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
    if (!this._hasAccessories) return;

    dt = Math.min(dt, PHYSICS_CONFIG.global.dtClamp);
    this.t += dt;

    // 1. Compute body velocity
    const bodyVel = new THREE.Vector3();
    if (this.headBone) {
      const headPos = new THREE.Vector3().setFromMatrixPosition(this.headBone.matrixWorld);
      const headVel = new THREE.Vector3()
        .subVectors(headPos, this.prevHeadPos)
        .divideScalar(Math.max(dt, 0.001));
      headVel.clampLength(0, PHYSICS_CONFIG.accessories.velocityClamp);
      this.prevHeadPos.copy(headPos);
      bodyVel.lerp(headVel, PHYSICS_CONFIG.accessories.headVelLerp);
    }
    if (this.chestBone) {
      const chestPos = new THREE.Vector3().setFromMatrixPosition(this.chestBone.matrixWorld);
      const chestVel = new THREE.Vector3()
        .subVectors(chestPos, this.prevChestPos)
        .divideScalar(Math.max(dt, 0.001));
      chestVel.clampLength(0, PHYSICS_CONFIG.accessories.velocityClamp);
      this.prevChestPos.copy(chestPos);
      bodyVel.lerp(chestVel, PHYSICS_CONFIG.accessories.chestVelLerp);
    }
    this.bodyVelocity.copy(bodyVel);

    // 2. Motion intensity from state
    const stateMotion = this.getStateIntensity(animState);

    // 3. Gravity with inertia
    const gravity = getGravity().clone();
    const inertiaFactor = PHYSICS_CONFIG.accessories.inertiaFactor;
    gravity.x -= this.bodyVelocity.x * inertiaFactor;
    gravity.z -= this.bodyVelocity.z * inertiaFactor;

    // 4. Simulate each chain
    for (let i = 0; i < this.chains.length; i++) {
      const chain = this.chains[i];
      const phase = i * 2.3;

      // Determine if this is an ear by checking stiffness
      const firstBone = chain.bones[0];
      const isEar =
        firstBone &&
        firstBone.stiffness >= PHYSICS_CONFIG.accessories.earIsEarStiffness &&
        firstBone.gravityInfluence <= PHYSICS_CONFIG.accessories.earIsEarGravity;

      if (isEar) {
        // Ears: subtle twitch at idle, responsive to head movement
        const twitchFreq =
          PHYSICS_CONFIG.accessories.earTwitchFreqBase +
          stateMotion * PHYSICS_CONFIG.accessories.earTwitchFreqMotion;
        const twitchAmp =
          PHYSICS_CONFIG.accessories.earTwitchAmpBase +
          stateMotion * PHYSICS_CONFIG.accessories.earTwitchAmpMotion;

        for (let j = 0; j < chain.length; j++) {
          if (j === 0) continue;
          const bone = chain.bones[j];
          const ratio = j / (chain.length - 1);
          const tipMul =
            PHYSICS_CONFIG.accessories.earTipBase + ratio * PHYSICS_CONFIG.accessories.earTipSpan;

          const flutterScale = opts?.flutter === false ? 0 : 1;
          const earTwitchX =
            Math.sin(this.t * twitchFreq + phase) * twitchAmp * tipMul * flutterScale;
          const earTwitchZ =
            Math.cos(this.t * (twitchFreq * 0.7) + phase * 1.3) *
            twitchAmp *
            PHYSICS_CONFIG.accessories.earTwitchZScale *
            tipMul *
            flutterScale;

          bone.applyForce(new THREE.Vector3(earTwitchX, 0, earTwitchZ));
        }
      } else {
        // Accessories: gentle sway
        const swayAmp =
          PHYSICS_CONFIG.accessories.accSwayAmpBase +
          stateMotion * PHYSICS_CONFIG.accessories.accSwayAmpMotion;

        for (let j = 0; j < chain.length; j++) {
          if (j === 0) continue;
          const bone = chain.bones[j];
          const ratio = j / Math.max(1, chain.length - 1);
          const tipMul =
            PHYSICS_CONFIG.accessories.accTipBase + ratio * PHYSICS_CONFIG.accessories.accTipSpan;

          const swayX = organicWave(this.t * 0.8, 0.5 + i * 0.04, swayAmp, phase) * tipMul;
          const swayZ =
            organicWave(this.t * 0.8 + 1.2, 0.4 + i * 0.03, swayAmp * 0.6, phase + 2.0) * tipMul;
          const bounceY =
            opts?.flutter === false
              ? 0
              : organicWave(this.t * 1.3, 1.5 + i * 0.1, swayAmp * 0.5, phase * 1.5) * tipMul;

          bone.applyForce(new THREE.Vector3(swayX, bounceY, swayZ));
        }
      }

      chain.simulate(
        dt,
        gravity,
        this.bodyVelocity,
        opts?.iterations ?? PHYSICS_CONFIG.accessories.iterations,
      );

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
    return stateMotion(PHYSICS_CONFIG.accessories.stateIntensity, animState);
  }

  reset(): void {
    this.t = 0;
    for (const chain of this.chains) {
      chain.reset();
    }
    if (this.headBone) this.prevHeadPos.setFromMatrixPosition(this.headBone.matrixWorld);
    if (this.chestBone) this.prevChestPos.setFromMatrixPosition(this.chestBone.matrixWorld);
    this.bodyVelocity.set(0, 0, 0);
  }

  /**
   * Choreography inertia — earrings, ribbons and dangling baubles swing with the
   * hips' world motion (they hang from a moving body, so they trail it).
   */
  applyHipInertia(drive: HipInertiaDrive): void {
    if (!this._hasAccessories) return;
    hipInertiaChains(
      this.chains,
      PHYSICS_CONFIG.accessories.impulseTipBase,
      PHYSICS_CONFIG.accessories.impulseTipSpan,
      PHYSICS_CONFIG.global.hipInertia.familyGain.accessories,
      drive,
    );
  }

  /** Impulse applied to every non-root accessory bone (beat reactions, pokes). */
  applyImpulse(force: THREE.Vector3): void {
    if (!this._hasAccessories) return;
    for (const chain of this.chains) {
      for (let j = 1; j < chain.length; j++) {
        const ratio = j / chain.length;
        chain.bones[j].applyForce(
          force
            .clone()
            .multiplyScalar(
              PHYSICS_CONFIG.accessories.impulseTipBase +
                ratio * PHYSICS_CONFIG.accessories.impulseTipSpan,
            ),
        );
      }
    }
  }

  /** Directional poke — accessories bounce away from the touch point. */
  applyImpulseAt(
    at: THREE.Vector3,
    radius: number = PHYSICS_CONFIG.accessories.pokeRadius,
    strength: number = PHYSICS_CONFIG.accessories.pokeStrength,
  ): void {
    if (!this._hasAccessories) return;
    impulseChainsAt(this.chains, at, radius, strength);
  }

  /**
   * Continuous pointer-drag spring — ears and dangling accessories near the
   * grab point are pulled toward the projected pointer target (see
   * dragChainsAt). Called once per fixed substep by SecondaryPhysicsManager
   * while a drag is active (also as a rider on hair/tail grabs).
   */
  applyDragAt(target: THREE.Vector3, anchor: THREE.Vector3): void {
    if (!this._hasAccessories) return;
    const cfg = PHYSICS_CONFIG.drag;
    dragChainsAt(this.chains, target, anchor, cfg.radius, cfg.strength, cfg.maxForce);
  }

  dispose(): void {
    this.chains = [];
    this._hasAccessories = false;
  }
}
