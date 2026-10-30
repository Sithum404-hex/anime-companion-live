import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { VRMHumanBoneName } from "@pixiv/three-vrm";
import { PHYSICS_CONFIG } from "../physicsConfig";

/**
 * HipMotionTracker — reads the choreography, never writes it.
 *
 * This is the source the dance physics now follows: instead of guessing at body
 * motion from the music, the secondary chains are driven by what the *skeleton*
 * is actually doing. It samples the hips/root bone's world transform once per
 * rendered frame and derives:
 *
 *   • pivot        — hip world position (axis origin for the rotational terms)
 *   • velocity     — smoothed hip linear velocity (m/s)
 *   • acceleration — smoothed hip linear acceleration (m/s²)
 *   • yawRate      — smoothed hip yaw rate about world +Y (rad/s)
 *   • yawAccel     — smoothed hip yaw acceleration (rad/s²)
 *
 * All four are EMA-smoothed (frame-rate independent) and clamped to the bands in
 * `PHYSICS_CONFIG.global.hipInertia`, so a clip cut, a dropped frame or a hitched
 * tab cannot spike the simulation. Nothing here mutates a bone: the tracker is a
 * pure reader, which is why physics driven by it can never steer the dance.
 */
export class HipMotionTracker {
  /** Hips on the normalized rig — the node the choreography actually drives. */
  private readonly bone: THREE.Object3D | null;
  private readonly hasHips: boolean;

  private readonly prevPos = new THREE.Vector3();
  /** Hip world position this frame (rotational axis origin). */
  private readonly _pivot = new THREE.Vector3();
  private readonly _vel = new THREE.Vector3();
  private readonly _accel = new THREE.Vector3();
  private readonly _prevVel = new THREE.Vector3();

  private _yawRate = 0;
  private _yawAccel = 0;
  private _prevYaw: number | null = null;
  /** Frame-delta velocity/accel are only meaningful once two frames exist. */
  private primed = false;

  constructor(vrm: VRM) {
    const humanoid = vrm.humanoid;
    this.bone =
      humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Hips) ??
      humanoid?.getRawBoneNode(VRMHumanBoneName.Hips) ??
      null;
    this.hasHips = !!this.bone;
    if (this.bone) {
      this.prevPos.setFromMatrixPosition(this.bone.matrixWorld);
    }
  }

  get available(): boolean {
    return this.hasHips;
  }

  /** Hip world position — origin of the tangential / centrifugal terms. */
  get pivot(): THREE.Vector3 {
    return this._pivot;
  }

  /** Smoothed hip linear velocity (m/s). Read-only view of an internal vector. */
  get velocity(): THREE.Vector3 {
    return this._vel;
  }

  /** Smoothed hip linear acceleration (m/s²). Read-only view of an internal vector. */
  get acceleration(): THREE.Vector3 {
    return this._accel;
  }

  /** Smoothed hip yaw rate about world +Y (rad/s). */
  get yawRate(): number {
    return this._yawRate;
  }

  /** Smoothed hip yaw acceleration about world +Y (rad/s²). */
  get yawAcceleration(): number {
    return this._yawAccel;
  }

  /** Smoothed hip speed (m/s) — convenient magnitude for debug/tests. */
  get speed(): number {
    return this._vel.length();
  }

  /**
   * Sample the hips' world motion. Call once per rendered frame, before the
   * physics substeps, so every substep of the frame sees the same drive.
   *
   * @param dt Frame delta in seconds (clamped internally).
   */
  sample(dt: number): void {
    const bone = this.bone;
    if (!bone) return;

    const cfg = PHYSICS_CONFIG.global.hipInertia;
    const step = Math.min(Math.max(dt, 1 / 240), cfg.maxSampleDt);

    // ── Linear terms ──────────────────────────────────────────────────────
    this._pivot.setFromMatrixPosition(bone.matrixWorld);
    if (!this.primed) {
      this.prevPos.copy(this._pivot);
      this.primed = true;
      return;
    }

    _instantVel.subVectors(this._pivot, this.prevPos).divideScalar(step);
    this.prevPos.copy(this._pivot);
    _instantVel.clampLength(0, cfg.maxSpeed);

    // Frame-rate independent EMA: k = 1 - e^(-dt/tau).
    const k = 1 - Math.exp(-step / cfg.smoothSec);

    this._prevVel.copy(this._vel);
    this._vel.lerp(_instantVel, k);
    // Acceleration from the *smoothed* velocity change, then smoothed again —
    // differentiating raw frame deltas would amplify keyframe stair-stepping.
    _instantAccel
      .subVectors(this._vel, this._prevVel)
      .divideScalar(step)
      .clampLength(0, cfg.maxAccel);
    this._accel.lerp(_instantAccel, k);

    // ── Yaw terms ─────────────────────────────────────────────────────────
    // Third column of the world matrix is the bone's forward axis; yaw is its
    // heading about +Y. Read straight from the matrix (no getWorldQuaternion,
    // which would force an extra matrix refresh mid-frame).
    const e = bone.matrixWorld.elements;
    _forward.set(e[8], e[9], e[10]).normalize();
    const yaw = Math.atan2(_forward.x, _forward.z);

    if (this._prevYaw === null) {
      this._prevYaw = yaw;
      return;
    }
    // Unwrap so a ±π crossing reads as a small step, not a full turn.
    const deltaYaw = wrapPi(yaw - this._prevYaw);
    this._prevYaw = yaw;

    const instRate = clamp(deltaYaw / step, -cfg.maxYawRate, cfg.maxYawRate);
    const prevRate = this._yawRate;
    this._yawRate += (instRate - this._yawRate) * k;
    const instAccel = clamp((this._yawRate - prevRate) / step, -cfg.maxYawAccel, cfg.maxYawAccel);
    this._yawAccel += (instAccel - this._yawAccel) * k;
  }

  /** Forget motion history — the next sample only primes the filter. */
  reset(): void {
    this._vel.set(0, 0, 0);
    this._accel.set(0, 0, 0);
    this._prevVel.set(0, 0, 0);
    this._yawRate = 0;
    this._yawAccel = 0;
    this._prevYaw = null;
    this.primed = false;
    if (this.bone) this.prevPos.setFromMatrixPosition(this.bone.matrixWorld);
  }
}

const _instantVel = new THREE.Vector3();
const _instantAccel = new THREE.Vector3();
const _forward = new THREE.Vector3();

function wrapPi(angle: number): number {
  return angle - Math.PI * 2 * Math.round(angle / (Math.PI * 2));
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
