import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { EventBus } from "./EventBus";

// ── Types ────────────────────────────────────────────────

export type BaseEmotion = "neutral" | "happy" | "sad";

export interface ExpressionQueueItem {
  emotion: string;
  intensity: number;
  duration: number;
}

// Each base emotion contributes these morph values
const BASE_MAP: Record<string, Record<string, number>> = {
  neutral: {},
  happy: { happy: 0.35 },
  sad: { sad: 0.35 },
};

// Each overlay emotion contributes these morph values (added on top of base)
const OVERLAY_MAP: Record<string, Record<string, number>> = {
  blush: { happy: 0.08, surprised: 0.04 },
  surprised: { surprised: 0.7 },
  angry: { angry: 0.6 },
  happy: { happy: 0.35 },
  sad: { sad: 0.35 },
  excited: { happy: 0.4, surprised: 0.25 },
  nervous: { surprised: 0.25 },
  annoyed: { angry: 0.3 },
  embarrassed: { happy: 0.12, surprised: 0.08 },
  // 18+ overlay emotions (safe morph combos that work on any VRM)
  kiss: { happy: 0.2, surprised: 0.15 },
  heart: { happy: 0.5, surprised: 0.25 },
  bedroom: { happy: 0.08, surprised: 0.05 },
  shy: { happy: 0.1, surprised: 0.12 },
};

// ── Controller ──────────────────────────────────────────

export class ExpressionController {
  private exp: VRM["expressionManager"] | null;

  // Base emotion — persistent mood, decays to neutral after inactivity
  private baseEmotion: BaseEmotion = "neutral";
  private baseDecayTimer = 0;
  private readonly BASE_DECAY_TIME = 25;

  // Currently displayed morph values (lerped each frame for smoothness)
  private currentValues = new Map<string, number>();

  // Overlay queue — processes FIFO; each overlay blends in, holds, blends out
  private queue: ExpressionQueueItem[] = [];
  private activeOverlay: {
    emotion: string;
    intensity: number;
    timer: number;
    duration: number;
    phase: "in" | "hold" | "out";
  } | null = null;

  // Blink
  private blinkTimer = 0;
  private nextBlink = 2 + Math.random() * 3;
  private blinkValue = 0;

  // Forced wink (blinkL / blinkR)
  private winkTimer = 0;

  // Mic-driven mouth open (aa)
  private micMouthTarget = 0;

  constructor(
    private vrm: VRM,
    private events: EventBus,
  ) {
    this.exp = vrm?.expressionManager ?? null;
  }

  // ── Public API ──────────────────────────────────────────

  /** Set the persistent base emotion. Decays back to "neutral" after ~25s of inactivity. */
  setBaseEmotion(e: BaseEmotion): void {
    if (e === this.baseEmotion) return;
    this.baseEmotion = e;
    this.baseDecayTimer = 0;
    this.events.emit("expression:base", { emotion: e });
  }

  get currentBaseEmotion(): BaseEmotion {
    return this.baseEmotion;
  }

  /** Push a temporary overlay expression onto the queue. Plays immediately if queue is empty. */
  queueEmotion(item: ExpressionQueueItem): void {
    this.queue.push(item);
    if (!this.activeOverlay) {
      this.processQueue();
    }
  }

  /** Cancel all pending overlays. Current overlay (if any) completes normally. */
  clearQueue(): void {
    this.queue = [];
  }

  /** Cancel everything and instantly return to neutral base. */
  resetAll(): void {
    this.queue = [];
    this.activeOverlay = null;
    this.baseEmotion = "neutral";
    this.baseDecayTimer = 0;
    this.currentValues.clear();
  }

  /** Force a quick wink on one eye (uses blinkL/blinkR if available, else half-blink). */
  forceWink(side: "left" | "right"): void {
    const morphName = side === "left" ? "blinkL" : "blinkR";
    if (this.exp?.getValue(morphName) !== undefined) {
      this.currentValues.set(morphName, 1);
      this.winkTimer = 0.15;
    } else {
      // Fallback: half-close both eyes
      this.blinkValue = 0.5;
      this.winkTimer = 0.15;
    }
  }

  /** Set mic-driven mouth open value (0-1). Drives 'aa' morph for audio reactivity. */
  setMicMouthOpen(value: number): void {
    this.micMouthTarget = Math.max(0, Math.min(1, value));
  }

  // ── Internal ────────────────────────────────────────────

  private processQueue(): void {
    if (this.queue.length === 0) {
      this.activeOverlay = null;
      return;
    }
    const item = this.queue.shift()!;
    this.activeOverlay = {
      emotion: item.emotion,
      intensity: Math.max(0, Math.min(1, item.intensity)),
      timer: 0,
      duration: Math.max(0.3, item.duration),
      phase: "in",
    };
    this.events.emit("expression:overlay", {
      emotion: item.emotion,
      intensity: item.intensity,
      duration: item.duration,
    });
  }

  update(dt: number, animState: string, waifuState: string): void {
    dt = Math.min(dt, 0.033);
    const exp = this.exp;
    if (!exp) return;

    // ── Base emotion decay ──────────────────────────────
    if (this.baseEmotion !== "neutral") {
      this.baseDecayTimer += dt;
      if (this.baseDecayTimer >= this.BASE_DECAY_TIME) {
        this.baseEmotion = "neutral";
        this.baseDecayTimer = 0;
        this.events.emit("expression:decayed", { emotion: "neutral" });
      }
    }

    // ── Compute target morph values ─────────────────────
    const targetValues = new Map<string, number>();

    // 1. Base emotion contribution
    const baseMorphs = BASE_MAP[this.baseEmotion] || {};
    for (const [morph, value] of Object.entries(baseMorphs)) {
      targetValues.set(morph, (targetValues.get(morph) || 0) + value);
    }

    // 1b. Mic-driven mouth open (aa) - highest priority for audio reactivity
    if (this.micMouthTarget > 0) {
      targetValues.set("aa", this.micMouthTarget);
    }

    // 2. Active overlay contribution
    let overlayBlend = 0;
    if (this.activeOverlay) {
      this.activeOverlay.timer += dt;
      const ov = this.activeOverlay;
      const BLEND_IN = 0.3;
      const BLEND_OUT = 0.5;

      if (ov.phase === "in") {
        overlayBlend = Math.min(1, ov.timer / BLEND_IN);
        if (overlayBlend >= 1) {
          ov.phase = "hold";
          ov.timer = 0;
        }
      } else if (ov.phase === "hold") {
        overlayBlend = 1;
        if (ov.timer >= ov.duration) {
          ov.phase = "out";
          ov.timer = 0;
        }
      } else if (ov.phase === "out") {
        overlayBlend = Math.max(0, 1 - ov.timer / BLEND_OUT);
        if (overlayBlend <= 0) {
          this.processQueue();
        }
      }

      const overlayMorphs = OVERLAY_MAP[ov.emotion] || {};
      for (const [morph, value] of Object.entries(overlayMorphs)) {
        const contribution = value * ov.intensity * overlayBlend;
        targetValues.set(morph, (targetValues.get(morph) || 0) + contribution);
      }
    }

    // ── Blink (periodic natural eyes) ──────────────────
    this.blinkTimer += dt;
    if (this.blinkTimer > this.nextBlink) {
      const phase = this.blinkTimer - this.nextBlink;
      this.blinkValue = phase < 0.08 ? phase / 0.08 : phase < 0.18 ? 1 - (phase - 0.08) / 0.1 : 0;
      if (phase > 0.2) {
        this.blinkTimer = 0;
        this.nextBlink = 2 + Math.random() * 3;
      }
    } else if (this.winkTimer <= 0) {
      this.blinkValue = 0;
    }

    // Forced wink decay
    if (this.winkTimer > 0) {
      this.winkTimer -= dt;
      if (this.winkTimer <= 0) {
        this.currentValues.delete("blinkL");
        this.currentValues.delete("blinkR");
        this.blinkValue = 0;
        exp.setValue("blinkL", 0);
        exp.setValue("blinkR", 0);
        exp.setValue("blink", 0);
      }
    }

    exp.setValue("blink", this.blinkValue);

    // ── Smooth apply all tracked morphs ────────────────
    const lerpRate = Math.min(1, dt * 8);
    const allMorphs = new Set([...this.currentValues.keys(), ...targetValues.keys()]);
    for (const morph of allMorphs) {
      const target = targetValues.get(morph) ?? 0;
      const current = this.currentValues.get(morph) ?? 0;
      const clamped = Math.max(0, Math.min(1, target));
      const next = THREE.MathUtils.lerp(current, clamped, lerpRate);
      if (Math.abs(next - current) > 0.001) {
        this.currentValues.set(morph, next);
        exp.setValue(morph, next);
      } else if (!this.currentValues.has(morph) && next > 0) {
        this.currentValues.set(morph, next);
        exp.setValue(morph, next);
      }
    }
  }

  // ── Cleanup ──────────────────────────────────────────────

  dispose(): void {
    this.exp = null;
    this.queue = [];
    this.activeOverlay = null;
    this.currentValues.clear();
  }
}
