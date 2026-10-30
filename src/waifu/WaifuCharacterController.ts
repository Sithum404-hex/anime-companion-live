import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { VRMAAnimationName } from "./vrmAnimationLoader";
import type { WaifuState, Settings } from "./types";
import { EventBus } from "./controller/EventBus";
import { RenderingController } from "./controller/RenderingController";
import { AnimationController } from "./controller/AnimationController";
import { AIController } from "./controller/AIController";
import { InputController } from "./controller/InputController";
import { InteractionManager, type InteractionInputs } from "./controller/InteractionManager";
import type { BaseEmotion, ExpressionQueueItem } from "./controller/ExpressionController";
import type { QualitySettings, FpsCap } from "./performance";
import { ParticleBurst } from "./visualizer/ParticleBurst";
import { FloorRingPool } from "./visualizer/FloorRingPool";
import { TouchReactionController } from "./TouchReactionController";
import { Haptics } from "./haptics";
import { resolveTouchAnchors } from "./touchZones";
import { AudioPlayerManager } from "@/systems/audioPlayer";
import { getDanceAnimations } from "./vrmAnimationLoader";
import { DanceDirector, type DanceDebugInfo } from "./DanceDirector";
import {
  CharacterBehaviorEngine,
  type CharacterBehaviorDebugState,
} from "./CharacterBehaviorEngine";
import type { RawAiIntent } from "./types";
import { SecondaryPhysicsManager } from "./physics/SecondaryPhysicsManager";
import { SpringBoneDebugHelper } from "./SpringBoneDebugHelper";
import { BUST_SCALE } from "./physicsConfig";

/**
 * WaifuCharacterController — thin coordinator.
 *
 * Owns the EventBus and all sub-controllers.
 * Wires them together via the bus; delegates public API to the right controller.
 * NO direct Three.js, DOM, or Web Audio calls — all domain work goes through controllers.
 */
export class WaifuCharacterController {
  readonly events: EventBus;
  readonly rendering: RenderingController;
  readonly animation: AnimationController;
  readonly ai: AIController;
  readonly input: InputController;

  /** Secondary physics (hair, cloth, tail, accessories, idle micro-motion). */
  readonly physics: SecondaryPhysicsManager;

  /** Cursor → VRM lookAt tracking target. */
  private readonly lookAtTarget: THREE.Object3D;
  /** Music Dance Director — intelligent dance selection from audio analysis. */
  readonly danceDirector: DanceDirector;
  /** AI Animation Director — authoritative controller for AI body language. */
  readonly behaviorEngine: CharacterBehaviorEngine;
  /** Beat-reactive floor rings, driven by the director's beat clock. */
  readonly floorRings: FloorRingPool;
  /** Beat-reactive particle burst, driven by the same audio pipeline. */
  readonly particleBurst: ParticleBurst;
  /** Zone-aware touch reactions (head pat / face / hand) — heart FX hook lives here. */
  readonly touchReactions: TouchReactionController;
  /** Hips bone — floor-ring anchor is read from its world position each frame. */
  private hipsNode: THREE.Object3D | null = null;
  /** Scratch world position for the floor-ring anchor. */
  private readonly ringAnchor = new THREE.Vector3();
  /** Stage-level two-finger confetti burst (invoked by the stage gesture recognizer). */
  onTwoFingerConfettiBurst?: () => void;
  /** Debug snapshot of the current dance/camera state. */
  get danceCameraState(): string {
    return this.rendering.danceCameraDebugState;
  }
  /** Whether the dance camera is currently enabled on the renderer. */
  get danceCameraEnabled(): boolean {
    return this.rendering.danceCameraEnabled;
  }
  /** Whether this controller has a usable hips anchor for the dance camera. */
  get hasHipsAnchor(): boolean {
    return this.hipsNode != null;
  }
  /** Raw hips bone — exposed only for the stage's debug/introspection needs. */
  get hipsNodeRef(): THREE.Object3D | null {
    return this.hipsNode;
  }

  private lookAtNX = 0;
  private lookAtNY = 0;
  private lookAtActive = false;
  private lookAtTimestamp = 0;
  private readonly LOOKAT_IDLE_TIMEOUT = 2000;
  private readonly LOOKAT_H_RANGE = 1.2;
  private readonly LOOKAT_V_RANGE = 0.3;
  private readonly LOOKAT_Y = 1.4;
  private readonly LOOKAT_Z = 2.0;
  private readonly lookAtCenter = new THREE.Vector3(0, 1.4, 2.0);

  private debugHelper?: SpringBoneDebugHelper;
  private bustBones: THREE.Object3D[] = [];
  private vrm: VRM;
  private interaction: InteractionManager;
  private settings: Settings;
  private disposed = false;
  private audioPlayer: AudioPlayerManager | null = null;
  private reactionAccum = 0;
  private readonly REACTION_INTERVAL = 1 / 20;

  constructor(
    vrm: VRM,
    rendering: RenderingController,
    bus: EventBus,
    settings: Settings,
    quality: QualitySettings,
  ) {
    this.vrm = vrm;
    this.settings = settings;
    this.rendering = rendering;
    this.events = bus;
    this.ai = new AIController(this.events, quality);
    this.input = new InputController(this.events, quality);
    this.animation = new AnimationController(vrm, this.events, () => this.ai.getAudioFrame());
    this.danceDirector = new DanceDirector();
    this.animation.setDanceDirector(this.danceDirector);
    this.applyDanceSettings(settings);
    this.behaviorEngine = new CharacterBehaviorEngine({
      stateMachine: this.animation.stateMachine,
      events: this.events,
      isMusicPlaying: () =>
        (this.audioPlayer?.playing ?? false) &&
        this.settings.musicPlayerEnabled &&
        this.settings.danceSyncEnabled,
    });
    // When a locked AI dance finishes, the director resumes music dancing or
    // returns the character to her natural base state.
    this.animation.setAiDanceEndedHandler(() => this.behaviorEngine.onAiDanceEnded());
    // Beat-reactive floor rings, driven by the director's beat clock (the same
    // timing the dance is choreographed to). Purely additive to the scene: no
    // animation, physics or dance state is ever written from here.
    this.floorRings = new FloorRingPool({
      scene: rendering.scene,
      beat: this.danceDirector.beatPulse,
    });
    this.floorRings.setEnabled(settings.visualizersEnabled);
    // Beat-reactive particle burst, driven by the same audio pipeline.
    this.particleBurst = new ParticleBurst({
      scene: rendering.scene,
      beat: this.danceDirector.beatPulse,
    });
    this.particleBurst.setEnabled(settings.visualizersEnabled);
    this.physics = new SecondaryPhysicsManager(vrm);
    // Zone-aware touch reactions — expression overlays, additive lean/recoil,
    // localised physics shoves. Internally debounced and dance-gated; the
    // stage projects heart FX from onHeartBurst.
    const haptics = new Haptics();

    this.touchReactions = new TouchReactionController(
      {
        queueEmotion: (emotion, intensity, duration) =>
          this.animation.queueExpression({ emotion, intensity, duration }),
        forceEyesClosed: (durationSec) => this.physics.idle.forceEyesClosed(durationSec),
        playGesture: () => this.animation.stateMachine.requestAiEmoteState("gesture"),
        impulseAt: (point, strengthScale) => this.physics.poke(point, strengthScale),
        isDancing: () => this.animation.stateMachine.currentAnimState === "dance",
        isSpeaking: () => this.ai.isSpeaking(),
        haptics: {
          poke: () => haptics.poke(),
        },
      },
      () => this.rendering.camera,
      resolveTouchAnchors(vrm),
    );
    // Raycast hits on her mesh → zone classification (head pat, face, hand…).
    this.rendering.onPokeHit = (point, _touch, hitObject, normal) => {
      this.touchReactions.onTouch(hitObject, point, normal);
    };
    // Raw hips bone — its world position anchors the beat floor rings and the
    // dance camera anchor.
    this.hipsNode = vrm.humanoid?.getRawBoneNode("hips") ?? null;

    // Dance camera — created once the hips anchor is known so it can track real
    // character movement. It reads from the existing camera, OrbitControls,
    // beat pulse, and hips anchor; it never creates a new renderer, scene, or
    // render loop.
    if (this.hipsNode) {
      rendering.createDanceCamera(() => this.danceDirector.beatPulse, this.hipsNode);
    }

    // Two-finger confetti — additive sparkle burst from her anchor point.
    this.onTwoFingerConfettiBurst = () => {
      this.particleBurst.spawnParticles(this.particleBurst.spawnCount(1), performance.now());
    };
    this.debugHelper = new SpringBoneDebugHelper(vrm, rendering.scene);
    this.discoverBustBones(vrm);
    this.animation.setMicLevelSource(() => this.input.micLevel());
    // Eagerly initialize dance pool so startDance() works immediately
    const dances = getDanceAnimations();
    if (dances.length > 0) {
      this.animation.stateMachine.setDancePool(dances.map((d) => d.url));
    }
    this.interaction = new InteractionManager(this.buildInteractionInputs(), settings);

    // Wire state changes → animation + expression
    this.interaction.onStateChange((s) => {
      if (this.disposed) return;

      if (s === "DANCING") {
        this.behaviorEngine.setUserListening(false);
      } else if (s === "IDLE") {
        // Interaction-driven idle must not kill an active dance (screen-share
        // dances run without music). The state machine ignores it while dancing;
        // stopDance() is the explicit stop path.
        this.behaviorEngine.setUserListening(false);
      } else {
        // Transient states (HAPPY/SCARED/CURIOUS/…) and TALKING feed the
        // expression layer while dancing — the ASM dance lockdown decides
        // whether the animation state changes.
        this.behaviorEngine.setUserListening(s === "LISTENING");
      }

      if (s === "SCARED") {
        this.animation.queueExpression({ emotion: "surprised", intensity: 0.8, duration: 1.5 });
      } else if (s === "CURIOUS") {
        this.animation.queueExpression({ emotion: "nervous", intensity: 0.4, duration: 2 });
      } else if (s === "HAPPY") {
        this.animation.queueExpression({ emotion: "happy", intensity: 0.6, duration: 2.5 });
      } else if (s === "SAD") {
        this.animation.setBaseEmotion("sad");
      }
    });

    // Wire animation events → reset idle timer
    const resetIdle = () => this.interaction.resetIdleTimer();
    this.events.on("anim:timeout", resetIdle);
    this.events.on("anim:complete", resetIdle);
    this.events.on("anim:inactivity", resetIdle);

    // Wire touch interaction (Raycaster hits from renderer)
    this.events.on("input:interaction", () => {
      if (this.disposed || this.settings.screenVisionEnabled) return;
      // Clicks are frozen while she's dancing — they must not interrupt the dance
      if (this.animation.stateMachine.currentAnimState === "dance") return;
      // Trigger a blush/happy reaction when touched
      this.interaction.setState("HAPPY", 3000);
      this.interaction.setEmotion("happy");
    });

    // Register main update loop with renderer
    this.rendering.addUpdate((dt) => this.update(dt));

    // ── VRM lookAt target for cursor tracking ──
    this.lookAtTarget = new THREE.Object3D();
    this.lookAtTarget.position.copy(this.lookAtCenter);
    if (this.vrm.lookAt) {
      this.vrm.lookAt.target = this.lookAtTarget;
    }
    rendering.scene.add(this.lookAtTarget);

    this.rendering.onPointerMove = (nx: number, ny: number) => {
      this.lookAtNX = nx;
      this.lookAtNY = ny;
      this.lookAtActive = true;
      this.lookAtTimestamp = performance.now();
    };
  }

  // ── Public API ────────────────────────────────────────────

  async speak(text: string, emotion?: string): Promise<void> {
    if (!text) return;
    this.behaviorEngine.onTtsStarting();
    try {
      await this.ai.speak(text, this.settings.volume, emotion);
    } catch (error) {
      this.behaviorEngine.onTtsEnded(true);
      throw error;
    }
  }

  setState(state: WaifuState, holdMs?: number): void {
    this.interaction.setState(state, holdMs);
    this.particleBurst.setEnabled(this.settings.visualizersEnabled);
  }

  /** Reflect push-to-talk / voice-listening state on the character. */
  setListening(active: boolean): void {
    if (this.disposed) return;
    this.interaction.resetIdleTimer();
    this.interaction.setState(active ? "LISTENING" : "IDLE");
    this.behaviorEngine.setUserListening(active);
  }

  setBaseEmotion(e: BaseEmotion): void {
    this.animation.setBaseEmotion(e);
  }

  queueExpression(item: ExpressionQueueItem): void {
    this.animation.queueExpression(item);
  }

  clearExpressionQueue(): void {
    this.animation.clearExpressionQueue();
  }

  onUserMessage(text = ""): void {
    this.animation.onUserMessage();
    this.behaviorEngine.onUserMessage(text);
  }

  onGreeting(): void {
    this.animation.onGreeting();
  }

  onSilence(): void {
    this.animation.onSilence();
  }

  onAIResponse(emotion: string, intensity: number, response = ""): void {
    this.animation.onAIResponse(emotion, intensity);
    this.behaviorEngine.onAiResponse(emotion, intensity, response);
  }

  /**
   * AI delivered a structured animation decision — hand it to the director
   * (it is validated against the registry before anything plays).
   */
  onAiAnimationIntent(intent: RawAiIntent | null): void {
    this.behaviorEngine.onAiIntent(intent, this.settings.voiceEnabled);
  }

  /** Debug snapshot for the AI Animation Director panel. */
  getAiAnimationDebug(): CharacterBehaviorDebugState {
    return this.behaviorEngine.getDebugInfo();
  }

  onAiGenerationFailed(): void {
    this.behaviorEngine.onGenerationFailed();
  }

  async playAnimation(name: VRMAAnimationName): Promise<void> {
    await this.animation.playAnimation(name);
  }

  async playAnimationFromUrl(url: string): Promise<void> {
    await this.animation.playAnimationFromUrl(url);
  }

  stopAnimation(): void {
    this.animation.stopAnimation();
  }

  triggerEmote(emoteName: string): Promise<void> {
    return this.animation.triggerEmote(emoteName);
  }

  setLook(x: number, y: number): void {
    this.animation.setLook(x, y);
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.interaction.updateSettings(settings);
    this.applyDanceSettings(settings);
  }

  private applyDanceSettings(settings: Settings): void {
    this.danceDirector.setDanceSyncEnabled(settings.danceSyncEnabled);
    this.danceDirector.setIntensityPreference(settings.danceIntensity);
  }

  /** Reflect the 3D World Mode toggle on the renderer. */
  /** Enable/disable the dance camera at runtime. */
  setDanceCameraEnabled(enabled: boolean): void {
    this.rendering.setDanceCameraEnabled(enabled);
  }

  /** Apply runtime tuning to the dance camera, if it exists. */
  applyDanceCameraConfig(config: import("./camera/DanceCameraController").DanceCameraConfig): void {
    this.rendering.applyDanceCameraConfig(config);
  }

  /** Reflect the dance camera setting on the renderer. */
  updateDanceCameraEnabled(enabled: boolean): void {
    this.rendering.setDanceCameraEnabled(enabled);
  }

  /** Immediately stop TTS speech (Live PTT interruption / UI mute). */
  cancelSpeech(): void {
    this.ai.cancelSpeech();
    // voice.cancel() does not run the normal onEnd wiring — mirror it here so
    // ducking, music-dance resume and the behavior engine stay consistent.
    this.audioPlayer?.unduck();
    this.resumeMusicState();
    this.behaviorEngine.onTtsEnded(true);
  }

  /** Frame-rate ceiling — orthogonal to the quality tier. */
  setFpsCap(cap: FpsCap): void {
    this.rendering.setFpsCap(cap);
  }

  setQuality(quality: QualitySettings): void {
    this.rendering.setQuality(quality);
    this.floorRings.setQuality(quality.tier);
    this.particleBurst.setQuality(quality.tier);
  }

  /** Pre-warm the TTS AudioContext during a user gesture. */
  prewarmAudio(): void {
    this.ai.voice.warmup();
  }

  startMic(): Promise<void> {
    return this.input.startMic();
  }

  stopMic(): void {
    this.input.stopMic();
  }

  startMotion(): Promise<void> {
    return this.input.startMotion();
  }

  stopMotion(): void {
    this.input.stopMotion();
  }

  startDance(): void {
    this.behaviorEngine.setExternalDance(true, "External dance requested");
  }

  stopDance(): void {
    this.behaviorEngine.stopDance();
  }

  resumeMusicState(): void {
    const ap = this.audioPlayer;
    if (ap?.playing && ap.hasTracks) {
      this.behaviorEngine.setExternalDance(true, "Music resumed after TTS");
    }
  }

  resetInactivityTimers(): void {
    this.interaction.resetIdleTimer();
    this.animation.requestState(this.animation.currentAnimState);
  }

  setAudioPlayer(ap: AudioPlayerManager | null): void {
    this.audioPlayer = ap;

    // Wire TTS ducking — duck local-player audio so she can be heard,
    // then resume dancing once speech finishes. Also drives the AI
    // Animation Director's TTS synchronization.
    this.ai.voice.onStart = () => {
      ap?.duck();
      this.behaviorEngine.onTtsStarted();
    };
    this.ai.voice.onEnd = () => {
      ap?.unduck();
      this.resumeMusicState();
      this.behaviorEngine.onTtsEnded();
    };

    // Wire audio sources to animation controller for beat-reactive dancing
    if (ap) {
      this.animation.setAudioIntensitySource(() => ap.intensity);
      this.animation.setAudioBassSource(() => ap.bass);
      this.animation.setAudioBeatSource(() => ap.beat);
      this.animation.setAudioFeaturesSource(() => ({
        features: ap.getAudioFeatures(),
        songVersion: ap.getSongVersion(),
        songDuration: ap.duration,
      }));
      if (ap.playing && ap.hasTracks) {
        this.behaviorEngine.setExternalDance(true, "Music player attached while playing");
      }
    } else {
      this.animation.setAudioIntensitySource(() => 0);
      this.animation.setAudioBassSource(() => 0);
      this.animation.setAudioBeatSource(() => false);
      this.animation.setAudioFeaturesSource(() => null);
      this.behaviorEngine.setExternalDance(false, "Music player detached");
    }
  }

  /** Debug info for the "Show Music Analysis" panel. */
  getDanceDebugInfo(): DanceDebugInfo {
    return this.danceDirector.getDebugInfo();
  }

  // ── Internal ──────────────────────────────────────────────

  private discoverBustBones(vrm: VRM): void {
    const humanoid = vrm.humanoid;
    if (!humanoid) return;

    const chest = humanoid.getNormalizedBoneNode("chest");
    const upperChest = humanoid.getNormalizedBoneNode("upperChest");

    if (chest) this.bustBones.push(chest);
    if (upperChest && !this.bustBones.includes(upperChest)) this.bustBones.push(upperChest);

    // Scan skeleton for VRoid bust-specific bones
    vrm.scene.traverse((obj) => {
      const name = obj.name.toLowerCase();
      if (name.includes("bust") || name.includes("oppai")) {
        if (!this.bustBones.includes(obj)) {
          this.bustBones.push(obj);
        }
      }
    });

    if (this.bustBones.length > 0) {
      this.applyBustScale();
    }
  }

  private applyBustScale(): void {
    for (const bone of this.bustBones) {
      bone.scale.set(BUST_SCALE, BUST_SCALE, BUST_SCALE);
    }
  }

  private buildInteractionInputs(): InteractionInputs {
    return {
      isSpeaking: () => this.ai.isSpeaking(),
      micActive: () => this.input.micActive,
      micLevel: () => this.input.micLevel(),
      motionActive: () => this.input.motionActive,
      readMotion: () => this.input.readMotion(),
      isMusicPlaying: () => this.audioPlayer?.playing ?? false,
    };
  }

  private update(dt: number): void {
    if (this.disposed) return;

    const waifuState = this.interaction.state;

    // 1. Animation — runs ASM mixer, tick, expression, idle, lip-sync, behavior
    this.animation.update(dt, waifuState);

    // 1b. AI Animation Director — base-state return + cooldowns
    this.behaviorEngine.update(dt);

    // 2. Secondary physics — hair, cloth, tail, accessories, idle micro-motion
    //    MUST run after animation bones are set but before vrm.update() applies them.
    this.physics.update(
      dt,
      this.animation.currentAnimState,
      waifuState === "IDLE",
      this.ai.isSpeaking(),
    );

    // 2c. Beat floor rings — one pooled pulse per beat, born under her and
    //     expanding outward. Reads the dance director's beat clock (the same
    //     timing the choreography is cut to) and arms the next pooled ring; it
    //     owns no animation state, so it stays safe mid-dance by construction.
    if (this.hipsNode) {
      this.hipsNode.getWorldPosition(this.ringAnchor);
      this.floorRings.setAnchor(this.ringAnchor.x, this.ringAnchor.z);
      this.particleBurst.setAnchor(this.ringAnchor.x, this.ringAnchor.y, this.ringAnchor.z);
    }
    this.floorRings.update(dt, performance.now());
    this.particleBurst.update(dt, performance.now());

    // 2c-bis. Camera auto-rotate gate — a hands-free session must never orbit
    //        the camera behind her mid-choreography.
    this.rendering.setAutoRotateEnabled(this.animation.stateMachine.currentAnimState !== "dance");

    // 2d. Touch reaction envelopes — additive head lean / torso recoil written
    //     on top of the animated pose (same contract as physics: before
    //     vrm.update() copies normalized bones to the raw skeleton).
    const touchPose = this.touchReactions.update(dt);
    if (touchPose.headZ !== 0) {
      const head = this.vrm.humanoid?.getNormalizedBoneNode("head");
      const neck = this.vrm.humanoid?.getNormalizedBoneNode("neck");
      if (head) head.rotation.z += touchPose.headZ * 0.5;
      if (neck) neck.rotation.z += touchPose.headZ * 0.5;
    }
    if (touchPose.torsoX !== 0) {
      const chest = this.vrm.humanoid?.getNormalizedBoneNode("chest");
      if (chest) chest.rotation.x += touchPose.torsoX;
    }

    // 3. Body proportions — re-apply bust scale after animation mixer updates bone transforms
    if (this.bustBones.length > 0) {
      this.applyBustScale();
    }

    // 4. State coordination — reads sensors, decides state
    this.reactionAccum += dt;
    if (this.reactionAccum >= this.REACTION_INTERVAL) {
      this.interaction.tick(this.REACTION_INTERVAL);
      this.reactionAccum -= this.REACTION_INTERVAL;
    }

    // 5. Look target priority: cursor > behavior > motion > idle drift
    const behaviorLook = this.animation.behaviorLookOverride;
    const hasMotion = this.input.motionActive && this.interaction.state === "CURIOUS";

    // Cursor → vrm.lookAt.target positioning
    const now = performance.now();
    if (!behaviorLook && now - this.lookAtTimestamp >= this.LOOKAT_IDLE_TIMEOUT) {
      this.lookAtActive = false;
    }

    if (!this.rendering.isDragging && this.lookAtActive && !behaviorLook) {
      this.lookAtTarget.position.x = this.lookAtNX * this.LOOKAT_H_RANGE;
      this.lookAtTarget.position.y = this.LOOKAT_Y + this.lookAtNY * this.LOOKAT_V_RANGE;
      this.lookAtTarget.position.z = this.LOOKAT_Z;
    } else {
      this.lookAtTarget.position.lerp(this.lookAtCenter, Math.min(1, dt * 3));
    }

    // Legacy look — IdleManager rotates neck (survives), head overridden by vrm.lookAt above
    if (behaviorLook) {
      this.animation.setLook(behaviorLook.x, behaviorLook.y);
    } else if (hasMotion) {
      this.animation.setLook(this.interaction.motionLookX, this.interaction.motionLookY);
    } else if (this.interaction.state === "IDLE") {
      const driftX = Math.sin(performance.now() * 0.0003) * 0.4;
      const driftY = Math.cos(performance.now() * 0.0002) * 0.2;
      this.animation.setLook(driftX, driftY);
    }

    // 6. Apply all VRM changes (morphs, bones)
    this.vrm.update(dt);

    // 7. Dance camera — ticks after vrm.update so the hips world position used
    //    for tracking reflects the current frame transforms, and after the state
    //    machine has updated so animState is current.
    //    If the character has no hips anchor, the dance camera must not start
    //    tracking from the world origin.
    if (this.hipsNode) {
      this.rendering.updateDanceCamera(dt, this.animation.stateMachine.currentAnimState);
    } else if (this.rendering.isDanceCameraDancing) {
      // If a dance somehow starts before the anchor exists, still inform the
      // controller of the current state so it can return cleanly.
      this.rendering.updateDanceCamera(dt, this.animation.stateMachine.currentAnimState);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.behaviorEngine.dispose();
    this.ai.dispose();
    this.input.dispose();
    this.animation.dispose();
    this.debugHelper?.dispose();
    this.floorRings.dispose(); // and never leave rings on the stage
    this.particleBurst.dispose(); // and never leave particles on the stage
    this.physics.dispose();
    this.touchReactions.reset();
    this.rendering.dispose();
    this.interaction.dispose();
    this.events.removeAll();
  }
}
