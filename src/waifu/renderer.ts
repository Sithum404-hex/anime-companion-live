import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { QualitySettings, FpsCap } from "./performance";
import {
  createVisibilityPause,
  getQualitySettings,
  detectQualityTier,
  resolveFpsCapMs,
} from "./performance";
import { DynamicResolutionScaler, DEFAULT_DRS_CONFIG } from "./dynamicResolution";
import { AdaptiveQualityGovernor, DEFAULT_ADAPTIVE_CONFIG, TIER_ORDER } from "./adaptiveQuality";
import { DanceCameraController } from "./camera/DanceCameraController";

export class Renderer {
  /** Optional dance camera controller, created lazily by RenderingController. */
  danceCamera?: DanceCameraController;

  /** Create the dance camera controller from the existing camera/controls/beat/hips. */
  createDanceCamera(
    beatPulse: () => import("./DanceDirector").BeatPulse,
    hipsNode: THREE.Object3D | null,
  ): void {
    if (this.danceCamera) {
      this.danceCamera.dispose();
    }
    this.danceCamera = new DanceCameraController(this.camera, this.controls, beatPulse, hipsNode);
  }

  /** Update the dance camera each frame. Safe to call when there is no controller. */
  updateDanceCamera(dt: number, animState: string): void {
    this.danceCamera?.update(dt, animState);
  }

  /** Enable/disable the dance camera at runtime. */
  setDanceCameraEnabled(enabled: boolean): void {
    this.danceCamera?.setEnabled(enabled);
  }

  /** Whether the dance camera is currently enabled. */
  get danceCameraEnabled(): boolean {
    return this.danceCamera?.enabled ?? false;
  }

  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  clock = new THREE.Clock();
  private resizeObs?: ResizeObserver;
  private _container: HTMLElement;

  /** The container element the renderer was created in — used by the stage-gesture
   * recognizer for pointer coordinate normalisation. Public read-only. */
  get container(): HTMLElement {
    return this._container;
  }
  private rafId = 0;
  private updaters: ((dt: number) => void)[] = [];
  private visibility: ReturnType<typeof createVisibilityPause>;
  private quality: QualitySettings;
  /**
   * Continuous render-resolution adaptation. It owns the render scale only —
   * the quality tier keeps shadows, AA, tone mapping and the animation /
   * physics budgets, so a resolution change can never move a tier.
   */
  private drs: DynamicResolutionScaler;
  /** Last drawing-buffer size handed to WebGL — guards redundant setSize calls. */
  private appliedW = 0;
  private appliedH = 0;
  private frameCount = 0;
  private lastResizeTime = 0;
  private _controls: OrbitControls;

  /** Public read for runtime camera helpers that must not construct their own controls. */
  get controls(): OrbitControls {
    return this._controls;
  }

  private interactionDom: HTMLDivElement;
  private autoRotateTimer = 0;
  private readonly AUTO_ROTATE_MIN = 8;
  private readonly AUTO_ROTATE_MAX = 10;
  private autoRotateDelay = this.randomDelay();
  private readonly MIN_DIST = 0.8;
  private readonly MAX_DIST = 5.0;
  private readonly MIN_POLAR = 0.2;
  private readonly MAX_POLAR = 1.4;
  private lastFrameTime = 0;
  private fpsSamples: number[] = [];
  private lastFpsEval = 0;
  /**
   * Owns the "may I change tier yet?" decision — thresholds, streak counters and
   * the post-change cooldown that stops LOW/MED bouncing. Pure and DOM-free, so
   * the anti-oscillation behaviour is testable without a WebGL context.
   */
  private adaptive: AdaptiveQualityGovernor;

  /** User-selected frame ceiling and the Max Performance override. */
  private fpsCap: FpsCap = "uncapped";
  private maxPerfMode = false;
  /**
   * Deadline grid for the frame cap.
   *
   * The next frame is due at `capAnchorAt + capFrameIndex * capMs`, and the
   * index is *recomputed* from elapsed time rather than incremented. That detail
   * is the whole point: accumulating `next += capMs` drifts by a float ULP per
   * frame, and on a display whose refresh is an exact multiple of the cap the
   * grid slips off the vblank boundary and never returns — a 30 fps cap on a
   * 60 Hz screen settles into alternating 33/50 ms frames, which is judder and
   * an effective 24 fps. Deriving the index from `now` also resyncs for free
   * after a stall or a hidden tab, with no catch-up burst.
   */
  private capAnchorAt = 0;
  private capFrameIndex = 0;
  private capStarted = false;
  private keyLight: THREE.DirectionalLight | null = null;
  private chestTarget = new THREE.Vector3(0, 1.3, 0);
  private targetFocusTimer = 0;
  /** Current animation state, for callers like the dance camera and debug UI. */
  currentAnimState?: string;

  /** Update the current animation state from the outside (e.g. WaifuCharacterController). */
  updateAnimState(state: string): void {
    this.currentAnimState = state;
  }
  private readonly TARGET_RETURN_DURATION = 1.5;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private clickableRoot: THREE.Object3D | null = null;
  private contextLost = false;
  private onContextLost?: (e: Event) => void;
  private onContextRestored?: () => void;
  isDragging = false;
  onInteractionStart?: () => void;
  onPointerMove?: (nx: number, ny: number) => void;
  /**
   * Fired when a pointer actually hits the character mesh — carries the world
   * hit point, the object the ray actually struck (mesh or bone) and the
   * world-space surface normal, so reactions can be steered by zone.
   */
  onPokeHit?: (
    point: THREE.Vector3,
    touch: boolean,
    hitObject: THREE.Object3D,
    normal: THREE.Vector3,
  ) => void;
  /**
   * Character-drag hooks (normal modes only; dance answers null so the camera
   * keeps the gesture). onDragCheck runs in a capture-phase pointerdown BEFORE
   * OrbitControls sees the event — a non-null return grabs the press: orbit
   * is disabled for that gesture, pointer capture keeps move/up/cancel
   * flowing, and onDragMove receives normalised device coords until
   * pointerup/pointercancel/pointerleave ends it. onDragDrop also fires from
   * dispose() so a component unmount cancels cleanly.
   */
  onDragCheck?: (
    hitObject: THREE.Object3D,
    point: THREE.Vector3,
    normal: THREE.Vector3,
  ) => string | null;
  onDragGrab?: (point: THREE.Vector3, category: string) => void;
  onDragMove?: (nx: number, ny: number) => void;
  onDragDrop?: () => void;
  /**
   * Stage-gesture pointer bridge — forwarded to the document-level recognizer.
   * These are the raw pointer events the recognizer needs; the renderer forwards
   * them without touching OrbitControls.
   */
  onStagePointerDown?: (e: PointerEvent) => void;
  onStagePointerMove?: (e: PointerEvent) => void;
  onStagePointerUp?: (e: PointerEvent) => void;
  onStagePointerCancel?: (e: PointerEvent) => void;
  /**
   * Stage swipe-up from a vertical wheel flick (desktop swipe-up equivalent).
   * Safe during dance — only bumps the intensity preference briefly.
   */
  onStageSwipeUpFromWheel?: () => void;
  /**
   * Stage-gesture callbacks — stage-level recognizer events that do not concern
   * the character but may interact with the world or the app (confetti,
   * dance-intensity bumps, emotes).
   */
  onStageDoubleTap?: () => void;
  onStageTwoFingerTap?: () => void;
  onStageSwipeUp?: () => void;
  /** Pointer id currently dragging a chain, if any (suppresses orbit). */
  private dragPointerId: number | null = null;
  /** Camera auto-rotate is suppressed while she's dancing (front-facing lock). */
  private autoRotateAllowed = true;

  constructor(container: HTMLElement, quality?: QualitySettings) {
    this._container = container;
    this.quality = quality ?? getQualitySettings(detectQualityTier());
    this.visibility = createVisibilityPause();
    this.drs = new DynamicResolutionScaler({
      ...DEFAULT_DRS_CONFIG,
      base: this.quality.renderScale,
    });
    this.adaptive = new AdaptiveQualityGovernor(DEFAULT_ADAPTIVE_CONFIG, this.quality.tier);
    this.lastFrameTime = performance.now();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    this.camera.position.set(0, 1.35, 2.6);
    this.camera.lookAt(0, 1.3, 0);

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: this.quality.tier !== "low",
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setClearColor(0x000000, 0);

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.applyToneMappingAndShadows(this.quality);
    container.appendChild(this.renderer.domElement);
    Object.assign(this.renderer.domElement.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
    });

    this.interactionDom = document.createElement("div");
    Object.assign(this.interactionDom.style, {
      position: "absolute",
      inset: "0",
      zIndex: "1",
      cursor: "grab",
      touchAction: "none",
    });
    container.appendChild(this.interactionDom);

    this._controls = new OrbitControls(this.camera, this.interactionDom);
    this._controls.target.copy(this.chestTarget);
    this._controls.update();
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.rotateSpeed = 0.5;
    this._controls.minPolarAngle = this.MIN_POLAR;
    this._controls.maxPolarAngle = this.MAX_POLAR;
    this._controls.minDistance = this.MIN_DIST;
    this._controls.maxDistance = this.MAX_DIST;
    this._controls.autoRotate = false;
    this._controls.autoRotateSpeed = 0.4;
    this._controls.enablePan = false;

    this._controls.addEventListener("start", () => {
      this.isDragging = true;
      this._controls.autoRotate = false;
      this.autoRotateTimer = 0;
      this.autoRotateDelay = this.randomDelay();
      this.interactionDom.style.cursor = "grabbing";
      this.onInteractionStart?.();
    });

    this._controls.addEventListener("end", () => {
      this.isDragging = false;
      this.interactionDom.style.cursor = "grab";
    });

    this.interactionDom.addEventListener("pointermove", (e) => {
      const rect = this.interactionDom.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      if (this.dragPointerId !== null) {
        this.onDragMove?.(nx, ny);
        return;
      }
      if (!this.onPointerMove) return;
      this.onPointerMove(nx, ny);
    });

    this.interactionDom.addEventListener("contextmenu", (e) => e.preventDefault());

    // Recover from GPU context loss (driver reset, too many tabs) instead of
    // leaving a black canvas until the page is reloaded.
    this.onContextLost = (e: Event) => {
      e.preventDefault();
      this.contextLost = true;
    };
    this.onContextRestored = () => {
      this.contextLost = false;
      this.clock.getDelta(); // swallow the multi-second delta spike
      // A driver reset can hand us one catastrophically slow frame. Left in the
      // rolling window it would read as "the machine is struggling" and drop a
      // tier for a stall that has already ended.
      this.fpsSamples = [];
      this.lastFrameTime = performance.now();
      this.setQuality(this.quality); // re-apply tone mapping/shadows/size
      this.resize();
    };
    this.renderer.domElement.addEventListener("webglcontextlost", this.onContextLost);
    this.renderer.domElement.addEventListener("webglcontextrestored", this.onContextRestored);

    const handlePointerDown = (clientX: number, clientY: number, touch: boolean) => {
      if (!this.clickableRoot) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hits = this.raycaster.intersectObjects(this.clickableRoot.children, true);
      if (hits.length > 0) {
        this.onInteractionStart?.();
        // NOTE: no haptics here. A poke must vibrate exactly once, and the
        // single haptic path is controller-side ("WaifuCharacterController"
        // → "Haptics.poke"), after the dance gate — see IMPROVEMENTS.md §1.6.
        const hit = hits[0];
        const normal = hit.face
          ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
          : new THREE.Vector3(0, 1, 0);
        this.onPokeHit?.(hit.point.clone(), touch, hit.object, normal);
      }
    };

    this.interactionDom.addEventListener("pointerdown", (e) => {
      handlePointerDown(e.clientX, e.clientY, e.pointerType === "touch");
      this.onStagePointerDown?.(e);
    });

    this.interactionDom.addEventListener("pointermove", (e) => {
      this.onStagePointerMove?.(e);
    });

    this.interactionDom.addEventListener("pointerup", (e) => {
      this.onStagePointerUp?.(e);
    });

    // ── Stage-pointer cancel bridge (for the document-level recognizer). ──
    // Only installed when a consumer wires onStagePointerCancel; no-op otherwise.
    this.interactionDom.addEventListener("pointercancel", (e) => {
      this.onStagePointerCancel?.(e);
    });

    // ── Stage swipe-up from scroll-wheel (safe during dance) ──
    // The document-level pointer recognizer only sees touch/mouse button=0.
    // A vertical wheel flick is the desktop equivalent of a stage swipe-up,
    // so we bridge it through the same stage-gesture callback.
    this.interactionDom.addEventListener(
      "wheel",
      (e) => {
        if (!this.onStageSwipeUpFromWheel) return;
        if (e.deltaY <= 0) return; // only up scrolls
        e.preventDefault();
        this.onStageSwipeUpFromWheel();
      },
      { passive: false },
    );

    // ── Character-drag interception (pre-orbit) ──
    // A press over a grabbable secondary chain (hair/skirt/tail/accessory)
    // becomes a character drag, not a camera orbit: this capture-phase
    // pointerdown runs before OrbitControls' bubble-phase listener, so
    // disabling the controls here makes it ignore the gesture entirely.
    // Without a grab the controls are never touched — orbit is unaffected.
    this.interactionDom.addEventListener(
      "pointerdown",
      (e) => {
        if (this.dragPointerId !== null) return;
        if (!this.onDragCheck || !this.clickableRoot) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(this.clickableRoot.children, true);
        if (hits.length === 0) return;
        const hit = hits[0];
        const normal = hit.face
          ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
          : new THREE.Vector3(0, 1, 0);
        const category = this.onDragCheck(hit.object, hit.point, normal);
        if (!category) return; // not a grab — orbit proceeds untouched
        this.dragPointerId = e.pointerId;
        this._controls.enabled = false; // orbit must ignore this gesture
        try {
          this.interactionDom.setPointerCapture(e.pointerId);
        } catch {
          // Capture is a convenience — events still arrive over the element.
        }
        this.interactionDom.style.cursor = "grabbing";
        this.onDragGrab?.(hit.point.clone(), category);
      },
      true,
    );

    const endDrag = (e: PointerEvent) => {
      if (this.dragPointerId !== e.pointerId) return;
      this.dragPointerId = null;
      this._controls.enabled = true;
      this.interactionDom.style.cursor = "grab";
      this.onDragDrop?.();
    };
    this.interactionDom.addEventListener("pointerup", endDrag, true);
    this.interactionDom.addEventListener("pointercancel", endDrag, true);
    // Pointer leave ends the drag when capture is unavailable (e.g. the
    // setPointerCapture call threw); with capture active, boundary events are
    // retargeted to the capture element, so this only fires after release —
    // where it is an idempotent no-op.
    this.interactionDom.addEventListener("pointerleave", endDrag, true);

    const ambient = new THREE.AmbientLight(0x404060, 0.15);
    this.scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 0.7);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(1.5, 3, 2);
    if (this.quality.tier !== "low") {
      key.castShadow = true;
      key.shadow.mapSize.width = this.quality.tier === "high" ? 1024 : 512;
      key.shadow.mapSize.height = this.quality.tier === "high" ? 1024 : 512;
      key.shadow.bias = -0.0001;
      key.shadow.normalBias = 0.02;
      key.shadow.camera.near = 0.1;
      key.shadow.camera.far = 10;
      key.shadow.camera.left = -2;
      key.shadow.camera.right = 2;
      key.shadow.camera.top = 2;
      key.shadow.camera.bottom = -2;
      key.shadow.camera.updateProjectionMatrix();
    }
    this.keyLight = key;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xffaadd, 1.2);
    rim.position.set(-1.5, 1.8, -1.5);
    this.scene.add(rim);

    const fill = new THREE.DirectionalLight(0x88ccff, 0.3);
    fill.position.set(-1, 0.5, 1.5);
    this.scene.add(fill);

    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.loop();
  }

  setCameraTarget(x: number, y: number, z: number) {
    this.chestTarget.set(x, y, z);
    this.controls.target.copy(this.chestTarget);
    this.controls.update();
  }

  setClickableObjects(root: THREE.Object3D | null) {
    this.clickableRoot = root;
  }

  /**
   * Enable/disable idle camera auto-rotate. Disabled while she's dancing so a
   * long hands-free session never silently orbits the camera behind her.
   */
  setAutoRotateEnabled(allowed: boolean) {
    this.autoRotateAllowed = allowed;
    if (!allowed) {
      this.autoRotateTimer = 0;
      this.controls.autoRotate = false;
    }
  }

  private randomDelay(): number {
    return this.AUTO_ROTATE_MIN + Math.random() * (this.AUTO_ROTATE_MAX - this.AUTO_ROTATE_MIN);
  }

  setQuality(q: QualitySettings) {
    if (q.tier !== this.quality.tier) {
      // Any tier change starts the cooldown, whoever asked for it. That covers the
      // user picking a tier in Settings as well as the adaptive path, so the
      // governor can never immediately undo a deliberate choice.
      this.adaptive.notifyTierChanged(q.tier, performance.now());
    }
    this.quality = q;
    this.renderer.setPixelRatio(q.pixelRatio);
    // A tier change re-seats the DRS ceiling; the scaler never changes tiers.
    this.drs.setBase(q.renderScale);
    // Force the resize: setQuality is rare (settings change, adaptive tier
    // change, context restore) and pixelRatio alters the backing store even
    // when the logical size is unchanged.
    this.applyRenderScale(true);

    this.applyToneMappingAndShadows(q);
  }

  /** Tone mapping + shadow policy for a quality tier (initial setup and changes). */
  private applyToneMappingAndShadows(q: QualitySettings): void {
    if (q.tier === "high") {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.2;
    } else if (q.tier === "medium") {
      this.renderer.toneMapping = THREE.ReinhardToneMapping;
      this.renderer.toneMappingExposure = 1.15;
    } else {
      this.renderer.toneMapping = THREE.NoToneMapping;
    }

    if (q.tier !== "low") {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      if (this.keyLight) {
        this.keyLight.castShadow = true;
        this.keyLight.shadow.mapSize.width = q.tier === "high" ? 1024 : 512;
        this.keyLight.shadow.mapSize.height = q.tier === "high" ? 1024 : 512;
        this.keyLight.shadow.camera.updateProjectionMatrix();
      }
    } else {
      this.renderer.shadowMap.enabled = false;
      if (this.keyLight) {
        this.keyLight.castShadow = false;
      }
    }
  }

  getQuality(): QualitySettings {
    return this.quality;
  }

  /**
   * User-selected frame ceiling (30 / 60 / uncapped).
   *
   * This is a choice, not a fallback: unlike the adaptive frame-skipping that was
   * removed from the loop earlier, a frame the user asked us to drop is a
   * deliberate one. Max Performance overrides it via `resolveFpsCapMs`.
   */
  setFpsCap(cap: FpsCap): void {
    this.fpsCap = cap;
    this.resetCapGrid();
  }

  /** Max Performance mode — takes priority over the FPS cap when enabled. */
  setMaxPerfMode(enabled: boolean): void {
    this.maxPerfMode = enabled;
    this.resetCapGrid();
  }

  /** Start a fresh cadence so a newly applied cap takes effect on the next tick. */
  private resetCapGrid(): void {
    this.capStarted = false;
    this.capFrameIndex = 0;
  }

  /** Effective minimum frame interval in ms; 0 means uncapped. */
  getFpsCapMs(): number {
    return resolveFpsCapMs(this.fpsCap, this.maxPerfMode);
  }

  addUpdate(fn: (dt: number) => void) {
    this.updaters.push(fn);
    return () => {
      this.updaters = this.updaters.filter((f) => f !== fn);
    };
  }

  private resize() {
    const now = performance.now();
    if (now - this.lastResizeTime < 50) return;
    this.lastResizeTime = now;

    this.applyRenderScale();

    const aspect = this.container.clientWidth / this.container.clientHeight || 1;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Apply the current DRS scale to the drawing buffer.
   *
   * `updateStyle = false` keeps the canvas CSS box at 100% (set in the
   * constructor), so only the backing store changes — exactly the mechanism the
   * per-tier renderScale already used. No DOM box is touched, and because the
   * container's own size never changes the ResizeObserver cannot feed back into
   * this. Integer quantisation plus the equality check mean repeated samples at
   * one scale cost nothing: no per-frame WebGL work and no allocation.
   */
  private applyRenderScale(force = false): void {
    const w = Math.floor(this.container.clientWidth * this.drs.scale);
    const h = Math.floor(this.container.clientHeight * this.drs.scale);
    if (!w || !h) return;
    if (!force && w === this.appliedW && h === this.appliedH) return;
    this.appliedW = w;
    this.appliedH = h;
    this.renderer.setSize(w, h, false);
  }

  /** Live render scale — the tier base scaled down by the DRS controller. */
  getRenderScale(): number {
    return this.drs.scale;
  }

  /** Smoothed frame time in ms driving the DRS controller. */
  getFrameEmaMs(): number {
    return this.drs.emaMs;
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);

    if (this.visibility.paused) return;

    if (this.contextLost) return; // RAF already re-scheduled above

    const now = performance.now();

    // Frame ceiling. Skipping the whole body rather than only `render` keeps the
    // simulation honest: `clock.getDelta()` spans the skipped interval, so the
    // character advances at the right speed, just fewer times per second.
    const capMs = resolveFpsCapMs(this.fpsCap, this.maxPerfMode);
    if (capMs > 0) {
      if (!this.capStarted) {
        this.capStarted = true;
        this.capAnchorAt = now;
      } else if (now < this.capAnchorAt + this.capFrameIndex * capMs) {
        return; // not due yet
      }
      this.capFrameIndex = Math.floor((now - this.capAnchorAt) / capMs) + 1;
    }

    let dt = this.clock.getDelta();
    if (dt > 0.033) dt = 0.033;

    const realDt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    if (realDt > 0 && realDt < 0.25) {
      this.fpsSamples.push(1 / realDt);
      if (this.fpsSamples.length > 60) this.fpsSamples.shift();
      // Dynamic resolution: feed the scaler the real frame time and resize only
      // when it actually moved. Samples longer than 250 ms are tab switches and
      // long stalls — one of them must never punish the scale for a minute.
      // A capped interval is a choice, not a performance signal: feeding a
      // pinned 33 ms to the scaler would drive the render scale to its floor
      // while the machine is in fact sitting comfortably inside budget. Hold the
      // scale where it is and let the scaler resume on the first uncapped frame.
      if (capMs === 0 && this.drs.sample(realDt * 1000, now) !== null) {
        this.applyRenderScale();
      }
    }

    this.lastFpsEval += dt;
    if (this.lastFpsEval >= this.adaptive.evalIntervalSec) {
      this.lastFpsEval = 0;
      if (this.fpsSamples.length > 0) {
        const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
        this.evaluateAdaptiveQuality(avg);
      }
    }

    if (this.targetFocusTimer > 0) {
      this.targetFocusTimer -= dt;
      if (this.targetFocusTimer <= 0) {
        this.targetFocusTimer = -this.TARGET_RETURN_DURATION;
      }
    } else if (this.targetFocusTimer < 0) {
      this.targetFocusTimer += dt;
      this._controls.target.lerp(this.chestTarget, Math.min(1, dt * 3));
      if (this.targetFocusTimer >= 0) {
        this._controls.target.copy(this.chestTarget);
        this.targetFocusTimer = 0;
      }
    }

    if (this.autoRotateAllowed && !this._controls.autoRotate) {
      this.autoRotateTimer += dt;
      if (this.autoRotateTimer >= this.autoRotateDelay) {
        this._controls.autoRotate = true;
        this._controls.target.copy(this.chestTarget);
      }
    }

    this._controls.update();

    this.frameCount++;

    // Always run updaters (mixer.update, animation tick, etc.)
    for (const fn of this.updaters) fn(dt);

    this.renderer.render(this.scene, this.camera);
  };

  private evaluateAdaptiveQuality(avgFps: number) {
    const previous = this.quality.tier;
    const next = this.adaptive.evaluate(avgFps, performance.now());
    if (!next) return;
    const direction =
      TIER_ORDER.indexOf(next) < TIER_ORDER.indexOf(previous) ? "degrading" : "upgrading";
    console.log(`[Renderer] FPS ${avgFps.toFixed(1)} — ${direction} quality to ${next}`);
    this.setQuality(getQualitySettings(next));
  }

  getFps(): number {
    if (this.fpsSamples.length === 0) return 60;
    return this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
  }

  dispose() {
    this.visibility.dispose();
    cancelAnimationFrame(this.rafId);
    this.resizeObs?.disconnect();
    // Unmount cancellation: release any in-flight character grab.
    if (this.dragPointerId !== null) {
      this.dragPointerId = null;
      this.onDragDrop?.();
    }
    this._controls.dispose();
    if (this.onContextLost)
      this.renderer.domElement.removeEventListener("webglcontextlost", this.onContextLost);
    if (this.onContextRestored)
      this.renderer.domElement.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.interactionDom.remove();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
