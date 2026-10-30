import * as THREE from "three";
import { PHYSICS_CONFIG } from "../physicsConfig";

/**
 * Core physics bone using Verlet integration with spring-damper dynamics.
 *
 * Each PhysicsBone represents a point mass attached to a parent via a fixed-length
 * distance constraint. The simulation uses Verlet integration for stability and
 * performance, with explicit damping to prevent oscillation.
 *
 * ── Physics model ──
 *   position(t+dt) = 2 * position(t) - position(t-dt) + acceleration * dt²
 *   velocity ≈ (position(t) - position(t-dt)) / dt
 *
 * Forces applied each frame:
 *   • Gravity (world-space down)
 *   • Inertia from parent bone movement
 *   • Damping (velocity scaling)
 *   • Spring restoration toward rest position
 *   • Wind / external force
 *   • Collision pushback
 */
// ── Hot-loop scratch objects ──────────────────────────────
// Each function owns its prefixed scratch set; no cross-calls between them,
// so reuse is safe without reentrancy guards.
const _simVel = new THREE.Vector3();
const _simAccel = new THREE.Vector3();
const _simRestDir = new THREE.Vector3();
const _simRestTarget = new THREE.Vector3();
const _cdDir = new THREE.Vector3();
const _csDir = new THREE.Vector3();
const _arDesiredDir = new THREE.Vector3();
const _arRestDir = new THREE.Vector3();
const _arQ = new THREE.Quaternion();
const _arParentWorldQ = new THREE.Quaternion();
const _arLocalQ = new THREE.Quaternion();
const _chainAnchor = new THREE.Vector3();
// Capsule-collision scratch (collideCapsule owns these; no nested calls).
const _ccSeg = new THREE.Vector3();
const _ccToPoint = new THREE.Vector3();
const _ccClosest = new THREE.Vector3();
const _ccDir = new THREE.Vector3();

export class PhysicsBone {
  /** Current world position of this bone's endpoint. */
  position: THREE.Vector3;
  /** Previous frame's world position (for Verlet integration). */
  previous: THREE.Vector3;
  /** Rest position in parent's local space (the "anchor" offset). */
  readonly restOffset: THREE.Vector3;
  /** The length of this bone segment. */
  readonly length: number;
  /** Whether this point is pinned (does not move). */
  pinned = false;

  /** Spring stiffness (0 = no spring, higher = snappier). */
  stiffness: number = PHYSICS_CONFIG.bone.stiffness;
  /** Damping coefficient (0 = no damping, 1 = critically damped approx). */
  damping: number = PHYSICS_CONFIG.bone.damping;
  /** Gravity multiplier applied to this bone. */
  gravityInfluence: number = PHYSICS_CONFIG.bone.gravityInfluence;
  /** Air resistance (0 = none, 1 = max drag). */
  airResistance: number = PHYSICS_CONFIG.bone.airResistance;

  /** Accumulated external force applied this frame (impulse-style). */
  private force = new THREE.Vector3();
  /** Collision radius for simple sphere colliders. */
  collisionRadius = 0;

  constructor(
    /** The THREE.Object3D bone this physics drives. */
    readonly bone: THREE.Object3D,
    /** Parent physics bone (null if this is a root chain bone). */
    readonly parentBone: PhysicsBone | null,
    /** Rest position in world space (used to compute length and offsets). */
    restWorldPos: THREE.Vector3,
    /** The local-space rest offset from the parent bone. */
    restLocalOffset: THREE.Vector3,
  ) {
    // Compute segment length from actual bone to its rest position
    const parentWorldPos = parentBone
      ? parentBone.position
      : new THREE.Vector3().setFromMatrixPosition(bone.parent!.matrixWorld);
    this.length = parentWorldPos.distanceTo(restWorldPos);
    this.restOffset = restLocalOffset.clone();
    this.position = restWorldPos.clone();
    this.previous = restWorldPos.clone();
  }

  /** Current velocity (computed from Verlet positions). Allocates — prefer speed(). */
  get velocity(): THREE.Vector3 {
    return new THREE.Vector3().subVectors(this.position, this.previous);
  }

  /** Allocation-free squared speed of this Verlet point. */
  speed(): number {
    return _simVel.subVectors(this.position, this.previous).length();
  }

  /** Apply an impulse force for this frame (accumulated). */
  applyForce(f: THREE.Vector3): void {
    this.force.add(f);
  }

  /**
   * Advance physics simulation by dt seconds.
   * Should be called AFTER `beginFrame()` updates the parent chain.
   */
  simulate(dt: number, gravity: THREE.Vector3, parentVelocity: THREE.Vector3): void {
    if (this.pinned) return;

    const dt2 = dt * dt;

    // 1. Verlet integration: new = current + (current - previous) + acceleration * dt²
    const vel = _simVel.subVectors(this.position, this.previous);

    // Inertia from parent movement
    vel.addScaledVector(parentVelocity, dt);

    // Damping (multiply velocity by damping factor per frame)
    const dampingFactor = 1 - this.damping;
    vel.multiplyScalar(dampingFactor);

    // Air resistance
    if (this.airResistance > 0) {
      vel.multiplyScalar(1 - this.airResistance);
    }

    // Acceleration from forces
    const accel = _simAccel.set(0, 0, 0);

    // Gravity
    accel.addScaledVector(gravity, this.gravityInfluence * PHYSICS_CONFIG.bone.gravityScale);

    // External force
    accel.add(this.force);

    // Spring restoration toward rest (relative to parent movement)
    if (this.stiffness > 0 && this.parentBone) {
      // Compute where this bone's end "wants" to be in world space
      // based on parent rest offset + inherited parent rotation
      const restDir = _simRestDir.copy(this.restOffset).normalize();
      const restLen = this.restOffset.length();
      // The rest target in world space (parent position + rotated rest offset)
      const restTarget = _simRestTarget
        .copy(this.parentBone.position)
        .addScaledVector(restDir, restLen);
      accel.addScaledVector(
        restTarget.sub(this.position),
        this.stiffness * PHYSICS_CONFIG.bone.springScale,
      );
    }

    // Apply acceleration
    vel.addScaledVector(accel, dt);

    // Store previous position
    this.previous.copy(this.position);

    // Update position
    this.position.add(vel);

    // Clear forces for next frame
    this.force.set(0, 0, 0);
  }

  /**
   * Enforce distance constraint: maintain fixed length from parent.
   * Must be called after `simulate()`.
   */
  constrainDistance(): void {
    const parent = this.parentBone;
    if (!parent || this.pinned) return;

    const parentPos = parent.position;
    const dir = _cdDir.subVectors(this.position, parentPos);
    const dist = dir.length();

    if (dist < 0.0001) {
      // Degenerate case — push in a random direction
      dir.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this.position.copy(parentPos).add(dir.multiplyScalar(this.length));
      return;
    }

    if (Math.abs(dist - this.length) > 0.001) {
      dir.normalize().multiplyScalar(this.length);
      this.position.copy(parentPos).add(dir);
    }
  }

  /**
   * Simple sphere collision.
   * Pushes the bone outside the sphere if it penetrates.
   */
  collideSphere(
    center: THREE.Vector3,
    radius: number,
    pushStrength: number = PHYSICS_CONFIG.bone.collisionPush,
  ): void {
    if (this.pinned) return;
    const dir = _csDir.subVectors(this.position, center);
    const dist = dir.length();
    const penetration = radius - dist + this.collisionRadius;
    if (penetration > 0 && dist > 0.0001) {
      dir.normalize().multiplyScalar(-penetration * pushStrength);
      this.position.add(dir);
    }
  }

  /**
   * Capsule collision — pushes the bone outside the capsule (a→b segment
   * swept by `radius`) using point-to-segment distance. Reuses scratch
   * vectors; no allocations.
   */
  collideCapsule(
    a: THREE.Vector3,
    b: THREE.Vector3,
    radius: number,
    pushStrength: number = PHYSICS_CONFIG.bone.collisionPush,
  ): void {
    if (this.pinned) return;
    _ccSeg.subVectors(b, a);
    const lenSq = _ccSeg.lengthSq();
    let t = 0;
    if (lenSq > 1e-8) {
      _ccToPoint.subVectors(this.position, a);
      t = Math.min(1, Math.max(0, _ccToPoint.dot(_ccSeg) / lenSq));
    }
    _ccClosest.copy(a).addScaledVector(_ccSeg, t);
    _ccDir.subVectors(this.position, _ccClosest);
    const dist = _ccDir.length();
    const penetration = radius - dist + this.collisionRadius;
    if (penetration > 0) {
      if (dist > 1e-4) {
        _ccDir.divideScalar(dist);
      } else {
        _ccDir.set(0, 1, 0);
      }
      this.position.addScaledVector(_ccDir, penetration * pushStrength);
    }
  }

  /**
   * Apply the physics position as a bone rotation.
   * Computes a quaternion from the parent→current direction and applies it to the bone.
   */
  applyRotation(): void {
    const parent = this.parentBone;
    if (!parent) return;

    // Desired direction: from parent world position to this physics position
    const desiredDir = _arDesiredDir.subVectors(this.position, parent.position);
    if (desiredDir.lengthSq() < 0.0001) return;
    desiredDir.normalize();

    // Rest direction: from parent to this bone's original rest position
    const restDir = _arRestDir.copy(this.restOffset);
    if (restDir.lengthSq() < 0.0001) return;
    restDir.normalize();

    // Compute quaternion from rest direction to desired direction
    const q = _arQ.setFromUnitVectors(restDir, desiredDir);

    // Get parent bone's world quaternion (for converting to local space)
    const parentWorldQ = _arParentWorldQ.setFromRotationMatrix(this.bone.parent!.matrixWorld);

    // Convert to local-space quaternion and apply as local rotation offset
    // (multiply with existing animation rotation)
    const localQ = _arLocalQ.copy(parentWorldQ).invert().multiply(q);
    this.bone.quaternion.premultiply(localQ);
  }

  /** Reset physics to rest pose. */
  reset(): void {
    this.position.copy(new THREE.Vector3().setFromMatrixPosition(this.bone.matrixWorld));
    this.previous.copy(this.position);
    this.force.set(0, 0, 0);
  }
}

/**
 * A chain of PhysicsBones representing a connected set of bones
 * (e.g., a hair strand, skirt panel, tail).
 */
export class PhysicsBoneChain {
  readonly bones: PhysicsBone[];

  constructor(bones: PhysicsBone[]) {
    this.bones = bones;
  }

  get length(): number {
    return this.bones.length;
  }

  /**
   * Simulate the entire chain: forces, constraints, collisions, rotation.
   */
  simulate(
    dt: number,
    gravity: THREE.Vector3,
    parentVelocity: THREE.Vector3,
    nIterations: number = PHYSICS_CONFIG.bone.chainIterations,
  ): void {
    if (this.bones.length === 0) return;

    // Run Verlet integration + constraints for N iterations
    for (let iter = 0; iter < nIterations; iter++) {
      // Simulate forces
      for (let i = 0; i < this.bones.length; i++) {
        const bone = this.bones[i];

        // Root bone: anchor to parent world position
        if (i === 0 && !bone.pinned) {
          const anchorWorld = _chainAnchor.setFromMatrixPosition(bone.bone.parent!.matrixWorld);
          bone.position.copy(anchorWorld);
          bone.previous.copy(anchorWorld);
          continue;
        }

        bone.simulate(dt, gravity, parentVelocity);
      }

      // Enforce distance constraints (back to front for stability)
      for (let i = this.bones.length - 1; i >= 0; i--) {
        this.bones[i].constrainDistance();
      }
    }

    // Apply rotations
    for (let i = 0; i < this.bones.length; i++) {
      this.bones[i].applyRotation();
    }
  }

  /** Apply sphere collision to all bones in chain. */
  collideSphere(center: THREE.Vector3, radius: number): void {
    for (const bone of this.bones) {
      bone.collideSphere(center, radius);
    }
  }

  reset(): void {
    for (const bone of this.bones) {
      bone.reset();
    }
  }
}

/**
 * Pre-compute sine/cosine wave with phase offset for organic motion patterns.
 * Uses harmonic synthesis with non-harmonic partials for natural-looking movement.
 */
export function organicWave(t: number, baseFreq: number, amp: number, phase = 0): number {
  const p = t * baseFreq + phase;
  return (
    Math.sin(p) * amp +
    Math.sin(p * 1.73 + 1.3) * amp * 0.35 +
    Math.sin(p * 0.51 + 2.7) * amp * 0.2 +
    Math.sin(p * 2.31 + 0.7) * amp * 0.1
  );
}

/**
 * Smooth noise using layered sine waves (Perlin-like but cheap).
 * Good for natural-looking drift motion.
 */
export function smoothNoise(t: number, seed = 0): number {
  return (
    Math.sin(t * 0.71 + seed * 1.3) * 0.5 +
    Math.sin(t * 1.43 + seed * 2.7) * 0.25 +
    Math.sin(t * 3.17 + seed * 0.5) * 0.125 +
    Math.sin(t * 6.89 + seed * 1.9) * 0.0625
  );
}

/** Shared gravity vector (reusable to avoid allocations). */
const _GRAVITY = new THREE.Vector3(0, -PHYSICS_CONFIG.global.gravity, 0);
export function getGravity(): THREE.Vector3 {
  return _GRAVITY;
}

// ── Hip-motion inertia (shared by all physics subsystems) ──

/**
 * One frame of choreography, pre-digested for the chains.
 *
 * Built once per rendered frame by SecondaryPhysicsManager from the
 * HipMotionTracker snapshot (see HipMotionTracker.ts) and applied to every
 * substep, so the same hip motion integrates identically at 60/90/120 Hz.
 *
 * `linear` is the OPPOSITE-direction inertia already negated and scaled — the
 * chain helper only adds the rotational terms and the per-bone weighting.
 */
export interface HipInertiaDrive {
  /** Hip world position — origin of the rotational terms. */
  readonly pivot: THREE.Vector3;
  /** Opposed linear inertia (m/s²). Read-only view; mutated by its owner. */
  readonly linear: THREE.Vector3;
  /** Effective yaw acceleration (rad/s²) for the tangential lag term. */
  tangential: number;
  /** Effective ω² (1/s²) for the outward spin term. */
  centrifugal: number;
  /** Per-bone force clamp (m/s²). */
  maxForce: number;
  /** False when there is no hip bone or the state response is zero. */
  active: boolean;
}

const _hipR = new THREE.Vector3();
const _hipF = new THREE.Vector3();

/**
 * Apply choreography inertia to every non-root bone of the chains.
 *
 * Three physical terms, all of them read from where the body *is* going:
 *
 *   linear      — opposite to the hip's linear acceleration. Hip forward →
 *                 the strands lag backward; hip left → they lag right.
 *   tangential  — opposite to the hip's angular acceleration (−α × r): a
 *                 spin/twist leaves the strands behind instead of carrying them.
 *   centrifugal — outward during a spin (+ω² r): the strands are flung away
 *                 from the hip axis, the same way real hair is.
 *
 * Weighted along each chain (roots barely move, tips react most — the same
 * curve the impulse path uses) and clamped per bone, so no clip — however fast
 * or however much it spins — can blow the simulation up.
 */
export function hipInertiaChains(
  chains: PhysicsBoneChain[],
  tipBase: number,
  tipSpan: number,
  familyGain: number,
  drive: HipInertiaDrive,
): void {
  if (!drive.active) return;

  const linear = drive.linear;
  const alpha = drive.tangential;
  const omegaSq = drive.centrifugal;
  const maxForce = drive.maxForce;
  const clampSq = maxForce * maxForce;

  for (const chain of chains) {
    for (let j = 1; j < chain.length; j++) {
      const bone = chain.bones[j];
      const ratio = j / chain.length;
      const weight = (tipBase + ratio * tipSpan) * familyGain;

      _hipR.subVectors(bone.position, drive.pivot);
      // ŷ × r = (r.z, 0, −r.x), so −α(ŷ × r) = (−α r.z, 0, +α r.x), and the
      // outward direction is simply r in the XZ plane (Y stays linear-only).
      _hipF.set(
        linear.x - alpha * _hipR.z + omegaSq * _hipR.x,
        linear.y,
        linear.z + alpha * _hipR.x + omegaSq * _hipR.z,
      );
      _hipF.multiplyScalar(weight);

      const lenSq = _hipF.lengthSq();
      if (lenSq > clampSq) _hipF.multiplyScalar(maxForce / Math.sqrt(lenSq));
      bone.applyForce(_hipF);
    }
  }
}

// ── Directional poke impulse (shared by all physics subsystems) ──

const _impDir = new THREE.Vector3();

/**
 * Apply a directional impulse to every non-root bone in the chains, with
 * quadratic distance falloff around the world-space touch point `at`.
 * Reads as a physical push: strands near the finger blast away, distant
 * ones barely move.
 */
export function impulseChainsAt(
  chains: PhysicsBoneChain[],
  at: THREE.Vector3,
  radius: number,
  strength: number,
): void {
  for (const chain of chains) {
    for (let j = 1; j < chain.bones.length; j++) {
      const bone = chain.bones[j];
      const dir = _impDir.subVectors(bone.position, at);
      const dist = dir.length();
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      if (dist > 0.0001) {
        dir.divideScalar(dist);
      } else {
        dir.set(0, 1, 0);
      }
      bone.applyForce(dir.multiplyScalar(strength * falloff * falloff));
    }
  }
}

// ── Pointer-drag spring (shared by all physics subsystems) ──

const _dragPull = new THREE.Vector3();

/**
 * Continuous spring toward the pointer target for every non-root bone within
 * `radius` of the world-space grab point `anchor`, with linear falloff — the
 * strand the finger landed on follows the pointer, its neighbours follow it
 * less. Each application is clamped to `maxForce` so a fast pointer flick
 * tugs the chain; it never launches it. The caller applies this once per
 * fixed substep while a drag is active and simply stops on release — the
 * chains' own spring restoration then pulls everything home.
 */
export function dragChainsAt(
  chains: PhysicsBoneChain[],
  target: THREE.Vector3,
  anchor: THREE.Vector3,
  radius: number,
  strength: number,
  maxForce: number,
): void {
  const radiusSq = radius * radius;
  for (const chain of chains) {
    for (let j = 1; j < chain.bones.length; j++) {
      const bone = chain.bones[j];
      const dx = bone.position.x - anchor.x;
      const dy = bone.position.y - anchor.y;
      const dz = bone.position.z - anchor.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > radiusSq) continue;
      const falloff = 1 - Math.sqrt(distSq) / radius;
      _dragPull.subVectors(target, bone.position).multiplyScalar(strength * falloff);
      const len = _dragPull.length();
      if (len > maxForce) _dragPull.multiplyScalar(maxForce / len);
      bone.applyForce(_dragPull);
    }
  }
}
