import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import type { QualitySettings } from "../performance";
import { HairPhysics } from "./HairPhysics";
import { ClothPhysics } from "./ClothPhysics";
import { TailPhysics } from "./TailPhysics";
import { AccessoryPhysics } from "./AccessoryPhysics";
import { IdleMotionSystem } from "./IdleMotionSystem";
import { BodyColliders } from "./BodyColliders";
import { HipMotionTracker } from "./HipMotionTracker";
import type { HipInertiaDrive } from "./PhysicsBone";
import { PHYSICS_CONFIG, stateMotion, type ColliderSet } from "../physicsConfig";

/** Live music snapshot used for physics reactions. */
export interface PhysicsAudio {
  intensity: number;
  bass: number;
  beat: boolean;
}

/**
 * Structural view of an active pointer drag (owned by touchDrag.ts; SPM only
 * reads it). While `active`, nearby Verlet points near `grab` are pulled
 * toward `target` with a clamped spring each fixed substep.
 */
export interface DragForceState {
  readonly active: boolean;
  /** Chain family under the finger: "hair" | "tail" | "ear" | "accessory" | "cloth". */
  readonly category: string;
  /** Projected pointer target (world space). */
  readonly target: THREE.Vector3;
  /** World-space grab point — the falloff anchor. */
  readonly grab: THREE.Vector3;
}

/**
 * SecondaryPhysicsManager — orchestrates all secondary motion and physics
 * subsystems for the VRM character.
 *
 * Update order (must run AFTER animation bone updates, BEFORE vrm.update()):
 *   1. HairPhysics    — Verlet hair chains
 *   2. ClothPhysics   — Verlet clothing/skirt chains
 *   3. TailPhysics    — Verlet tail chain with idle wag
 *   4. AccessoryPhysics — Spring-damper for accessories + ears
 *   5. IdleMotionSystem — Breathing, body sway, head micro, eye blink/saccade
 *
 * Dance motion is driven by the choreography, not by the music: every frame the
 * hips' world motion is sampled (HipMotionTracker) and fed to the chains as
 * opposite-direction inertia, so hip forward → strands lag back, hip left →
 * strands lag right, and a spin flings them outward. The beat kick still exists
 * but is a subtle musical additive on top of that.
 *
 * Each subsystem is optional — missing bones are handled gracefully.
 */
export class SecondaryPhysicsManager {
  readonly hair: HairPhysics;
  readonly cloth: ClothPhysics;
  readonly tail: TailPhysics;
  readonly accessories: AccessoryPhysics;
  readonly idle: IdleMotionSystem;

  /** Beat edge-detection — the analyser reports `beat` true for several frames. */
  private lastBeatAt = 0;
  private scratchForce = new THREE.Vector3();
  /**
   * Reads the hips' world motion (position + yaw) straight off the skeleton —
   * the choreography is the primary source of dance motion.
   */
  private readonly hipMotion: HipMotionTracker;
  /** Reusable per-frame hip drive, owned by this manager. */
  private readonly hipDrive: HipInertiaDrive = {
    pivot: new THREE.Vector3(),
    linear: new THREE.Vector3(),
    tangential: 0,
    centrifugal: 0,
    maxForce: PHYSICS_CONFIG.global.hipInertia.maxForce,
    active: false,
  };
  /** Debug: last linear inertia magnitude (m/s²). */
  private lastHipForce = 0;
  /** Per-state response of the last hip drive — reused by the skirt flare. */
  private hipStateGain = 0;
  /** Fixed-step accumulator so spring response is frame-rate independent. */
  private physicsAcc = 0;
  /** Touch-reaction envelope (radians) + the bones to write it to. */
  private touchEnvHeadZ = 0;
  private touchEnvTorsoX = 0;
  private touchHeadNode: THREE.Object3D | null = null;
  private touchChestNode: THREE.Object3D | null = null;
  private readonly MAX_STEPS = PHYSICS_CONFIG.global.maxSteps;
  /** Active budget — driven by the quality tier via setQuality(). */
  private stepHz: number = PHYSICS_CONFIG.global.physicsHz;
  private iterations: number = PHYSICS_CONFIG.bone.chainIterations;
  private flutter = true;
  private colliders: ColliderSet = "full";
  private body: BodyColliders;
  /** Active pointer drag — a borrowed view (touchDrag.ts owns the vectors). */
  private drag: DragForceState | null = null;

  constructor(private vrm: VRM) {
    this.hipMotion = new HipMotionTracker(vrm);
    this.hair = new HairPhysics(vrm);
    this.cloth = new ClothPhysics(vrm);
    this.tail = new TailPhysics(vrm);
    this.accessories = new AccessoryPhysics(vrm);
    this.idle = new IdleMotionSystem(vrm);
    this.body = new BodyColliders(vrm);
  }

  /** Apply the active quality tier's physics budget. */
  setQuality(q: QualitySettings): void {
    if (q.physicsHz !== this.stepHz) {
      this.stepHz = q.physicsHz;
      this.physicsAcc = 0; // avoid a stale carry-over debt on rate change
    }
    this.iterations = q.physicsIterations;
    this.flutter = q.physicsFlutter;
    this.colliders = q.physicsColliders;
    // The spin-aware skirt flare is the one subsystem with a per-tier scale:
    // LOW turns it off entirely (see PHYSICS_CONFIG.cloth.spinFlare.tierScale).
    this.cloth.setQuality(q.tier);
  }

  /**
   * Update all physics subsystems.
   *
   * @param dt Delta time in seconds.
   * @param animState Current animation state string (e.g. "idle", "dance", "talking").
   * @param isIdle Whether the character is in an idle/relaxed state.
   * @param isSpeaking Whether TTS voice is currently playing.
   * @param audio Optional live music features — drives hair/cloth/tail beat kicks.
   */
  update(
    dt: number,
    animState: string,
    isIdle: boolean,
    isSpeaking: boolean,
    audio?: PhysicsAudio,
  ): void {
    // 1. Physics subsystems (bone-level Verlet integration) at the budget's
    //    fixed rate (60/90/120 Hz by tier), decoupled from the render rate so
    //    spring response stays identical at any FPS. The accumulator is capped
    //    (0.05 s) and the step count bounded so a long frame can never spiral.
    // Body colliders are refreshed once per render frame (bone matrices don't
    // change between substeps), then each subsystem applies them per bone.
    this.body.update();

    // 0. Read the choreography once per rendered frame — the hips' world
    //    position, velocity, acceleration and yaw. Sampling per substep would
    //    differentiate the same motion over a smaller dt and add nothing but
    //    noise, so every substep of this frame shares one hip drive.
    this.hipMotion.sample(dt);
    this.updateHipDrive(animState);

    // 0b. Spin-aware skirt flare (PROMPT 14) — one envelope step per rendered
    //     frame from that same hip read, so the skirt hems are pushed outward
    //     while the choreography really spins her and settle back when it
    //     stops. Yaw rate 0 (no hip bone, or a calm state) decays the envelope
    //     to zero, so the skirt can never stay inflated.
    this.cloth.updateSpinFlare(
      dt,
      this.hipDrive.active ? this.hipMotion.yawRate : 0,
      this.hipDrive.pivot,
      this.hipStateGain,
    );

    this.physicsAcc = Math.min(this.physicsAcc + dt, PHYSICS_CONFIG.global.accumulatorCap);
    const step = 1 / this.stepHz;
    let steps = 0;
    while (this.physicsAcc >= step && steps < this.MAX_STEPS) {
      // Pointer-drag spring (normal modes only — the caller never attaches a
      // drag while dancing). Applied before the subsystem updates so the pull
      // integrates in the same substep as sway/gravity.
      if (this.drag?.active) this.applyDragStep();

      // Choreography inertia — the primary dance force. Applied before each
      // subsystem integrates, per substep, so the strands fight the body's
      // motion instead of being shoved by a random impulse.
      this.hair.applyHipInertia(this.hipDrive);
      this.cloth.applyHipInertia(this.hipDrive);
      this.tail.applyHipInertia(this.hipDrive);
      this.accessories.applyHipInertia(this.hipDrive);
      this.hair.update(step, animState, {
        iterations: this.iterations,
        flutter: this.flutter,
        colliders: this.colliders,
        body: this.body,
      });
      this.cloth.update(step, animState, {
        iterations: this.iterations,
        flutter: this.flutter,
        colliders: this.colliders,
        body: this.body,
      });
      this.tail.update(step, animState, {
        iterations: this.iterations,
        flutter: this.flutter,
        colliders: this.colliders,
        body: this.body,
      });
      this.accessories.update(step, animState, {
        iterations: this.iterations,
        flutter: this.flutter,
        colliders: this.colliders,
        body: this.body,
      });
      this.physicsAcc -= step;
      steps++;
    }
    // If we hit MAX_STEPS the accumulator still holds debt — drop it so a
    // long gap never turns into a burst of catch-up steps next frame.
    if (steps >= this.MAX_STEPS) {
      this.physicsAcc = 0;
    }

    // 2. Beat-reactive secondary motion: every detected kick sends a short
    //    impulse down the hair/cloth/tail chains so the body physically
    //    answers the music instead of only the skeleton keyframes.
    //    Units are m/s² of acceleration — gravity is ~9.81 here, so a kick
    //    must land in the 1–6 band to be visible against spring restoration.
    if (audio && audio.beat) {
      const now = performance.now();
      const beatCfg = PHYSICS_CONFIG.global.beat;
      if (now - this.lastBeatAt > beatCfg.debounceMs) {
        this.lastBeatAt = now;
        const energy = beatCfg.energyBase + audio.bass * beatCfg.energyBassShare;
        const amp = (beatCfg.baseAmp + audio.intensity * beatCfg.intensityAmp) * energy;
        // Mostly a clean upward bounce; the random part is scaled down to a
        // subtle additive so the music no longer invents body motion — the
        // hips do that above.
        const jitter = amp * beatCfg.randomShare;
        this.scratchForce.set(
          (Math.random() - 0.5) * jitter,
          amp * (beatCfg.upwardBase + audio.intensity * beatCfg.upwardIntensity),
          (Math.random() - 0.5) * jitter,
        );
        this.hair.applyImpulse(this.scratchForce);
        this.cloth.applyImpulse(this.scratchForce);
        this.tail.applyImpulse(this.scratchForce);
        this.accessories.applyImpulse(this.scratchForce);
      }
    }

    // 3. Idle motion (procedural bone animation + blend shapes)
    this.idle.update(dt, isIdle, isSpeaking);

    // 4. Touch-reaction envelopes — additive head lean / torso recoil written
    //    here (after the mixer pose, before vrm.update()) so they ride on top
    //    of whatever the animation is doing. The mixer rewrites bone rotations
    //    every frame (the same assumption IdleMotionSystem's drift relies on),
    //    so these additive writes never accumulate. The caller holds the
    //    values at zero while dancing: the choreography is never perturbed.
    if (this.touchEnvHeadZ !== 0 && this.touchHeadNode) {
      this.touchHeadNode.rotation.z += this.touchEnvHeadZ;
    }
    if (this.touchEnvTorsoX !== 0 && this.touchChestNode) {
      this.touchChestNode.rotation.x += this.touchEnvTorsoX;
    }
  }

  /**
   * Translate this frame's hip motion into the force the chains feel.
   *
   *   linear      = -(accel * accelGain + vel * velGain) * stateResponse
   *   tangential  = yawAccel * yawAccelGain * stateResponse
   *   centrifugal = yawRate² * centrifugalGain * stateResponse
   *
   * The state response keeps dance at full strength and idle near zero, so the
   * same code reads as a calm sway when she is standing still.
   */
  private updateHipDrive(animState: string): void {
    const cfg = PHYSICS_CONFIG.global.hipInertia;
    const drive = this.hipDrive;
    const m = this.hipMotion;

    if (!m.available) {
      drive.active = false;
      this.lastHipForce = 0;
      this.hipStateGain = 0;
      return;
    }

    const stateGain = stateMotion(cfg.state, animState);
    this.hipStateGain = stateGain;
    drive.active = stateGain > 0.001;
    drive.pivot.copy(m.pivot);
    drive.linear
      .copy(m.acceleration)
      .multiplyScalar(-cfg.accelGain * stateGain)
      .addScaledVector(m.velocity, -cfg.velGain * stateGain);
    drive.tangential = m.yawAcceleration * cfg.yawAccelGain * stateGain;
    drive.centrifugal = m.yawRate * m.yawRate * cfg.centrifugalGain * stateGain;
    drive.maxForce = cfg.maxForce;
    this.lastHipForce = drive.linear.length();
  }

  /**
   * Feed this frame's touch-reaction envelope (radians) and the bones to
   * write it to. Call every frame; zero values are the normal steady state
   * and cost two comparisons.
   */
  setTouchEnvelope(
    env: { headZ: number; torsoX: number },
    nodes: { head: THREE.Object3D | null; chest: THREE.Object3D | null },
  ): void {
    this.touchEnvHeadZ = env.headZ;
    this.touchEnvTorsoX = env.torsoX;
    this.touchHeadNode = nodes.head;
    this.touchChestNode = nodes.chest;
  }

  /**
   * Attach/detach the active pointer drag. The state object is borrowed, not
   * copied — the caller mutates its vectors in place and this manager reads
   * the latest values each substep. Pass null to release (or when dancing).
   */
  setDrag(drag: DragForceState | null): void {
    this.drag = drag;
  }

  /**
   * Route the active drag's clamped spring to the subsystems that own the
   * grabbed chain family. Accessories (ears, dangling baubles) ride along
   * with hair/tail grabs — they hang from the same structures.
   */
  private applyDragStep(): void {
    const d = this.drag;
    if (!d) return;
    switch (d.category) {
      case "hair":
        this.hair.applyDragAt(d.target, d.grab);
        this.accessories.applyDragAt(d.target, d.grab);
        break;
      case "tail":
        this.tail.applyDragAt(d.target, d.grab);
        this.accessories.applyDragAt(d.target, d.grab);
        break;
      case "cloth":
        this.cloth.applyDragAt(d.target, d.grab);
        break;
      case "ear":
      case "accessory":
        this.accessories.applyDragAt(d.target, d.grab);
        break;
    }
  }

  /**
   * Playful poke reaction. With a world-space touch point, pushes hair/cloth/
   * tail/accessories AWAY from that exact spot with distance falloff — strands
   * near the finger blast away, distant ones barely move. Without a point,
   * falls back to a playful random burst through every chain.
   */
  poke(at?: THREE.Vector3, strengthScale = 1): void {
    if (at) {
      // Scale each subsystem's configured strength by `strengthScale` rather
      // than growing four subsystem signatures — the per-system defaults stay
      // owned by PHYSICS_CONFIG.
      this.hair.applyImpulseAt(at, undefined, PHYSICS_CONFIG.hair.pokeStrength * strengthScale);
      this.cloth.applyImpulseAt(at, undefined, PHYSICS_CONFIG.cloth.pokeStrength * strengthScale);
      this.tail.applyImpulseAt(at, undefined, PHYSICS_CONFIG.tail.pokeStrength * strengthScale);
      this.accessories.applyImpulseAt(
        at,
        undefined,
        PHYSICS_CONFIG.accessories.pokeStrength * strengthScale,
      );
      return;
    }
    const burstCfg = PHYSICS_CONFIG.global.poke;
    const burst = () =>
      this.scratchForce.set(
        (Math.random() - 0.5) * burstCfg.burstX,
        burstCfg.burstYBase + Math.random() * burstCfg.burstYSpan,
        (Math.random() - 0.5) * burstCfg.burstZ,
      );
    burst();
    this.hair.applyImpulse(this.scratchForce);
    this.cloth.applyImpulse(this.scratchForce);
    this.tail.applyImpulse(this.scratchForce);
    this.accessories.applyImpulse(this.scratchForce);
  }

  /** Report which subsystems are active. */
  get debugInfo(): Record<string, boolean | number> {
    return {
      hair: this.hair.hasHair,
      hairChains: this.hair.chainCount,
      hairEnergy: Number(this.hair.energy.toFixed(5)),
      cloth: this.cloth.hasCloth,
      clothChains: this.cloth.chainCount,
      skirtChains: this.cloth.skirtChainCount,
      /** Current skirt spin-flare envelope (m/s²) — 0 when not spinning. */
      skirtFlare: Number(this.cloth.flareStrength.toFixed(4)),
      tail: this.tail.hasTail,
      tailChains: this.tail.chainCount,
      accessories: this.accessories.hasAccessories,
      accessoryChains: this.accessories.chainCount,
      // Choreography read-out: what the dance physics is reacting to right now.
      hipSpeed: Number(this.hipMotion.speed.toFixed(4)),
      hipAccel: Number(this.hipMotion.acceleration.length().toFixed(4)),
      hipYawRate: Number(this.hipMotion.yawRate.toFixed(4)),
      hipInertiaForce: Number(this.lastHipForce.toFixed(4)),
      hipDriveActive: this.hipDrive.active,
    };
  }

  /** Reset all physics to rest pose. */
  reset(): void {
    this.hair.reset();
    this.cloth.reset();
    this.tail.reset();
    this.accessories.reset();
    this.idle.reset();
    // Drop motion history so a reset never reads as one huge acceleration.
    this.hipMotion.reset();
    this.hipDrive.active = false;
    this.lastHipForce = 0;
    this.hipStateGain = 0;
  }

  dispose(): void {
    this.hair.dispose();
    this.cloth.dispose();
    this.tail.dispose();
    this.accessories.dispose();
    this.idle.dispose();
  }
}
