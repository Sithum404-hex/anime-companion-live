import * as THREE from "three";
import { Renderer } from "../renderer";
import { EventBus } from "./EventBus";
import type { QualitySettings, FpsCap } from "../performance";
import { getQualitySettings, detectQualityTier } from "../performance";
import { DanceCameraController } from "../camera/DanceCameraController";

/**
 * RenderingController owns all Three.js objects and the render loop.
 * No other module touches the DOM, the scene graph, or the renderer directly.
 */
export class RenderingController {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private renderer: Renderer;
  private bus: EventBus;

  private unsubs: (() => void)[] = [];
  private danceCamera?: DanceCameraController;

  constructor(container: HTMLElement, bus: EventBus, quality?: QualitySettings) {
    this.bus = bus;
    this.renderer = new Renderer(container, quality);
    this.scene = this.renderer.scene;
    this.camera = this.renderer.camera;

    // Pipe user interaction through the event bus
    this.renderer.onInteractionStart = () => {
      this.bus.emit("input:interaction", undefined);
    };

    // Register update with renderer loop
    this.renderer.addUpdate((dt) => {
      this.bus.emit("render:tick", { dt });
    });
  }

  /**
   * Create or replace the dance camera controller. It reads from the existing
   * camera, OrbitControls, beat pulse, and hips anchor — it does not create a
   * new renderer, scene, or render loop.
   */
  createDanceCamera(
    beatPulse: () => import("../DanceDirector").BeatPulse,
    hipsNode: THREE.Object3D | null,
  ): void {
    if (this.danceCamera) {
      this.danceCamera.dispose();
    }
    this.danceCamera = new DanceCameraController(
      this.camera,
      this.renderer.controls,
      beatPulse,
      hipsNode,
    );
  }

  /** Update the dance camera each frame. Safe to call when there is no controller. */
  updateDanceCamera(dt: number, animState: string): void {
    this.danceCamera?.update(dt, animState);
  }

  /** Enable/disable the dance camera at runtime. */
  setDanceCameraEnabled(enabled: boolean): void {
    this.danceCamera?.setEnabled(enabled);
  }

  get danceCameraEnabled(): boolean {
    return this.danceCamera?.enabled ?? false;
  }

  /** Read-only snapshot of the dance camera's debug state ("no-controller" when absent). */
  get danceCameraDebugState(): string {
    return this.danceCamera?.debugState ?? "no-controller";
  }

  /** Whether the dance camera is currently mid-dance (false when absent). */
  get isDanceCameraDancing(): boolean {
    return this.danceCamera?.isDancing ?? false;
  }

  /** Add a Three.js object to the scene (e.g. the VRM model). */
  add(object: THREE.Object3D): void {
    this.scene.add(object);
  }

  /** The WebGL canvas — read-only access for DOM-overlay effects (heart FX). */
  get domElement(): HTMLCanvasElement {
    return this.renderer.renderer.domElement;
  }

  /** Set the orbit target position. */
  setCameraTarget(x: number, y: number, z: number): void {
    this.renderer.setCameraTarget(x, y, z);
  }

  /** Register clickable root for click-on-character raycasting. */
  setClickableObjects(root: THREE.Object3D | null): void {
    this.renderer.setClickableObjects(root);
  }

  /** Update quality settings on the renderer. */
  setQuality(q: QualitySettings): void {
    this.renderer.setQuality(q);
  }

  getQuality(): QualitySettings {
    return this.renderer.getQuality();
  }

  /** User-selected frame ceiling; Max Performance overrides it when enabled. */
  setFpsCap(cap: FpsCap): void {
    this.renderer.setFpsCap(cap);
  }

  /** Max Performance mode — takes priority over the FPS cap selector. */
  setMaxPerfMode(enabled: boolean): void {
    this.renderer.setMaxPerfMode(enabled);
  }

  get isDragging(): boolean {
    return this.renderer.isDragging;
  }

  /** The renderer's container element — used by the stage-gesture recognizer. */
  get container(): HTMLElement {
    return this.renderer.container;
  }

  set onPointerMove(fn: ((nx: number, ny: number) => void) | undefined) {
    this.renderer.onPointerMove = fn;
  }

  /**
   * Directional poke callback — fires only when a pointer actually hits her
   * mesh. Carries the hit point, the struck object and the surface normal.
   */
  set onPokeHit(
    fn:
      | ((
          point: THREE.Vector3,
          touch: boolean,
          hitObject: THREE.Object3D,
          normal: THREE.Vector3,
        ) => void)
      | undefined,
  ) {
    this.renderer.onPokeHit = fn;
  }

  /**
   * Character-drag hooks — the renderer only asks "is this press a grab?";
   * the decision (dance gate, chain family) lives with the controller.
   * A non-null category captures the gesture before OrbitControls sees it.
   */
  set onDragCheck(
    fn:
      | ((hitObject: THREE.Object3D, point: THREE.Vector3, normal: THREE.Vector3) => string | null)
      | undefined,
  ) {
    this.renderer.onDragCheck = fn;
  }

  set onDragGrab(fn: ((point: THREE.Vector3, category: string) => void) | undefined) {
    this.renderer.onDragGrab = fn;
  }

  set onDragMove(fn: ((nx: number, ny: number) => void) | undefined) {
    this.renderer.onDragMove = fn;
  }

  set onDragDrop(fn: (() => void) | undefined) {
    this.renderer.onDragDrop = fn;
  }

  /**
   * Stage-gesture pointer bridge — forwarded to the document-level
   * recognizer. These are the raw pointer events the recognizer needs; the
   * renderer forwards them without touching OrbitControls.
   */
  set onStagePointerDown(fn: ((e: PointerEvent) => void) | undefined) {
    this.renderer.onStagePointerDown = fn;
  }

  set onStagePointerMove(fn: ((e: PointerEvent) => void) | undefined) {
    this.renderer.onStagePointerMove = fn;
  }

  set onStagePointerUp(fn: ((e: PointerEvent) => void) | undefined) {
    this.renderer.onStagePointerUp = fn;
  }

  set onStagePointerCancel(fn: ((e: PointerEvent) => void) | undefined) {
    this.renderer.onStagePointerCancel = fn;
  }

  /**
   * Stage-gesture callbacks — stage-level recognizer events that do not
   * concern the character but may interact with the world or the app (confetti,
   * dance-intensity bumps, emotes). These are forwarded from the renderer and
   * dance-gated at the controller/WaifuStage layer.
   */
  set onStageDoubleTap(fn: (() => void) | undefined) {
    this.renderer.onStageDoubleTap = fn;
  }

  set onStageTwoFingerTap(fn: (() => void) | undefined) {
    this.renderer.onStageTwoFingerTap = fn;
  }

  set onStageSwipeUp(fn: (() => void) | undefined) {
    this.renderer.onStageSwipeUp = fn;
  }

  /** Stage swipe-up from a vertical wheel flick (desktop swipe-up equivalent). */
  set onStageSwipeUpFromWheel(fn: (() => void) | undefined) {
    this.renderer.onStageSwipeUpFromWheel = fn;
  }

  /** Camera auto-rotate gate — off while she's dancing. */
  setAutoRotateEnabled(allowed: boolean): void {
    this.renderer.setAutoRotateEnabled(allowed);
  }

  /** Toggle the 3D World Mode environment (floor + backdrop + shadows). */
  /** Register an arbitrary update callback into the render loop. */
  addUpdate(fn: (dt: number) => void): () => void {
    return this.renderer.addUpdate(fn);
  }

  /** Current animation state for dance camera gating. */
  get currentAnimState(): string {
    return this.renderer.currentAnimState ?? "idle";
  }

  /** Apply a runtime config to the dance camera, if one exists. */
  applyDanceCameraConfig(
    config: import("../camera/DanceCameraController").DanceCameraConfig,
  ): void {
    if (!this.danceCamera) return;
    if (config.followStrength !== undefined)
      this.danceCamera.followStrength = config.followStrength;
    if (config.swayStrength !== undefined) this.danceCamera.swayStrength = config.swayStrength;
    if (config.rotationStrength !== undefined)
      this.danceCamera.rotationStrength = config.rotationStrength;
    if (config.zoomStrength !== undefined) this.danceCamera.zoomStrength = config.zoomStrength;
    if (config.shakeStrength !== undefined) this.danceCamera.shakeStrength = config.shakeStrength;
    if (config.returnSpeed !== undefined) this.danceCamera.returnSpeed = config.returnSpeed;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.danceCamera?.dispose();
    this.danceCamera = undefined;
    this.renderer.dispose();
  }
}
