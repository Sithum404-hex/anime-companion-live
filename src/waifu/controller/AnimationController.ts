import type { VRM } from "@pixiv/three-vrm";
import type { EventBus } from "./EventBus";
import type { AudioFrame } from "../voiceEngine";
import type { AudioAnalysisSnapshot } from "../AudioAnalyzer";
import type { DanceDirector } from "../DanceDirector";
import { AnimationStateMachine, type AnimState } from "./AnimationStateMachine";
import {
  ExpressionController,
  type BaseEmotion,
  type ExpressionQueueItem,
} from "./ExpressionController";
import { LipSyncController } from "./LipSyncController";
import { IdleManager } from "./IdleManager";
import { AiBehaviorLayer } from "./AiBehaviorLayer";
import { SecondaryMotionController } from "./SecondaryMotionController";

/** @internal */
export type AudioFrameSource = () => AudioFrame;

/**
 * AnimationController owns all VRM animation subsystems:
 * state machine, expression, lip sync, idle procedurals, AI behaviors.
 * No other module touches VRM bones, morphs, or animation clips.
 */
export class AnimationController {
  readonly stateMachine: AnimationStateMachine;
  readonly expression: ExpressionController;
  readonly lipSync: LipSyncController;
  readonly idle: IdleManager;
  readonly behavior: AiBehaviorLayer;
  readonly secondaryMotion: SecondaryMotionController;

  private lipSyncAccum = 0;
  private readonly LIP_SYNC_INTERVAL = 1 / 30;

  private getAudioIntensity: () => number = () => 0;
  private getAudioBass: () => number = () => 0;
  private getAudioBeat: () => boolean = () => false;
  private getMicLevel: () => number = () => 0;

  constructor(vrm: VRM, bus: EventBus, getAudioFrame: AudioFrameSource) {
    this.stateMachine = new AnimationStateMachine(vrm, bus);
    this.expression = new ExpressionController(vrm, bus);
    this.lipSync = new LipSyncController(vrm, getAudioFrame);
    this.idle = new IdleManager(vrm);
    this.behavior = new AiBehaviorLayer(this.expression, this.stateMachine, this.idle, bus);
    this.secondaryMotion = new SecondaryMotionController(vrm);
  }

  setAudioIntensitySource(fn: () => number): void {
    this.getAudioIntensity = fn;
  }

  setAudioBassSource(fn: () => number): void {
    this.getAudioBass = fn;
  }

  setAudioBeatSource(fn: () => boolean): void {
    this.getAudioBeat = fn;
  }

  setMicLevelSource(fn: () => number): void {
    this.getMicLevel = fn;
  }

  setAudioFeaturesSource(fn: () => AudioAnalysisSnapshot | null): void {
    this.stateMachine.setAudioFeaturesSource(fn);
  }

  /** Latest music snapshot for consumers beyond animation (e.g. physics). */
  audioSnapshot(): { intensity: number; bass: number; beat: boolean } {
    return {
      intensity: this.getAudioIntensity(),
      bass: this.getAudioBass(),
      beat: this.getAudioBeat(),
    };
  }

  setDanceDirector(director: DanceDirector | null): void {
    this.stateMachine.setDanceDirector(director);
  }

  // ── Public API ──────────────────────────────────────────

  requestState(state: AnimState, bypassPriority = false): void {
    this.stateMachine.requestState(state, bypassPriority);
  }

  playAnimation(name: string): Promise<void> {
    return this.stateMachine.playAnimation(
      name as import("../vrmAnimationLoader").VRMAAnimationName,
    );
  }

  playAnimationFromUrl(url: string): Promise<void> {
    return this.stateMachine.playAnimationFromUrl(url);
  }

  stopAnimation(): void {
    this.stateMachine.stopAnimation();
  }

  triggerEmote(emoteName: string): Promise<void> {
    return this.stateMachine.triggerEmote(emoteName);
  }

  // ── AI Animation Director support ─────────────────────────

  playAiEmote(url: string, fadeSeconds?: number): Promise<void> {
    return this.stateMachine.playAiEmote(url, fadeSeconds);
  }

  requestAiEmoteState(state: import("./AnimationStateMachine").AnimState): void {
    this.stateMachine.requestAiEmoteState(state);
  }

  playAiDance(url: string, durationMs: number): Promise<void> {
    return this.stateMachine.playAiDance(url, durationMs);
  }

  cancelAiDance(): void {
    this.stateMachine.cancelAiDance();
  }

  isAiDanceActive(): boolean {
    return this.stateMachine.isAiDanceActive();
  }

  isManualEmoteRecent(withinMs?: number): boolean {
    return this.stateMachine.isManualEmoteRecent(withinMs);
  }

  setAiDanceEndedHandler(fn: () => void): void {
    this.stateMachine.onAiDanceEnded = fn;
  }

  get currentClipLabel(): string {
    return this.stateMachine.currentClipLabel;
  }

  get currentAnimState(): AnimState {
    return this.stateMachine.currentAnimState;
  }

  get hasIdleAction(): boolean {
    return this.stateMachine.hasIdleAction;
  }

  get isPlaying(): boolean {
    return this.stateMachine.isPlaying;
  }

  setBaseEmotion(e: BaseEmotion): void {
    this.expression.setBaseEmotion(e);
  }

  queueExpression(item: ExpressionQueueItem): void {
    this.expression.queueEmotion(item);
  }

  clearExpressionQueue(): void {
    this.expression.clearQueue();
  }

  setLook(x: number, y: number): void {
    this.idle.setLook(x, y);
  }

  get behaviorLookOverride(): { x: number; y: number } | null {
    return this.behavior.lookOverride;
  }

  onUserMessage(): void {
    this.behavior.onUserMessage();
  }

  onGreeting(): void {
    this.behavior.onGreeting();
  }

  onSilence(): void {
    this.behavior.onSilence();
  }

  onAIResponse(emotion: string, intensity: number): void {
    this.behavior.onAIResponse(emotion, intensity);
  }

  // ── Update ──────────────────────────────────────────────

  update(dt: number, waifuState: string): void {
    dt = Math.min(dt, 0.033);

    // 1. Mixer must run first (sets bone rotations from animation clips)
    this.stateMachine.getMixerUpdate(dt);
    this.stateMachine.tick(dt);

    const animState = this.currentAnimState;

    // Keep dance clips at authored speed — audio reactivity is handled by spring bones only.
    if (animState === "dance") {
      this.stateMachine.setTimeScale(1.0);
    }

    // Mic-driven mouth open for audio reactivity.
    // IMPORTANT: the mic measures the USER's voice — she must not lip-sync
    // to it. When she is speaking (TTS) the mouth is driven by LipSync only,
    // and while listening the mouth stays nearly closed (subtle surprise < 0.2).
    const micLevel = this.getMicLevel();
    const sheIsSpeaking = waifuState === "TALKING";
    if (!sheIsSpeaking && micLevel > 0.03) {
      this.expression.setMicMouthOpen(Math.min(0.18, micLevel * 0.4));
    } else {
      this.expression.setMicMouthOpen(0);
    }

    // 2. Expression morph targets
    this.expression.update(dt, animState, waifuState);

    // 3. Idle procedural bone overrides
    this.idle.update(dt, animState, this.hasIdleAction, this.isPlaying);

    // 4. Lip sync (throttled to 30 FPS)
    this.lipSyncAccum += dt;
    if (this.lipSyncAccum >= this.LIP_SYNC_INTERVAL) {
      this.lipSync.update(this.LIP_SYNC_INTERVAL);
      this.lipSyncAccum -= this.LIP_SYNC_INTERVAL;
    }

    // 5. AI behavior micro-actions
    this.behavior.update(dt);

    // 6. Secondary spring-bone tuning (hair, ears, tail)
    this.secondaryMotion.update(dt, animState, {
      intensity: this.getAudioIntensity(),
      bass: this.getAudioBass(),
      beat: this.getAudioBeat(),
    });
  }

  /** Must be called after all morph and bone changes to apply them. */
  applyVrm(vrm: VRM): void {
    vrm.update(0);
  }

  dispose(): void {
    this.stateMachine.dispose();
    this.expression.dispose();
    this.lipSync.dispose();
    this.idle.dispose();
    this.behavior.dispose();
    this.secondaryMotion.dispose();
  }
}
