/***
 * Document-level stage-gesture recognizer — tap, double-tap, long-press,
 * swipe-up, two-finger-tap — using the same pointer event model the renderer
 * already installs for drag, with capture where appropriate.
 *
 * The recognizer itself has no WebGL, no scene-graph, and no per-frame loop.
 * Every pointer event writes into a small shared record, then a single
 * classify() step decides whether a gesture fired. After resolution the record
 * is cleared so nothing stale can leak.
 *
 * Two-finger tap: two distinct pointers both land and lift inside a short,
 * nearly-stationary window. We track per-pid down/up for the primary gesture
 * *and* for any secondary pointer that comes down while the primary is active;
 * on primary-up we try to compose them into a two-finger-tap only when both
 * stayed near their down positions.
 *
 * Caution: this recognizer intentionally keeps the stage-side touches separate
 * from OrbitControls (which is driven by the renderer's own interaction div and
 * by OrbitControls' internal handlers). The stage gestures never block or
 * modify OrbitControls.
 */

export interface StageGestureCallbacks {
  /** Normal-mode double-tap emote. Must be a no-op while dancing (see dance-gate layer). */
  onDoubleTap(): void;
  /** Stage-level two-finger confetti burst. Safe during dance. */
  onTwoFingerTap(): void;
  /** Stage-level swipe-up dance-intensity boost. Safe during dance. */
  onSwipeUp(): void;
}

export interface PointerRecord {
  pointerId: number;
  downTime: number;
  upTime: number;
  downX: number;
  downY: number;
  upX: number;
  upY: number;
  movedPx: number;
  elapsedMs: number;
}

export interface StageGestureState {
  readonly primaryDown: PointerRecord | null;
  readonly primaryUp: PointerRecord | null;
}

export type ScratchGesture =
  | "tap"
  | "double-tap"
  | "long-press"
  | "swipe-up"
  | "two-finger-tap"
  | null;

type ActivePointer = {
  down: PointerRecord;
  up: PointerRecord | null;
  lastX: number;
  lastY: number;
  moved: boolean;
};

const PRIMARY_BUTTON = 0;
const TOLERANCE_PX = 8;
const TAP_MS_MAX = 300;
const LONG_PRESS_MS = 600;
const TWO_FINGER_MS = 320;
const TWO_FINGER_PX = 10;
const SWIPE_UP_PX = 12;

export class StageGestureRecognizer {
  private readonly callbacks: StageGestureCallbacks;
  private readonly rectEl: HTMLElement;
  private readonly documentListeners: Array<() => void> = [];

  constructor(callbacks: StageGestureCallbacks, rectEl: HTMLElement) {
    this.callbacks = callbacks;
    this.rectEl = rectEl;
    this.attachDocument();
  }

  // ── Public pointer bridge (no doc listeners / no side effects) ─────────────────────

  /** Expose onPointerDown so the renderer can forward pointerdown without installing
   * its own document listeners. When installed at the renderer's capture-phase handler,
   * this runs before OrbitControls' bubble listener — the recognizer never blocks orbit.
   */
  onPointerDown(e: PointerEvent): void {
    this.docOnPointerDown(e);
  }

  onPointerMove(e: PointerEvent): void {
    this.docOnPointerMove(e);
  }

  onPointerUp(e: PointerEvent): void {
    this.docOnPointerUp(e);
  }

  onPointerCancel(e: PointerEvent): void {
    this.docOnPointerUp(e);
  }

  // ── Internal recognizer ────────────────────────────────────────────────────────────

  /** Reused saved state for the active primary pointer. */
  private primary: ActivePointer = {
    down: emptyRecord(),
    up: null,
    lastX: 0,
    lastY: 0,
    moved: false,
  };
  /** Per-pid secondary pointer state (second finger, stylus, etc.). */
  private secondaries: Map<number, ActivePointer> = new Map();
  /** Recently lifted records — used by the double-tap window. */
  private liftRecords: PointerRecord[] = [];
  /** Last confirmed tap record; cleared once it participates in a double-tap. */
  private lastTap: PointerRecord | null = null;
  /** Most recently classified gesture; cleared after it is read by the caller. */
  private gestureBuffer: ScratchGesture | null = null;

  private attachDocument(): void {
    const onDown = (e: PointerEvent) => this.onPointerDown(e);
    const onMove = (e: PointerEvent) => this.onPointerMove(e);
    const onUp = (e: PointerEvent) => this.onPointerUp(e);
    const onCancel = (e: PointerEvent) => this.onPointerUp(e);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
    this.documentListeners.push(
      () => document.removeEventListener("pointerdown", onDown),
      () => document.removeEventListener("pointermove", onMove),
      () => document.removeEventListener("pointerup", onUp),
      () => document.removeEventListener("pointercancel", onCancel),
    );
  }

  private detachDocument(): void {
    for (const un of this.documentListeners) un();
    this.documentListeners.length = 0;
  }

  private docOnPointerDown(e: PointerEvent): void {
    if (e.button !== PRIMARY_BUTTON) return;
    const pos = this.normalize(e.clientX, e.clientY);
    const rec = makeRecord(
      e.pointerId,
      e.isPrimary ? "primary" : "secondary",
      pos.x,
      pos.y,
      performance.now(),
      0,
    );
    if (e.isPrimary) {
      this.secondaries.clear();
      this.liftRecords = [];
      this.lastTap = null;
      this.gestureBuffer = null;
      this.primary = { down: rec, up: null, lastX: pos.x, lastY: pos.y, moved: false };
    } else {
      const existing = this.secondaries.get(e.pointerId);
      if (!existing) {
        this.secondaries.set(e.pointerId, {
          down: rec,
          up: null,
          lastX: pos.x,
          lastY: pos.y,
          moved: false,
        });
      } else {
        existing.lastX = pos.x;
        existing.lastY = pos.y;
      }
    }
  }

  private docOnPointerMove(e: PointerEvent): void {
    if (e.button !== PRIMARY_BUTTON) return;
    const pos = this.normalize(e.clientX, e.clientY);
    if (e.isPrimary && this.primary.down) {
      this.primary.lastX = pos.x;
      this.primary.lastY = pos.y;
      const moved = Math.hypot(pos.x - this.primary.down.downX, pos.y - this.primary.down.downY);
      if (moved > TOLERANCE_PX) {
        this.primary.moved = true;
      }
    } else {
      const pair = this.secondaries.get(e.pointerId);
      if (pair && pair.down) {
        pair.lastX = pos.x;
        pair.lastY = pos.y;
        const moved = Math.hypot(pos.x - pair.down.downX, pos.y - pair.down.downY);
        if (moved > TOLERANCE_PX) pair.moved = true;
      }
    }
  }

  private docOnPointerUp(e: PointerEvent): void {
    if (e.button !== PRIMARY_BUTTON) return;
    const pos = this.normalize(e.clientX, e.clientY);
    const now = performance.now();
    if (e.isPrimary) {
      if (!this.primary.down) return;
      const up = makeRecord(
        e.pointerId,
        "primary",
        this.primary.down.downX,
        this.primary.down.downY,
        this.primary.down.downTime,
        now,
      );
      up.movedPx = Math.hypot(pos.x - this.primary.down.downX, pos.y - this.primary.down.downY);
      up.elapsedMs = now - up.downTime;
      this.primary.up = up;
      const secondaries = this.allSecondaries();
      const composed = this.composeTwoFinger(this.primary.down, up, secondaries);
      if (composed) {
        this.invokeOrEnqueue(composed, up, secondaries);
        this.liftRecords = [];
        this.secondaries.clear();
        this.primary.up = null;
        return;
      }
      const single = this.classifyPrimary(this.primary.down, up, secondaries);
      if (single) {
        this.liftRecords.push(up);
        this.gestureBuffer = single;
        if (single === "double-tap") {
          this.callbacks.onDoubleTap();
          this.lastTap = null;
          this.liftRecords = [];
        } else if (single === "swipe-up") {
          this.callbacks.onSwipeUp();
          this.lastTap = null;
          this.liftRecords = [];
        } else {
          this.lastTap = up;
        }
        this.primary.up = null;
      }
    } else {
      const pair = this.secondaries.get(e.pointerId);
      if (pair && pair.down) {
        const up2 = makeRecord(
          e.pointerId,
          "secondary",
          pair.down.downX,
          pair.down.downY,
          pair.down.downTime,
          now,
        );
        up2.movedPx = Math.hypot(pos.x - pair.down.downX, pos.y - pair.down.downY);
        up2.elapsedMs = now - up2.downTime;
        pair.up = up2;
        this.liftRecords.push(up2);
        this.secondaries.delete(e.pointerId);
      }
    }
  }

  isSwipeUp(down: PointerRecord, up: PointerRecord): boolean {
    if (up.movedPx < SWIPE_UP_PX) return false;
    const dy = up.upY - down.downY;
    const dx = up.upX - down.downX;
    if (dy >= 0) return false;
    if (Math.abs(dx) * 0.4 > Math.abs(dy)) return false;
    return true;
  }

  private classifyPrimary(
    down: PointerRecord,
    up: PointerRecord,
    _secondaries: PointerRecord[],
  ): ScratchGesture | null {
    if (up.movedPx > TOLERANCE_PX) {
      if (this.isSwipeUp(down, up)) return "swipe-up";
      return null;
    }
    if (up.elapsedMs <= TAP_MS_MAX) {
      if (
        this.lastTap &&
        Math.abs(up.downTime - this.lastTap.upTime) < 350 &&
        Math.hypot(up.downX - this.lastTap.downX, up.downY - this.lastTap.downY) <= 12
      ) {
        this.lastTap = null;
        return "double-tap";
      }
      this.lastTap = up;
      return "tap";
    }
    if (up.elapsedMs > LONG_PRESS_MS) {
      return "long-press";
    }
    return null;
  }

  private composeTwoFinger(
    primary: PointerRecord,
    primaryUp: PointerRecord,
    secondaries: PointerRecord[],
  ): ScratchGesture | null {
    if (secondaries.length === 0) return null;
    if (primary.movedPx > TWO_FINGER_PX) return null;
    for (const s of secondaries) {
      if (s.movedPx > TWO_FINGER_PX) return null;
    }
    const firstDown = Math.min(primary.downTime, ...secondaries.map((s) => s.downTime));
    const lastUp = Math.max(primaryUp.upTime, ...secondaries.map((s) => s.upTime));
    if (lastUp - firstDown > TWO_FINGER_MS) return null;
    return "two-finger-tap";
  }

  private allSecondaries(): PointerRecord[] {
    const arr: PointerRecord[] = [];
    for (const p of this.secondaries.values()) {
      if (p.up) arr.push(p.up);
    }
    return arr;
  }

  /** Deterministic compute() — returns the latest classified gesture without
   * firing any callbacks. Designed so the same recognizer can be driven by
   * real pointer events in the app and by synthetic events in tests.
   */
  compute(): { primary: StageGestureState; gesture: ScratchGesture } {
    return {
      primary: {
        primaryDown: this.primary.down,
        primaryUp: this.primary.up ?? null,
      },
      gesture: this.gestureBuffer,
    };
  }

  reset(): void {
    this.primary = { down: emptyRecord(), up: null, lastX: 0, lastY: 0, moved: false };
    this.secondaries.clear();
    this.liftRecords = [];
    this.lastTap = null;
    this.gestureBuffer = null;
  }

  dispose(): void {
    this.detachDocument();
    this.secondaries.clear();
    this.liftRecords = [];
    this.primary = { down: emptyRecord(), up: null, lastX: 0, lastY: 0, moved: false };
    this.lastTap = null;
    this.gestureBuffer = null;
  }

  private invokeOrEnqueue(
    gesture: ScratchGesture,
    _primaryUp: PointerRecord,
    _secondaries: PointerRecord[],
  ): void {
    this.gestureBuffer = gesture;
    if (gesture === "two-finger-tap") {
      this.callbacks.onTwoFingerTap();
    }
  }

  private normalize(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.rectEl.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
}

function makeRecord(
  pointerId: number,
  kind: "primary" | "secondary",
  x: number,
  y: number,
  downTime: number,
  upTime: number,
): PointerRecord {
  return {
    pointerId,
    downTime,
    upTime,
    downX: x,
    downY: y,
    upX: x,
    upY: y,
    movedPx: 0,
    elapsedMs: upTime - downTime,
  };
}

function emptyRecord(): PointerRecord {
  return {
    pointerId: -1,
    downTime: 0,
    upTime: 0,
    downX: 0,
    downY: 0,
    upX: 0,
    upY: 0,
    movedPx: 0,
    elapsedMs: 0,
  };
}
