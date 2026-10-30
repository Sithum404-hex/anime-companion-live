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
import { QualityTier } from "../performance";

/**
 * ClothPhysics — clothing secondary motion using Verlet integration.
 *
 * Handles skirts, dresses, sleeves, collars, and other loose clothing.
 * Uses spring-damper per bone with higher damping than hair to prevent
 * excessive jiggle. Includes hip-driven inertia for natural skirt sway.
 *
 * Features:
 *   • Verlet integration with distance constraints
 *   • Hip and body velocity tracking for motion inheritance
 *   • Higher gravity than hair for natural drape
 *   • Multiple collision spheres (hips, legs) to reduce clipping
 *   • Tunable stiffness and damping per clothing type (skirt vs sleeve)
 *   • Spin-aware skirt flare — hems pushed outward while the hips actually
 *     spin, decaying back the moment the rotation stops (see updateSpinFlare)
 */
// Spin-flare scratch (applySpinFlare owns it; no nested calls).
const _flareDir = new THREE.Vector3();

export class ClothPhysics {
  /** Physics chains for clothing panels. */
  private chains: PhysicsBoneChain[] = [];
  /** Body bones for velocity tracking. */
  private hips: THREE.Object3D | null = null;
  private chest: THREE.Object3D | null = null;
  /** Previous frame body position. */
  private prevHipsPos = new THREE.Vector3();
  private prevChestPos = new THREE.Vector3();
  /** Body velocity. */
  private bodyVelocity = new THREE.Vector3();
  /** Elapsed time. */
  private t = 0;
  /** Whether cloth bones were found. */
  private _hasCloth = false;
  /** Current quality tier — controls spin-aware flare intensity. */
  private qualityTier: QualityTier = "medium";
  /** Parallel to `chains` — true for skirt/dress panels, the only flare targets. */
  private skirtFlags: boolean[] = [];
  /** Whether at least one skirt panel exists (the flare's fast path). */
  private _hasSkirt = false;
  /** Spin-flare envelope (m/s²); 0 whenever she is not spinning. */
  private _flare = 0;
  /** Hip world position at the moment the flare was evaluated (its axis). */
  private readonly flarePivot = new THREE.Vector3();

  /** Set the active quality tier (called by SecondaryPhysicsManager). */
  setQuality(tier: QualityTier): void {
    this.qualityTier = tier;
  }

  /** Current spin-flare envelope (m/s²) — 0 when she is not spinning. */
  get flareStrength(): number {
    return this._flare;
  }

  /** Number of chains that are skirt/dress panels rather than sleeves. */
  get skirtChainCount(): number {
    let n = 0;
    for (const isSkirt of this.skirtFlags) {
      if (isSkirt) n++;
    }
    return n;
  }

  /**
   * The skirt/dress panels only — the chains the spin flare drives. Allocates,
   * so this is for diagnostics and tests, never for the frame loop.
   */
  get skirtChains(): PhysicsBoneChain[] {
    return this.chains.filter((_, i) => this.skirtFlags[i]);
  }

  /** Hip collision sphere radius. */
  /** Leg collision sphere parameters (approximate). */

  constructor(private vrm: VRM) {
    this.initialize();
  }

  /** Whether cloth physics bones were found. */
  get hasCloth(): boolean {
    return this._hasCloth;
  }

  get chainCount(): number {
    return this.chains.length;
  }

  private initialize(): void {
    const classifier = new BoneClassifier(this.vrm);
    const clothChains = classifier.getChainsByCategory("cloth");

    if (clothChains.length === 0) {
      this._hasCloth = false;
      return;
    }

    this.hips = classifier.hips;
    this.chest = classifier.chest;

    if (this.hips) {
      this.prevHipsPos.setFromMatrixPosition(this.hips.matrixWorld);
    }
    if (this.chest) {
      this.prevChestPos.setFromMatrixPosition(this.chest.matrixWorld);
    }

    // Classify chains as skirt-like (from hips) or sleeve-like (from shoulders)
    for (const chain of clothChains) {
      const physicsChain = this.buildChain(chain);
      if (physicsChain) {
        this.chains.push(physicsChain);
        this.skirtFlags.push(ClothPhysics.isSkirtChain(chain));
      }
    }

    this._hasCloth = this.chains.length > 0;
    this._hasSkirt = this.skirtFlags.some(Boolean);
  }

  /**
   * A panel is skirt-like when its chain root names a skirt (hips-anchored)
   * rather than a sleeve/collar (shoulder-anchored). Shared by `buildChain`
   * (which tunes stiffness) and `initialize` (which records the flare flag).
   */
  private static isSkirtChain(chain: ClassifiedBone[]): boolean {
    const rootName = chain[0].name.toLowerCase();
    return (
      rootName.includes("skirt") ||
      rootName.includes("dress") ||
      rootName.includes("hem") ||
      rootName.includes("裾") ||
      rootName.includes("apron")
    );
  }

  /**
   * Build a PhysicsBoneChain from classified cloth bones.
   */
  private buildChain(classifiedChain: ClassifiedBone[]): PhysicsBoneChain | null {
    if (classifiedChain.length < 2) return null;

    // Determine if this is a skirt (originates near hips) or sleeve (originates near arms)
    const isSkirt = ClothPhysics.isSkirtChain(classifiedChain);

    const physicsBones: PhysicsBone[] = [];
    let prevPhysicsBone: PhysicsBone | null = null;

    for (let i = 0; i < classifiedChain.length; i++) {
      const cb = classifiedChain[i];
      const bone = cb.bone;

      const worldPos = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);

      let restOffset = new THREE.Vector3(0, -0.04, 0);
      if (bone.parent) {
        const parentWorldPos = new THREE.Vector3().setFromMatrixPosition(bone.parent.matrixWorld);
        restOffset = new THREE.Vector3().subVectors(worldPos, parentWorldPos);
        if (restOffset.lengthSq() < 0.0001) {
          restOffset.set(0, -0.04 * (i + 1), 0);
        }
      }

      const pb: PhysicsBone = new PhysicsBone(bone, prevPhysicsBone, worldPos, restOffset);

      // Tune based on clothing type
      const skirtCfg = PHYSICS_CONFIG.cloth.skirt;
      const sleeveCfg = PHYSICS_CONFIG.cloth.sleeve;
      if (isSkirt) {
        // Skirt: heavier, more gravity, moderate stiffness
        if (i === 0) {
          pb.stiffness = skirtCfg.root.stiffness;
          pb.damping = skirtCfg.root.damping;
          pb.gravityInfluence = skirtCfg.root.gravityInfluence;
          pb.airResistance = skirtCfg.root.airResistance;
        } else if (i === classifiedChain.length - 1) {
          pb.stiffness = skirtCfg.tip.stiffness;
          pb.damping = skirtCfg.tip.damping;
          pb.gravityInfluence = skirtCfg.tip.gravityInfluence;
          pb.airResistance = skirtCfg.tip.airResistance;
        } else {
          const ratio = i / (classifiedChain.length - 1);
          pb.stiffness = skirtCfg.mid.stiffnessBase - ratio * skirtCfg.mid.stiffnessSpan;
          pb.damping = skirtCfg.mid.dampingBase - ratio * skirtCfg.mid.dampingSpan;
          pb.gravityInfluence = skirtCfg.mid.gravityBase + ratio * skirtCfg.mid.gravitySpan;
          pb.airResistance = skirtCfg.mid.airBase + ratio * skirtCfg.mid.airSpan;
        }
      } else {
        // Sleeve/collar: lighter, less gravity, responsive
        if (i === 0) {
          pb.stiffness = sleeveCfg.root.stiffness;
          pb.damping = sleeveCfg.root.damping;
          pb.gravityInfluence = sleeveCfg.root.gravityInfluence;
          pb.airResistance = sleeveCfg.root.airResistance;
        } else {
          const ratio = i / (classifiedChain.length - 1);
          pb.stiffness = sleeveCfg.mid.stiffnessBase - ratio * sleeveCfg.mid.stiffnessSpan;
          pb.damping = sleeveCfg.mid.dampingBase - ratio * sleeveCfg.mid.dampingSpan;
          pb.gravityInfluence = sleeveCfg.mid.gravityBase + ratio * sleeveCfg.mid.gravitySpan;
          pb.airResistance = sleeveCfg.mid.airBase + ratio * sleeveCfg.mid.airSpan;
        }
      }

      // Side-based offset
      const side = cb.side;
      if (side !== 0) {
        pb.applyForce(new THREE.Vector3(side * PHYSICS_CONFIG.cloth.sideForce, 0, 0));
      }

      physicsBones.push(pb);
      prevPhysicsBone = pb;
    }

    return new PhysicsBoneChain(physicsBones);
  }

  /**
   * Update cloth physics.
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
    if (!this._hasCloth) return;

    dt = Math.min(dt, PHYSICS_CONFIG.global.dtClamp);
    this.t += dt;

    // 1. Compute body velocity from hip movement
    const bodyVel = new THREE.Vector3();
    if (this.hips) {
      const hipsPos = new THREE.Vector3().setFromMatrixPosition(this.hips.matrixWorld);
      bodyVel.subVectors(hipsPos, this.prevHipsPos).divideScalar(Math.max(dt, 0.001));
      bodyVel.clampLength(0, PHYSICS_CONFIG.cloth.velocityClamp);
      this.prevHipsPos.copy(hipsPos);

      // Blend with chest velocity if available
      if (this.chest) {
        const chestPos = new THREE.Vector3().setFromMatrixPosition(this.chest.matrixWorld);
        const chestVel = new THREE.Vector3()
          .subVectors(chestPos, this.prevChestPos)
          .divideScalar(Math.max(dt, 0.001));
        chestVel.clampLength(0, PHYSICS_CONFIG.cloth.velocityClamp);
        this.prevChestPos.copy(chestPos);
        bodyVel.lerp(chestVel, PHYSICS_CONFIG.cloth.chestVelLerp);
      }
    }
    this.bodyVelocity.copy(bodyVel);

    // 2. Compute motion intensity from state
    const stateMotion = this.getStateIntensity(animState);

    // 3. Gravity with body inertia
    const gravity = getGravity().clone();
    const inertiaFactor = PHYSICS_CONFIG.cloth.inertiaFactor;
    gravity.x -= this.bodyVelocity.x * inertiaFactor;
    gravity.z -= this.bodyVelocity.z * inertiaFactor;

    // Skirt-specific: add slight outward push from hip movement
    const hipSway = organicWave(
      this.t,
      0.5,
      PHYSICS_CONFIG.cloth.hipSwayAmpBase + stateMotion * PHYSICS_CONFIG.cloth.hipSwayAmpMotion,
    );
    gravity.x += hipSway;

    // 4. Simulate each chain
    for (let i = 0; i < this.chains.length; i++) {
      const chain = this.chains[i];
      const phase = i * 1.73;

      // Organic wind for cloth (gentler than hair)
      const windX = organicWave(
        this.t * 0.7,
        0.4 + i * 0.03,
        PHYSICS_CONFIG.cloth.windXAmpBase + stateMotion * PHYSICS_CONFIG.cloth.windXAmpMotion,
        phase,
      );
      const windZ = organicWave(
        this.t * 0.7 + 1.5,
        0.35 + i * 0.02,
        PHYSICS_CONFIG.cloth.windZAmpBase + stateMotion * PHYSICS_CONFIG.cloth.windZAmpMotion,
        phase + 1.0,
      );
      const flutterY = organicWave(
        this.t * 1.2,
        1.8 + i * 0.08,
        opts?.flutter === false
          ? 0
          : PHYSICS_CONFIG.cloth.flutterYAmpBase +
              stateMotion * PHYSICS_CONFIG.cloth.flutterYAmpMotion,
        phase * 1.5,
      );

      for (let j = 0; j < chain.length; j++) {
        if (j === 0) continue;
        const bone = chain.bones[j];
        const ratio = j / chain.length;
        const tipMul =
          PHYSICS_CONFIG.cloth.tipForceBase + ratio * PHYSICS_CONFIG.cloth.tipForceSpan;

        bone.applyForce(
          new THREE.Vector3(
            windX * tipMul,
            flutterY * tipMul * PHYSICS_CONFIG.cloth.flutterYScale,
            windZ * tipMul,
          ),
        );
      }

      // 4a. Spin-aware skirt flare (PROMPT 14) — skirt panels only, and only
      // while the envelope is up (i.e. while she is actually spinning).
      if (this._flare > 0 && this.skirtFlags[i]) this.applySpinFlare(chain);

      chain.simulate(
        dt,
        gravity,
        this.bodyVelocity,
        opts?.iterations ?? PHYSICS_CONFIG.cloth.iterations,
      );

      // Body collision via the shared collider set (see SecondaryPhysicsManager).
      const body = opts?.body;
      if (body) {
        const colliders = opts?.colliders ?? "full";
        for (let j = 0; j < chain.length; j++) {
          body.collideBone(chain.bones[j], PHYSICS_CONFIG.cloth.hipCollisionPush, colliders);
        }
      }
    }
  }

  private getStateIntensity(animState: string): number {
    return stateMotion(PHYSICS_CONFIG.cloth.stateIntensity, animState);
  }

  /**
   * Spin-aware skirt flare — the envelope half (PROMPT 14).
   *
   * Called ONCE per rendered frame by `SecondaryPhysicsManager`, from the same
   * `HipMotionTracker` snapshot the rest of the choreography inertia reads, so
   * every fixed substep of a frame shares one flare strength and the result is
   * identical at 60/90/120 Hz.
   *
   * The flare tracks the hips' |yaw rate|: nothing below `minYawRate` (a slow
   * turn is not a spin), full strength at `fullYawRate`, scaled by the active
   * quality tier — LOW keeps it off entirely — and by the animation state's
   * response. An attack/decay envelope smooths it: quick to build while she
   * spins, slow to release after, which reads as fabric settling rather than
   * snapping back to her legs. The target is zero whenever she is not spinning,
   * so a permanently inflated skirt is impossible by construction.
   *
   * The tracker only ever reads transforms and this only writes forces into the
   * Verlet chains — the choreography itself is never touched.
   *
   * @param dt Frame delta in seconds (clamped internally).
   * @param yawRate Hip yaw rate about world +Y (rad/s; sign-agnostic here).
   * @param pivot Hip world position — the flare's axis origin.
   * @param stateGain Per-state response (dance 1 → idle trace) from the manager.
   */
  updateSpinFlare(dt: number, yawRate: number, pivot: THREE.Vector3, stateGain: number): void {
    if (!this._hasSkirt) return;

    const cfg = PHYSICS_CONFIG.cloth.spinFlare;
    const scale = cfg.tierScale[this.qualityTier] * stateGain;

    const speed = Math.abs(yawRate);
    let target = 0;
    if (scale > 0 && speed > cfg.minYawRate) {
      const ramp = Math.min((speed - cfg.minYawRate) / (cfg.fullYawRate - cfg.minYawRate), 1);
      target = ramp * cfg.strength * scale;
    }

    this.flarePivot.copy(pivot);

    const step = Math.min(dt, PHYSICS_CONFIG.global.dtClamp);
    const tau = target > this._flare ? cfg.attackSec : cfg.decaySec;
    this._flare += (target - this._flare) * (1 - Math.exp(-step / tau));
    // Below 0.4% of full strength the flare is visually gone: snap it to a real
    // zero so "stopped spinning" costs nothing and the skirt cannot stay
    // inflated by a lingering fraction of a m/s².
    if (this._flare < 0.02) this._flare = 0;
  }

  /**
   * Drop the flare immediately (no decay tail) — the caller has decided the
   * spin is over for good, e.g. the dance stopped or the model was swapped.
   */
  clearSpinFlare(): void {
    this._flare = 0;
  }

  /**
   * Apply the current flare outward to one skirt panel.
   *
   * Per bone: envelope × tip weight × clamped(r / radiusRef), pointing away
   * from the hip axis in the XZ plane and clamped to `maxStrength`. Horizontal
   * only — a spin inflates the hem, it does not lift it off her — and
   * allocation-free (module-scoped scratch vector).
   */
  private applySpinFlare(chain: PhysicsBoneChain): void {
    const cfg = PHYSICS_CONFIG.cloth.spinFlare;
    const flare = this._flare;
    const pivot = this.flarePivot;

    for (let j = 1; j < chain.length; j++) {
      const bone = chain.bones[j];
      const ratio = j / chain.length;
      const weight = cfg.tipBase + ratio * cfg.tipSpan;

      const r = _flareDir.subVectors(bone.position, pivot);
      r.y = 0; // outward in the ground plane only
      const radius = r.length();
      if (radius < 1e-4) continue;

      const radial = Math.min(
        Math.max(radius / cfg.radiusRef, cfg.radiusRatioMin),
        cfg.radiusRatioMax,
      );
      const mag = Math.min(flare * weight * radial, cfg.maxStrength);

      // Normalise to the outward unit vector, then scale to the force.
      bone.applyForce(r.multiplyScalar(mag / radius));
    }
  }

  reset(): void {
    this.t = 0;
    for (const chain of this.chains) {
      chain.reset();
    }
    if (this.hips) this.prevHipsPos.setFromMatrixPosition(this.hips.matrixWorld);
    if (this.chest) this.prevChestPos.setFromMatrixPosition(this.chest.matrixWorld);
    this.bodyVelocity.set(0, 0, 0);
    this._flare = 0;
  }

  /**
   * Choreography inertia — skirt panels and sleeves trail the hips' world
   * motion (heavier than hair: a lower family gain, same tip falloff).
   */
  applyHipInertia(drive: HipInertiaDrive): void {
    if (!this._hasCloth) return;
    hipInertiaChains(
      this.chains,
      PHYSICS_CONFIG.cloth.impulseTipBase,
      PHYSICS_CONFIG.cloth.impulseTipSpan,
      PHYSICS_CONFIG.global.hipInertia.familyGain.cloth,
      drive,
    );
  }

  /** Impulse applied to every non-root cloth bone (beat reactions, pokes). */
  applyImpulse(force: THREE.Vector3): void {
    if (!this._hasCloth) return;
    for (const chain of this.chains) {
      for (let j = 1; j < chain.length; j++) {
        const ratio = j / chain.length;
        chain.bones[j].applyForce(
          force
            .clone()
            .multiplyScalar(
              PHYSICS_CONFIG.cloth.impulseTipBase + ratio * PHYSICS_CONFIG.cloth.impulseTipSpan,
            ),
        );
      }
    }
  }

  /** Directional poke — cloth panels near the touch point get shoved away. */
  applyImpulseAt(
    at: THREE.Vector3,
    radius: number = PHYSICS_CONFIG.cloth.pokeRadius,
    strength: number = PHYSICS_CONFIG.cloth.pokeStrength,
  ): void {
    if (!this._hasCloth) return;
    impulseChainsAt(this.chains, at, radius, strength);
  }

  /**
   * Continuous pointer-drag spring — skirt/cloth panels near the grab point
   * are pulled toward the projected pointer target (see dragChainsAt). Called
   * once per fixed substep by SecondaryPhysicsManager while a drag is active.
   */
  applyDragAt(target: THREE.Vector3, anchor: THREE.Vector3): void {
    if (!this._hasCloth) return;
    const cfg = PHYSICS_CONFIG.drag;
    dragChainsAt(this.chains, target, anchor, cfg.radius, cfg.strength, cfg.maxForce);
  }

  dispose(): void {
    this.chains = [];
    this.skirtFlags = [];
    this._hasCloth = false;
    this._hasSkirt = false;
    this._flare = 0;
  }
}
