import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BeatPulse } from "../DanceDirector";

/**
 * Dance-aware cinematic camera controller.
 *
 * This is a thin layer over the existing camera, OrbitControls, beat pulse, and
 * hips anchor. It does not create a renderer, scene, VRM, animation mixer, or
 * render loop. It is created once, updated once per frame after vrm.update, and
 * disposed once.
 *
 * Normal state: effectively a no-op; OrbitControls (and its idle auto-rotate)
 * stay fully alive. Dance state: the controller blends into a cinematic framing,
 * gently tracks the character's hips anchor, adds restrained sway / rotation /
 * zoom breathing, and includes weak beat-aware shake that only becomes noticeable
 * when the dance is energetic. On exit it smoothly returns to the recorded
 * baseline camera position and orbit target.
 */
export class DanceCameraController {
  /** Whether the dance camera is currently enabled. */
  get enabled(): boolean {
    return this._enabled;
  }

  private _enabled = false;

  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private readonly beatPulse: () => BeatPulse;
  private readonly hipsNode: THREE.Object3D | null;

  // Lifecycle
  private active = false;
  private state: "inactive" | "blending_in" | "active" | "blending_out" = "inactive";

  // Recorded baseline at dance entry
  private baseTarget = new THREE.Vector3();
  private baseCamPos = new THREE.Vector3();

  // Anchor tracking
  private anchor = new THREE.Vector3();
  private prevAnchor = new THREE.Vector3();
  private anchorVelocity = new THREE.Vector3();

  // Camera target offset (applied on top of base target)
  private offset = new THREE.Vector3();
  private targetOffset = new THREE.Vector3();

  // Temporal state
  private swayTime = 0;

  // Return targets
  private returnTarget = new THREE.Vector3();
  private returnCamPos = new THREE.Vector3();

  // Shake ring buffer
  private shakeBuffer = new Float32Array(64);
  private shakeIndex = 0;
  private shakeDecay = 4.5;

  // Tunable strengths
  private _followStrength = 0.32;
  private _swayStrength = 0.18;
  private _rotationStrength = 0.06;
  private _zoomStrength = 0.05;
  private _shakeStrength = 0.018;
  private _returnSpeed = 2.2;

  // Blend timing
  private readonly blendDuration = 1.1;
  private blendTimer = 0;

  // Scratch objects (zero-alloc hot path)
  private readonly _euler = new THREE.Euler(0, 0, 0, "XYZ");
  private readonly _q = new THREE.Quaternion();
  private readonly _tmp = new THREE.Vector3();
  private readonly _follow = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    beatPulse: () => BeatPulse,
    hipsNode: THREE.Object3D | null,
  ) {
    this.camera = camera;
    this.controls = controls;
    this.beatPulse = beatPulse;
    this.hipsNode = hipsNode;

    this.baseCamPos.copy(camera.position);
    this.baseTarget.copy(controls.target);
  }

  // ── Tunable parameters ────────────────────────────────────────────────────

  get followStrength(): number {
    return this._followStrength;
  }
  set followStrength(v: number) {
    this._followStrength = Math.max(0, v);
  }

  get swayStrength(): number {
    return this._swayStrength;
  }
  set swayStrength(v: number) {
    this._swayStrength = Math.max(0, v);
  }

  get rotationStrength(): number {
    return this._rotationStrength;
  }
  set rotationStrength(v: number) {
    this._rotationStrength = Math.max(0, v);
  }

  get zoomStrength(): number {
    return this._zoomStrength;
  }
  set zoomStrength(v: number) {
    this._zoomStrength = Math.max(0, v);
  }

  get shakeStrength(): number {
    return this._shakeStrength;
  }
  set shakeStrength(v: number) {
    this._shakeStrength = Math.max(0, v);
  }

  get returnSpeed(): number {
    return this._returnSpeed;
  }
  set returnSpeed(v: number) {
    this._returnSpeed = Math.max(0.2, v);
  }

  // ── Runtime control ───────────────────────────────────────────────────────

  setEnabled(enabled: boolean): void {
    if (enabled === this._enabled) return;
    this._enabled = enabled;
    if (!enabled) {
      this.active = false;
      this.state = "inactive";
      this.offset.set(0, 0, 0);
      this.targetOffset.set(0, 0, 0);
      this.controls.target.copy(this.baseTarget);
      this.camera.position.copy(this.baseCamPos);
      this.camera.fov = 28;
      this.camera.updateProjectionMatrix();
      this.clearShake();
      this.disableOrbitDuringDance(false);
    }
  }

  /** True once a dance has been entered and not yet fully returned. */
  get isDancing(): boolean {
    return this.active;
  }

  /** Debug-friendly current lifecycle state. */
  get debugState(): string {
    return this.state;
  }

  /** Re-record the baseline framing from the current camera/controls. */
  resetBaseline(): void {
    this.baseCamPos.copy(this.camera.position);
    this.baseTarget.copy(this.controls.target);
  }

  dispose(): void {
    this.setEnabled(false);
  }

  // ── Per-frame update ──────────────────────────────────────────────────────

  /**
   * Call once per frame after the animation/VRM has been updated so the hips
   * world position reflects the latest transforms.
   */
  update(dt: number, animState: string): void {
    if (!this.enabled) {
      this.active = false;
      this.state = "inactive";
      return;
    }

    const nowDancing = animState === "dance";

    if (nowDancing && !this.active) {
      this.enterDance();
      return;
    }
    if (!nowDancing && (this.state === "blending_in" || this.state === "active")) {
      this.startLeaveDance();
      return;
    }

    if (this.state === "blending_in") {
      this.blendTimer += dt;
      const t = Math.min(1, this.blendTimer / this.blendDuration);
      this.applyDanceEasing(1 - easeOutCubic(1 - t), dt);
      if (t >= 1) {
        this.state = "active";
        this.blendTimer = 0;
      }
      return;
    }

    if (this.state === "blending_out") {
      this.blendTimer += dt;
      const t = Math.min(1, this.blendTimer / this.blendDuration);
      this.applyReturn(t, dt);
      if (t >= 1) {
        this.finishLeaveDance();
      }
      return;
    }

    if (this.state === "active") {
      this.applyDanceEasing(1, dt);
    }
  }

  // ── State transitions ─────────────────────────────────────────────────────

  private enterDance(): void {
    this.baseCamPos.copy(this.camera.position);
    this.baseTarget.copy(this.controls.target);
    this.returnTarget.copy(this.controls.target);
    this.returnCamPos.copy(this.camera.position);
    this.anchor.set(0, 0, 0);
    this.prevAnchor.set(0, 0, 0);
    this.anchorVelocity.set(0, 0, 0);
    this.offset.set(0, 0, 0);
    this.targetOffset.set(0, 0, 0);
    this.swayTime = 0;
    this.clearShake();

    this.state = "blending_in";
    this.blendTimer = 0;
    this.disableOrbitDuringDance(false);
  }

  private startLeaveDance(): void {
    this.returnTarget.copy(this.controls.target);
    this.returnCamPos.copy(this.camera.position);
    this.state = "blending_out";
    this.blendTimer = 0;
    this.disableOrbitDuringDance(false);
  }

  private finishLeaveDance(): void {
    this.active = false;
    this.state = "inactive";
    this.offset.set(0, 0, 0);
    this.targetOffset.set(0, 0, 0);
    this.controls.target.copy(this.baseTarget);
    this.camera.position.copy(this.baseCamPos);
    this.camera.fov = 28;
    this.camera.updateProjectionMatrix();
    this.clearShake();
  }

  // ── Dance camera behavior ─────────────────────────────────────────────────

  private applyDanceEasing(ease: number, dt: number): void {
    const pulse = this.beatPulse();
    const now = performance.now();

    // Update anchor
    if (this.hipsNode) {
      this.prevAnchor.copy(this.anchor);
      this.hipsNode.getWorldPosition(this.anchor);
      if (dt > 1e-6) {
        this.anchorVelocity.subVectors(this.anchor, this.prevAnchor).divideScalar(dt);
      } else {
        this.anchorVelocity.set(0, 0, 0);
      }
    }

    // Follow offset
    this._follow.copy(this.anchor).sub(this.baseTarget);
    this._follow.y *= 0.25;
    this._follow.multiplyScalar(this._followStrength);

    this.swayTime += dt * 1.25;
    const swayX = Math.sin(this.swayTime) * this._swayStrength * 0.06;
    const swayZ = Math.cos(this.swayTime * 0.7) * this._swayStrength * 0.05;
    const beatBob = this.beatBob(pulse) * this._swayStrength * 0.02;

    this.targetOffset.set(this._follow.x + swayX, this._follow.y + beatBob, this._follow.z + swayZ);

    this.offset.lerp(this.targetOffset, Math.min(1, dt * 6));

    // Rotational offsets
    const roll =
      Math.sin(this.swayTime * 1.3) * this._rotationStrength * 0.0008 +
      this.anchorVelocity.x * this._rotationStrength * 0.002;
    const pitch = Math.sin(this.swayTime * 0.9) * this._rotationStrength * 0.0005;

    // Zoom breathing
    const zoomDelta = Math.sin(this.swayTime * 0.5) * this._zoomStrength * 0.0006;

    // Shake
    this.pushShake(pulse.strength, dt);
    const shake = this.sampleShake(dt);
    shake.multiplyScalar(this._shakeStrength);

    // Compose final offset
    const fx = this.offset.x + shake.x + roll * 0.5;
    const fy = this.offset.y + shake.y + pitch;
    const fz = this.offset.z + shake.z;

    const target = new THREE.Vector3().copy(this.baseTarget);
    target.x += fx;
    target.y += fy;
    target.z += fz;

    const lerpFactor = Math.min(1, dt * 8);
    this.controls.target.lerp(target, lerpFactor);

    // Roll/pitch on the camera itself
    this._euler.set(pitch, 0, roll, "XYZ");
    this._q.setFromEuler(this._euler);
    this.camera.quaternion.premultiply(this._q);

    // FOV breathing
    const newFov = 28 + zoomDelta * 2 + shake.y * 8;
    this.camera.fov = Math.max(20, Math.min(40, newFov));
    this.camera.updateProjectionMatrix();
  }

  private beatBob(pulse: BeatPulse): number {
    if (!pulse.reliable) return 0;
    const dt = pulse.nextAt - pulse.at;
    if (dt <= 0) return 0;
    const phase = (nowFrom(pulse.at) % dt) / dt;
    const envelope = Math.sin(phase * Math.PI);
    return envelope * Math.min(1, pulse.strength * 2);
  }

  private applyReturn(t: number, dt: number): void {
    const e = easeInOutCubic(Math.min(1, t));
    this.controls.target.lerp(this.returnTarget, e);
    this.camera.position.lerp(this.returnCamPos, e);
    this.shakeDecay = 4.5 + e * 4;
  }

  private disableOrbitDuringDance(disable: boolean): void {
    // Keep OrbitControls enabled so normal user orbit is never taken over.
    // The idle auto-rotate gate in WaifuCharacterController already disables
    // auto-rotate during dance, which is the only behavioral difference needed.
  }

  // ── Shake ─────────────────────────────────────────────────────────────────

  private pushShake(strength: number, dt: number): void {
    const impulse = strength * this._shakeStrength;
    if (impulse <= 1e-6) return;
    this.shakeBuffer[this.shakeIndex] = impulse;
    this.shakeIndex = (this.shakeIndex + 1) % this.shakeBuffer.length;
  }

  private sampleShake(dt: number): THREE.Vector3 {
    const out = new THREE.Vector3();
    let total = 0;
    let idx = this.shakeIndex;
    for (let i = 0; i < this.shakeBuffer.length; i++) {
      const v = this.shakeBuffer[idx];
      if (v <= 1e-6 && i > 0) break;
      total += v;
      const decay = Math.exp(-this.shakeDecay * (i / this.shakeBuffer.length));
      const angle = (performance.now() * 0.001 + i * 1.7) % (Math.PI * 2);
      out.x += Math.cos(angle) * v * decay;
      out.y += Math.sin(angle * 0.7) * v * decay;
      out.z += Math.sin(angle * 0.5) * v * decay * 0.6;
      idx = (idx - 1 + this.shakeBuffer.length) % this.shakeBuffer.length;
    }
    return out;
  }

  private clearShake(): void {
    this.shakeBuffer.fill(0);
    this.shakeIndex = 0;
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function nowFrom(ts: number): number {
  return performance.now() - ts;
}

export interface DanceCameraConfig {
  followStrength?: number;
  swayStrength?: number;
  rotationStrength?: number;
  zoomStrength?: number;
  shakeStrength?: number;
  returnSpeed?: number;
}
