/**
 * TouchReactionController — zone-aware reactions to pointer touches.
 *
 * Zone detection is deliberately approximate and name-agnostic (see
 * touchZones.ts). Design rules honoured here:
 *
 *   - Never interrupts dance: the caller gates on the ASM dance state before
 *     this controller runs, and `playGesture` is a request, not a preemption —
 *     the ASM's existing DanceLock ignores it while she is dancing.
 *   - Never touches TTS / lip-sync / Live: it only queues expression overlays,
 *     nudges bones additively, and pushes physics chains. Speech continues.
 *   - Every expressive reaction is debounced per zone plus a global floor, so
 *     repeated touches cannot spam overlays or gestures. Physics impulses are
 *     NOT debounced — they are cheap, purely local, and feel wrong when
 *     swallowed.
 */

import * as THREE from "three";
import { PHYSICS_CONFIG } from "./physicsConfig";
import { classifyTouchZone, type TouchAnchors, type TouchZone } from "./touchZones";

export type TouchReactionDeps = {
  /** Queue expression overlays (happy, embarrassed, blush…). */
  queueEmotion(emotion: string, intensity: number, duration: number): void;
  /** Brief closed-eye beat after a head pat (expression layer owns the morph). */
  forceEyesClosed(durationSec: number): void;
  /** Request the ASM "gesture" state (high-five style wave). Dance-safe. */
  playGesture(): void;
  /** Localised physics impulse at the touch point. */
  impulseAt(point: THREE.Vector3, strengthScale: number): void;
  /** Haptic feedback — vibrate on poke. */
  haptics: { poke(): boolean };
  /** True while the ASM is in the dance state — reactions must no-op. */
  isDancing(): boolean;
  /** True while TTS speech is playing — soften overlays so lip-sync leads. */
  isSpeaking(): boolean;
};

/** Tuneables, all from PHYSICS_CONFIG.touch. */
const CFG = PHYSICS_CONFIG.touch;

export class TouchReactionController {
  private readonly deps: TouchReactionDeps;
  private readonly getCamera: () => THREE.Camera | null;
  private readonly anchors: TouchAnchors;

  /** Last fire time per zone + global floor (ms, performance.now clock). */
  private lastAt: Partial<Record<TouchZone, number>> = {};
  /** -Infinity so the very first touch after construction is never swallowed. */
  private globalLastAt = Number.NEGATIVE_INFINITY;

  // ── Lean / recoil envelopes (additive; decay to zero) ──
  private leanPhase: "idle" | "in" | "hold" | "out" = "idle";
  private leanTimer = 0;
  private leanCurrent = 0;
  private leanSign: 1 | -1 = 1;
  private recoilPhase: "idle" | "in" | "hold" | "out" = "idle";
  private recoilTimer = 0;
  private recoilCurrent = 0;

  /**
   * Fired once per head-pat so the React layer can spawn heart FX. Carries the
   * world-space touch point; the consumer projects it to screen space.
   */
  onHeartBurst?: (point: THREE.Vector3) => void;

  constructor(
    deps: TouchReactionDeps,
    getCamera: () => THREE.Camera | null,
    anchors: TouchAnchors,
    /** Injectable for tests; defaults to the wall clock. */
    private readonly nowMs: () => number = () => performance.now(),
  ) {
    this.deps = deps;
    this.getCamera = getCamera;
    this.anchors = anchors;
  }

  // ── Entry point ─────────────────────────────────────────

  /**
   * Handle one raycast hit.
   *
   * @param hitObject the exact object the ray hit (mesh or bone).
   * @param point     world-space hit point.
   * @param normal    world-space surface normal at the hit.
   */
  onTouch(hitObject: THREE.Object3D | null, point: THREE.Vector3, normal: THREE.Vector3): void {
    if (this.deps.isDancing()) return; // design rule: dance always wins

    const zone = classifyTouchZone(
      { hitObject, point, normal, camera: this.getCamera() },
      this.anchors,
      CFG,
    );

    // Physics always reacts — localised shove away from the finger.
    this.deps.impulseAt(point, zone === "hair" ? CFG.hairStrengthScale : 1);

    // Haptic feedback — vibrate on poke.
    this.deps.haptics.poke();

    // Expressive reactions are debounced; physics is not.
    const now = this.nowMs();
    if (!this.canFire(zone, now)) return;

    switch (zone) {
      case "head":
        this.headPat(point);
        break;
      case "face":
        this.faceTouch();
        break;
      case "hands":
        this.handTouch();
        break;
      case "hair":
        // Hair-mesh hits at crown height are still a head pat: most VRMs
        // cover the head with a Hair skinned mesh, so the ray never reaches
        // a head-classified object. The physics impulse above already ran
        // with the stronger hair scale — consistent with stroking hair.
        if (this.isCrownTouch(point)) {
          this.headPat(point);
        }
        break;
      case "body":
        // Physics impulse already fired; nothing expressive for these zones.
        break;
    }
  }

  // ── Per-frame envelope update ───────────────────────────

  /**
   * Advance the lean/recoil envelopes. Call once per frame from the controller
   * update, AFTER animation bones are written and BEFORE vrm.update() — the
   * same contract physics.update already obeys (additive on top of the pose).
   *
   * @returns additive rotation offsets in radians.
   */
  update(dt: number): { headZ: number; torsoX: number } {
    dt = Math.min(dt, 0.033);

    // Head lean into the palm: rise → hold → fall.
    let headZ = 0;
    if (this.leanPhase !== "idle") {
      this.leanTimer += dt;
      if (this.leanPhase === "in") {
        this.leanCurrent = Math.min(1, this.leanTimer / CFG.leanInSec);
        if (this.leanCurrent >= 1) {
          this.leanPhase = "hold";
          this.leanTimer = 0;
        }
      } else if (this.leanPhase === "hold") {
        this.leanCurrent = 1;
        if (this.leanTimer >= CFG.leanHoldSec) {
          this.leanPhase = "out";
          this.leanTimer = 0;
        }
      } else {
        this.leanCurrent = Math.max(0, 1 - this.leanTimer / CFG.leanOutSec);
        if (this.leanCurrent <= 0) this.leanPhase = "idle";
      }
      const eased = this.leanCurrent * this.leanCurrent * (3 - 2 * this.leanCurrent);
      headZ = this.leanSign * eased * CFG.leanRad;
    }

    // Face recoil: lean the torso back (negative X pitches away from camera).
    let torsoX = 0;
    if (this.recoilPhase !== "idle") {
      this.recoilTimer += dt;
      const hold = CFG.leanHoldSec * 0.5;
      if (this.recoilPhase === "in") {
        this.recoilCurrent = Math.min(1, this.recoilTimer / CFG.leanInSec);
        if (this.recoilCurrent >= 1) {
          this.recoilPhase = "hold";
          this.recoilTimer = 0;
        }
      } else if (this.recoilPhase === "hold") {
        this.recoilCurrent = 1;
        if (this.recoilTimer >= hold) {
          this.recoilPhase = "out";
          this.recoilTimer = 0;
        }
      } else {
        this.recoilCurrent = Math.max(0, 1 - this.recoilTimer / CFG.leanOutSec);
        if (this.recoilCurrent <= 0) this.recoilPhase = "idle";
      }
      const eased = this.recoilCurrent * this.recoilCurrent * (3 - 2 * this.recoilCurrent);
      torsoX = -eased * CFG.recoilRad;
    }

    return { headZ, torsoX };
  }

  /** Cancel in-flight envelopes (dispose / state reset). */
  reset(): void {
    this.leanPhase = "idle";
    this.leanTimer = 0;
    this.leanCurrent = 0;
    this.recoilPhase = "idle";
    this.recoilTimer = 0;
    this.recoilCurrent = 0;
  }

  // ── Zone reactions ──────────────────────────────────────

  /**
   * A touch near or above the head anchor's height reads as a pat on the
   * crown, however the mesh that was hit is named. Tolerance below the
   * anchor covers pats on top-of-head hair strands.
   */
  private isCrownTouch(point: THREE.Vector3): boolean {
    const head = this.anchors.head;
    if (!head) return false;
    // Read fresh every call: the head bobs with idle/dance animation, so a
    // cached height goes stale the moment the pose changes.
    head.updateWorldMatrix(true, false);
    const headY = head.matrixWorld.elements[13];
    return point.y >= headY - 0.14;
  }

  /** Head pat: happy, eyes close, lean into the hand, optional hearts. */
  private headPat(point: THREE.Vector3): void {
    this.deps.queueEmotion("happy", 0.7, 2.2);
    this.deps.forceEyesClosed(CFG.eyesClosedSec);

    // Lean toward whichever side was touched (sign from hit local X).
    this.leanSign = point.x >= 0 ? 1 : -1;
    this.leanPhase = "in";
    this.leanTimer = 0;
    this.leanCurrent = 0;

    this.onHeartBurst?.(point);
  }

  /** Face touch: bashful, blush, small step back. */
  private faceTouch(): void {
    // While TTS is speaking, keep overlays subtle so lip-sync stays legible.
    const soft = this.deps.isSpeaking() ? 0.55 : 0.85;
    this.deps.queueEmotion("embarrassed", soft, 2.6);
    this.deps.queueEmotion("blush", soft, 2.6);
    this.recoilPhase = "in";
    this.recoilTimer = 0;
    this.recoilCurrent = 0;
  }

  /** Hand/arm touch: a short high-five style wave. */
  private handTouch(): void {
    this.deps.queueEmotion("happy", 0.4, 1.6);
    this.deps.playGesture();
  }

  // ── Debounce ────────────────────────────────────────────

  private canFire(zone: TouchZone, now: number): boolean {
    const per = CFG.cooldownMs[zone];
    if (now - this.globalLastAt < CFG.globalCooldownMs) return false;
    if (now - (this.lastAt[zone] ?? Number.NEGATIVE_INFINITY) < per) return false;
    this.lastAt[zone] = now;
    this.globalLastAt = now;
    return true;
  }
}
