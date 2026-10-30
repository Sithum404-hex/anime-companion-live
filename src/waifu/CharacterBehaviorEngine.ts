/**
 * CharacterBehaviorEngine
 *
 * The single authority for deciding what the character should be doing. It
 * never touches Three.js directly: AnimationStateMachine remains the sole
 * owner of the VRM AnimationMixer. Every animation request has to pass
 * through this engine first, so conversation, TTS, music, idle behaviour and
 * explicit actions cannot fight each other.
 */
import type { RawAiIntent } from "./types";
import {
  getAllDanceUrls,
  resolveIntentUrl,
  validateAiIntent,
  type ValidatedAiIntent,
} from "./animationRegistry";
import { getDanceAnimations, resolveAnimationUrl } from "./vrmAnimationLoader";
import type { AnimationStateMachine, AnimState } from "./controller/AnimationStateMachine";
import type { EventBus } from "./controller/EventBus";

export const DEBUG_BEHAVIOR = false;

export type CharacterBehaviorState =
  | "IDLE"
  | "LISTENING"
  | "WAITING_FOR_AI"
  | "THINKING"
  | "PRE_SPEECH"
  | "SPEAKING"
  | "POST_SPEECH"
  | "EMOTIONAL_REACTION"
  | "GESTURE"
  | "PRE_DANCE"
  | "DANCING"
  | "POST_DANCE"
  | "POSE"
  | "RETURNING_TO_BASE";

export type AttentionState =
  | "FOCUSED"
  | "LISTENING"
  | "THINKING"
  | "SPEAKING"
  | "IDLE"
  | "DISTRACTED";
export type TtsBehaviorState =
  | "TTS_IDLE"
  | "TTS_STARTING"
  | "TTS_PLAYING"
  | "TTS_PAUSING"
  | "TTS_FINISHED"
  | "TTS_CANCELLED";
type EmotionName =
  | "happiness"
  | "sadness"
  | "anger"
  | "excitement"
  | "embarrassment"
  | "gratitude"
  | "neutral";
type ActionKind = "state" | "emote" | "dance";

interface EmotionValue {
  value: number;
  updatedAt: number;
}

interface ScheduledAction {
  id: string;
  label: string;
  kind: ActionKind;
  url?: string;
  state?: AnimState;
  priority: number;
  confidence: number;
  interruptible: boolean;
  reason: string;
}

interface Candidate {
  id: string;
  score: number;
  action: ScheduledAction;
}

export interface CharacterBehaviorDebugState {
  state: CharacterBehaviorState;
  currentAnimation: string | null;
  previousAnimation: string | null;
  targetAnimation: string | null;
  emotion: string;
  emotionStrength: number;
  attention: AttentionState;
  tts: TtsBehaviorState;
  aiGeneration: "idle" | "generating";
  generationDurationMs: number;
  music: "active" | "idle";
  priority: number;
  currentAction: string | null;
  actionQueue: string[];
  animationDurationMs: number;
  timeSinceLastReactionMs: number;
  timeSinceLastGestureMs: number;
  lastAiIntent: string | null;
  confidence: number;
  reason: string;
}

export interface CharacterBehaviorEngineDeps {
  stateMachine: AnimationStateMachine;
  events: EventBus;
  isMusicPlaying: () => boolean;
}

export interface CharacterBehaviorConfig {
  thinkingEligibleMs: number;
  thinkingPreferredMs: number;
  longWaitVariationMs: number;
  behaviorTickMs: number;
  hysteresis: number;
  postSpeechMs: number;
}

const CONFIG: CharacterBehaviorConfig = {
  thinkingEligibleMs: 1_500,
  thinkingPreferredMs: 2_500,
  longWaitVariationMs: 8_000,
  behaviorTickMs: 125,
  hysteresis: 0.14,
  postSpeechMs: 850,
};

const DECAY_PER_SECOND: Record<EmotionName, number> = {
  happiness: 0.07,
  sadness: 0.035,
  anger: 0.065,
  excitement: 0.12,
  embarrassment: 0.09,
  gratitude: 0.075,
  neutral: 0.18,
};

const REACTION_IDS = new Set([
  "happy",
  "excited",
  "angry",
  "sad",
  "crying",
  "bashful",
  "thankful",
  "rejected",
  "threatening",
  "surprised",
  "kiss",
  "blow_kiss",
  "crazy",
  "jump",
  "jog",
  "pose",
  "hand_raise",
  "no",
  "bunny_ears",
  "draw_a_star",
  "cheer",
  "greeting",
  "hey",
  "goodbye",
  "selfie",
  "sing",
  "heart_flutter",
  "angry_pose",
  "cold_lonely",
]);

const DANCE_DURATION_MS = 12_000;
const HISTORY_LIMIT = 16;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function isStopRequest(text: string): boolean {
  return /\b(stop|quit|don't|do not)\b.*\b(danc|music|move)\b|\bstop dancing\b/i.test(text);
}

function emotionFromText(text: string): EmotionName | null {
  const lower = text.toLowerCase();
  if (/\b(sorry|sad|hurt|terrible|cry|awful|rough)\b|😢|😭/.test(lower)) return "sadness";
  if (/\b(thank|grateful|appreciate)\b/.test(lower)) return "gratitude";
  if (/\b(angry|mad|furious|hate)\b/.test(lower)) return "anger";
  if (/\b(amazing|awesome|yay|wow|excited|let's go)\b|😂|😄/.test(lower)) return "excitement";
  if (/\b(cute|kiss|love|blush|embarrass)\b|❤️/.test(lower)) return "embarrassment";
  if (/\b(good|glad|happy|nice)\b/.test(lower)) return "happiness";
  return null;
}

/**
 * High-level acting state machine. It evaluates at 8 Hz; the actual mixer
 * still updates in the existing render loop.
 */
export class CharacterBehaviorEngine {
  private readonly config: CharacterBehaviorConfig;
  private readonly stateMachine: AnimationStateMachine;
  private readonly isMusicPlaying: () => boolean;
  private removeCompletionListener: (() => void) | null = null;

  private state: CharacterBehaviorState = "IDLE";
  private attention: AttentionState = "IDLE";
  private ttsState: TtsBehaviorState = "TTS_IDLE";
  private stateStartedAt = performance.now();
  private tickAccumulator = 0;
  private generationStartedAt: number | null = null;
  private userListening = false;
  private externalDance = false;
  private pendingIntent: ValidatedAiIntent | null = null;
  private pendingIntentConfidence = 0;
  private queue: ScheduledAction[] = [];
  private currentAction: ScheduledAction | null = null;
  private pendingCompletion = false;
  private completionAfter = 0;
  private postSpeechUntil = 0;
  private nextIdleEvaluationAt = performance.now() + this.randomRange(20_000, 45_000);
  private nextMicroEvaluationAt = performance.now() + this.randomRange(18_000, 35_000);
  private lastWaitingVariationAt = 0;
  private readonly cooldowns = new Map<string, number>();
  private readonly history: string[] = [];
  private readonly emotion: Record<EmotionName, EmotionValue> = {
    happiness: { value: 0, updatedAt: performance.now() },
    sadness: { value: 0, updatedAt: performance.now() },
    anger: { value: 0, updatedAt: performance.now() },
    excitement: { value: 0, updatedAt: performance.now() },
    embarrassment: { value: 0, updatedAt: performance.now() },
    gratitude: { value: 0, updatedAt: performance.now() },
    neutral: { value: 0.35, updatedAt: performance.now() },
  };
  private lastReason = "Initial idle";
  private previousAnimation: string | null = null;
  private currentAnimation: string | null = "Idle.vrma";
  private targetAnimation: string | null = null;
  private lastReactionAt = performance.now();
  private lastGestureAt = performance.now();
  private disposed = false;

  constructor(deps: CharacterBehaviorEngineDeps, config: Partial<CharacterBehaviorConfig> = {}) {
    this.stateMachine = deps.stateMachine;
    this.isMusicPlaying = deps.isMusicPlaying;
    this.config = { ...CONFIG, ...config };
    this.removeCompletionListener = deps.events.on("anim:complete", () =>
      this.onAnimationCompleted(),
    );
  }

  /** User message submission is both conversation context and generation start. */
  onUserMessage(text = ""): void {
    if (this.disposed) return;
    this.userListening = false;
    if (isStopRequest(text)) this.stopDance("Explicit user stop request");
    this.enter("LISTENING", "User message received");
    this.startGeneration();
  }

  setUserListening(active: boolean): void {
    if (this.disposed) return;
    this.userListening = active;
    if (active) {
      this.enter("LISTENING", "User is speaking");
      return;
    }
    if (!this.generationStartedAt && !this.isTtsPlaying())
      this.enter("IDLE", "User finished speaking");
  }

  startGeneration(): void {
    if (this.disposed) return;
    this.generationStartedAt = performance.now();
    this.pendingIntent = null;
    this.pendingIntentConfidence = 0;
    this.queue = this.queue.filter((entry) => entry.priority >= 90);
    this.enter("WAITING_FOR_AI", "AI generation started");
  }

  onGenerationFailed(): void {
    if (this.disposed) return;
    this.generationStartedAt = null;
    this.pendingIntent = null;
    this.queue = [];
    this.currentAction = null;
    this.enter(this.resolveReturnState(), "AI generation failed");
  }

  /** Validated downstream; invalid or low-confidence intents naturally become no action. */
  onAiIntent(raw: RawAiIntent | null, ttsExpected: boolean): void {
    if (this.disposed) return;
    // A fresh manual (user-triggered) emote outranks AI direction — drop the
    // AI intent so it can't override what the user just played.
    if (this.stateMachine.isManualEmoteRecent()) {
      this.pendingIntent = null;
      return;
    }
    const intent = validateAiIntent(raw);
    this.pendingIntent = intent;
    this.pendingIntentConfidence = clamp(raw?.confidence ?? raw?.intensity ?? 0.6);
    if (!ttsExpected && !this.generationStartedAt) this.scheduleResponseIntent();
  }

  onAiResponse(emotion: string, intensity: number, response = ""): void {
    if (this.disposed) return;
    this.generationStartedAt = null;
    this.applyEmotion(
      this.normalizeEmotion(emotion) ?? emotionFromText(response) ?? "neutral",
      intensity,
    );
    this.enter("PRE_SPEECH", "AI response received");
    if (this.ttsState === "TTS_IDLE" || this.ttsState === "TTS_CANCELLED") {
      this.scheduleResponseIntent();
      if (!this.currentAction && this.queue.length === 0) {
        this.enter(this.resolveReturnState(), "Text response without TTS");
      }
    }
  }

  onTtsStarting(): void {
    if (this.disposed) return;
    this.ttsState = "TTS_STARTING";
    if (this.state !== "DANCING") this.enter("PRE_SPEECH", "TTS preparing");
  }

  onTtsStarted(): void {
    if (this.disposed) return;
    this.ttsState = "TTS_PLAYING";
    this.scheduleResponseIntent();
    if (!this.currentAction && this.queue.length === 0) this.enter("SPEAKING", "TTS started");
  }

  onTtsEnded(cancelled = false): void {
    if (this.disposed) return;
    this.ttsState = cancelled ? "TTS_CANCELLED" : "TTS_FINISHED";
    if (this.currentAction || this.queue.length > 0 || this.state === "DANCING") return;
    this.postSpeechUntil = performance.now() + this.config.postSpeechMs;
    this.enter("POST_SPEECH", cancelled ? "TTS cancelled" : "TTS finished");
  }

  /** Music and screen-vision dance requests use the same state machine authority. */
  setExternalDance(active: boolean, reason = "Music dance state changed"): void {
    if (this.disposed) return;
    this.externalDance = active;
    if (active) {
      this.queue = this.queue.filter((entry) => entry.priority >= 95);
      if (!this.currentAction || this.currentAction.kind !== "dance") this.enter("DANCING", reason);
    } else if (this.state === "DANCING" && !this.currentAction) {
      this.enter(this.resolveReturnState(), reason);
    }
  }

  stopDance(reason = "Explicit stop"): void {
    this.externalDance = false;
    this.queue = this.queue.filter((entry) => entry.kind !== "dance");
    this.currentAction = null;
    this.stateMachine.cancelAiDance();
    this.stateMachine.setDanceRequested(false);
    this.enter(this.resolveReturnState(), reason);
  }

  /** Called by the existing state machine when an explicit AI dance times out. */
  onAiDanceEnded(): void {
    if (this.disposed || this.currentAction?.kind !== "dance") return;
    // Release the dance lock before the post-action chain. The state machine
    // otherwise correctly protects a dance from gestures, which would also
    // block the intentional Happy recovery after an explicit dance.
    this.stateMachine.setDanceRequested(false);
    this.stateMachine.requestState("idle", true);
    this.pendingCompletion = true;
    this.completionAfter = performance.now();
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.tickAccumulator += Math.min(dt, 0.1) * 1000;
    if (this.tickAccumulator < this.config.behaviorTickMs) return;
    const elapsed = this.tickAccumulator;
    this.tickAccumulator = 0;
    this.tick(elapsed);
  }

  getDebugInfo(): CharacterBehaviorDebugState {
    const dominant = this.getDominantEmotion();
    const now = performance.now();
    return {
      state: this.state,
      currentAnimation: this.currentAnimation,
      previousAnimation: this.previousAnimation,
      targetAnimation: this.targetAnimation,
      emotion: dominant.name,
      emotionStrength: Number(dominant.value.toFixed(2)),
      attention: this.attention,
      tts: this.ttsState,
      aiGeneration: this.generationStartedAt ? "generating" : "idle",
      generationDurationMs: this.generationStartedAt
        ? Math.round(now - this.generationStartedAt)
        : 0,
      music: this.hasMusicDance() ? "active" : "idle",
      priority: this.currentAction?.priority ?? 10,
      currentAction: this.currentAction?.label ?? null,
      actionQueue: this.queue.map((entry) => entry.label),
      animationDurationMs: Math.round(now - this.stateStartedAt),
      timeSinceLastReactionMs: Math.round(now - this.lastReactionAt),
      timeSinceLastGestureMs: Math.round(now - this.lastGestureAt),
      lastAiIntent: this.pendingIntent?.id ?? null,
      confidence: this.currentAction?.confidence ?? this.pendingIntentConfidence,
      reason: this.lastReason,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.removeCompletionListener?.();
    this.removeCompletionListener = null;
    this.queue = [];
    this.currentAction = null;
  }

  private tick(dtMs: number): void {
    const now = performance.now();
    this.decayEmotions(dtMs / 1000, now);

    if (this.pendingCompletion && now >= this.completionAfter) {
      this.pendingCompletion = false;
      this.finishCurrentAction();
    }

    if (this.generationStartedAt) this.updateGenerationBehavior(now);

    const musicDance = this.hasMusicDance();
    if (musicDance && !this.currentAction && this.state !== "DANCING") {
      this.enter("DANCING", "Music dance owns the animation channel");
    } else if (!musicDance && this.state === "DANCING" && !this.currentAction) {
      this.enter(this.resolveReturnState(), "Music dance released control");
    }

    if (!this.currentAction && this.queue.length > 0) {
      this.startNextAction();
      return;
    }

    if (this.state === "POST_SPEECH" && now >= this.postSpeechUntil) {
      this.enter(this.resolveReturnState(), "Post-speech hold complete");
    }

    this.evaluateAmbientBehavior(now);
  }

  private updateGenerationBehavior(now: number): void {
    const elapsed = now - this.generationStartedAt!;
    if (elapsed < this.config.thinkingEligibleMs) {
      if (this.state !== "LISTENING" && this.state !== "WAITING_FOR_AI") {
        this.enter("WAITING_FOR_AI", "AI generation under thinking threshold");
      }
      return;
    }

    if (!this.currentAction && !this.hasMusicDance() && this.state !== "THINKING") {
      this.enter("THINKING", `AI generation ${Math.round(elapsed)}ms`);
    }

    if (
      elapsed >= this.config.longWaitVariationMs &&
      now - this.lastWaitingVariationAt > 12_000 &&
      !this.currentAction &&
      !this.hasMusicDance() &&
      Math.random() < 0.12
    ) {
      this.lastWaitingVariationAt = now;
      this.enqueue(this.makeEmote("look_around", "Long AI wait variation", 35, 0.45), false);
    }
  }

  private scheduleResponseIntent(): void {
    const intent = this.pendingIntent;
    if (
      !intent ||
      this.queue.some((entry) => entry.id === intent.id) ||
      this.currentAction?.id === intent.id
    ) {
      return;
    }
    this.pendingIntent = null;
    const confidence = this.pendingIntentConfidence;

    // Explicit requests are still high-priority, but uncertain AI directions
    // resolve to natural conversation rather than a dramatic random action.
    const explicit =
      intent.isDance ||
      [
        "kiss",
        "blow_kiss",
        "jump",
        "jog",
        "pose",
        "bunny_ears",
        "greeting",
        "goodbye",
        "selfie",
        "sing",
        "cheer",
      ].includes(intent.id);
    if (!explicit && confidence < 0.45) return;
    if (this.hasMusicDance() && !intent.isDance) return;

    const chain = this.makeIntentChain(intent, confidence);
    for (const action of chain) this.enqueue(action);
  }

  private makeIntentChain(intent: ValidatedAiIntent, confidence: number): ScheduledAction[] {
    if (intent.isDance) {
      const dance = this.selectDance(intent, confidence);
      return [
        this.makeEmote("excited", "Anticipation for explicit dance", 80, confidence),
        dance,
        this.makeEmote("happy", "Post-dance recovery", 70, Math.max(0.55, confidence)),
      ];
    }

    if (intent.id === "kiss" || intent.id === "blow_kiss") {
      return [
        this.makeEmote("bashful", "Anticipation for affectionate action", 70, confidence),
        this.makeEmote(intent.id, "Explicit affectionate request", 95, confidence),
        this.makeEmote("happy", "Affectionate action recovery", 55, 0.55),
      ];
    }

    if (intent.id === "crazy") {
      return [
        this.makeEmote("crazy", "Conversation reaction", 75, confidence),
        this.makeEmote("happy", "Lighthearted recovery", 45, 0.5),
      ];
    }

    if (
      intent.id === "thinking" ||
      intent.id === "talking" ||
      intent.id === "listening" ||
      intent.id === "idle"
    ) {
      return [];
    }

    return [
      this.makeEmote(
        intent.id,
        `AI intent: ${intent.id}`,
        intent.priority,
        confidence,
        intent.tags,
      ),
    ];
  }

  private selectDance(intent: ValidatedAiIntent, confidence: number): ScheduledAction {
    const files = intent.danceStyles?.length
      ? intent.danceStyles
      : getDanceAnimations().map((entry) => entry.name);
    const candidates: Candidate[] = [];
    for (const file of files) {
      const url = resolveAnimationUrl(file);
      if (!url) continue;
      const repetition = this.history.filter((id) => id === `dance:${file}`).length * 0.35;
      const cooldown = this.isCoolingDown(`dance:${file}`) ? 1 : 0;
      candidates.push({
        id: `dance:${file}`,
        score:
          1 +
          (intent.id === "energetic_dance" && /Snake|Hip Hop|Shuffling|Samba|Jazz|Arms/i.test(file)
            ? 0.3
            : 0) -
          repetition -
          cooldown,
        action: {
          id: `dance:${file}`,
          label: file,
          kind: "dance" as const,
          url,
          priority: 95,
          confidence,
          interruptible: true,
          reason: `Explicit ${intent.label} request`,
        },
      });
    }
    return (
      this.selectWeighted(candidates)?.action ?? {
        id: "dance:fallback",
        label: "Dance",
        kind: "dance",
        url: getAllDanceUrls()[0],
        priority: 95,
        confidence,
        interruptible: true,
        reason: "Explicit dance request",
      }
    );
  }

  private evaluateAmbientBehavior(now: number): void {
    if (
      this.currentAction ||
      this.queue.length ||
      this.generationStartedAt ||
      this.isTtsPlaying() ||
      this.hasMusicDance()
    )
      return;
    if (this.state !== "IDLE" && this.state !== "LISTENING") return;

    const idleFor = now - this.stateStartedAt;
    if (now >= this.nextIdleEvaluationAt && idleFor >= 20_000) {
      this.nextIdleEvaluationAt = now + this.randomRange(20_000, 45_000);
      // A low probability and long cooldown preserve intentional stillness.
      if (Math.random() < 0.25) {
        const candidate = this.selectWeighted([
          this.scoreAmbient("look_around", "Idle look-around", 0.65),
          this.scoreAmbient("pose", "Rare standing idle variation", 0.25),
        ]);
        if (candidate) this.enqueue(candidate.action);
      }
      return;
    }

    if (now >= this.nextMicroEvaluationAt) {
      this.nextMicroEvaluationAt = now + this.randomRange(18_000, 38_000);
      // Most evaluations intentionally produce no visible body action.
      if (Math.random() >= 0.05) return;
      const dominant = this.getDominantEmotion();
      const candidates = [
        this.scoreAmbient("look_around", "Rare micro behaviour", 0.35),
        this.scoreAmbient(
          "thankful",
          "Gratitude micro behaviour",
          dominant.name === "gratitude" ? 0.55 : 0.05,
        ),
        this.scoreAmbient(
          "bashful",
          "Embarrassed micro behaviour",
          dominant.name === "embarrassment" ? 0.45 : 0.03,
        ),
      ];
      const selected = this.selectWeighted(candidates);
      if (selected) this.enqueue(selected.action);
    }
  }

  private scoreAmbient(id: string, reason: string, contextScore: number): Candidate {
    const action = this.makeEmote(id, reason, 20, 0.35);
    const repetitions = this.history.filter((entry) => entry === id).length;
    const cooldownPenalty = this.isCoolingDown(id) ? 1 : 0;
    return {
      id,
      score: contextScore + 0.2 - repetitions * 0.12 - cooldownPenalty,
      action,
    };
  }

  private startNextAction(): void {
    const action = this.queue.shift();
    if (!action) return;
    if (this.hasMusicDance() && action.priority < 95) return;
    this.currentAction = action;
    this.targetAnimation = action.label;
    this.lastReason = action.reason;
    this.record(action.id);
    this.cooldowns.set(action.id, performance.now() + this.cooldownFor(action));

    if (action.kind === "dance") {
      if (!action.url) {
        this.finishCurrentAction();
        return;
      }
      this.enter("DANCING", action.reason, false);
      void this.stateMachine.playAiDance(action.url, DANCE_DURATION_MS);
      return;
    }

    if (action.kind === "state" && action.state) {
      this.enter(this.stateForAnimState(action.state), action.reason, false);
      this.stateMachine.requestState(action.state, true);
      this.pendingCompletion = true;
      this.completionAfter = performance.now() + 1_200;
      return;
    }

    if (!action.url) {
      this.finishCurrentAction();
      return;
    }
    this.enter(this.stateForAction(action), action.reason, false);
    void this.stateMachine.playAiEmote(action.url, action.priority >= 80 ? 0.25 : 0.4);
  }

  private onAnimationCompleted(): void {
    if (!this.currentAction || this.currentAction.kind === "dance") return;
    this.pendingCompletion = true;
    this.completionAfter = performance.now() + 40;
  }

  private finishCurrentAction(): void {
    const completed = this.currentAction;
    this.currentAction = null;
    this.previousAnimation = this.currentAnimation;
    this.targetAnimation = null;
    if (completed && REACTION_IDS.has(completed.id)) {
      this.lastReactionAt = performance.now();
      this.lastGestureAt = this.lastReactionAt;
    }
    if (this.queue.length > 0) return;
    this.enter(
      this.resolveReturnState(),
      completed ? `${completed.label} completed` : "Action completed",
    );
  }

  private enter(next: CharacterBehaviorState, reason: string, applyAnimation = true): void {
    if (this.disposed) return;
    if (this.state === next) {
      this.lastReason = reason;
      return;
    }
    this.state = next;
    this.stateStartedAt = performance.now();
    this.lastReason = reason;
    this.attention = this.attentionFor(next);
    if (!applyAnimation) return;

    const target = this.animationStateFor(next);
    if (!target) return;
    this.previousAnimation = this.currentAnimation;
    this.currentAnimation = this.animationLabelFor(target);
    this.targetAnimation = null;
    this.stateMachine.requestState(target, true);
  }

  private resolveReturnState(): CharacterBehaviorState {
    if (this.hasMusicDance()) return "DANCING";
    if (this.isTtsPlaying()) return "SPEAKING";
    if (this.userListening) return "LISTENING";
    const dominant = this.getDominantEmotion();
    if (dominant.value >= 0.42 && dominant.name === "sadness") return "RETURNING_TO_BASE";
    return "IDLE";
  }

  private animationStateFor(state: CharacterBehaviorState): AnimState | null {
    switch (state) {
      case "LISTENING":
      case "WAITING_FOR_AI":
        return "listening";
      case "THINKING":
        return "thinking";
      case "PRE_SPEECH":
        return this.isTtsPlaying() ? "talking" : null;
      case "SPEAKING":
      case "POST_SPEECH":
        return this.isTtsPlaying() ? "talking" : "idle";
      case "POSE":
        return "pose";
      case "DANCING":
        return "dance";
      case "RETURNING_TO_BASE":
      case "IDLE":
      default:
        return "idle";
    }
  }

  private stateForAction(action: ScheduledAction): CharacterBehaviorState {
    if (action.id === "pose") return "POSE";
    if (action.id === "look_around" || action.id === "hand_raise" || action.id === "no")
      return "GESTURE";
    return "EMOTIONAL_REACTION";
  }

  private stateForAnimState(state: AnimState): CharacterBehaviorState {
    if (state === "thinking") return "THINKING";
    if (state === "talking") return "SPEAKING";
    if (state === "listening") return "LISTENING";
    return "EMOTIONAL_REACTION";
  }

  private attentionFor(state: CharacterBehaviorState): AttentionState {
    if (state === "LISTENING" || state === "WAITING_FOR_AI") return "LISTENING";
    if (state === "THINKING") return "THINKING";
    if (state === "SPEAKING" || state === "PRE_SPEECH" || state === "POST_SPEECH")
      return "SPEAKING";
    if (state === "DANCING") return "FOCUSED";
    return "IDLE";
  }

  private animationLabelFor(state: AnimState): string {
    const labels: Record<AnimState, string> = {
      idle: "Idle.vrma",
      listening: "Idle.vrma (listening)",
      thinking: "Thinking.vrma",
      talking: "Talking.vrma",
      happy: "Happy.vrma",
      sad: "Rejected.vrma",
      gesture: "Gesture.vrma",
      surprised: "Angry.vrma",
      dance: "Dance.vrma",
      pose: "Female Standing Pose.vrma",
    };
    return labels[state];
  }

  private makeEmote(
    id: string,
    reason: string,
    priority: number,
    confidence: number,
    tags?: string[],
  ): ScheduledAction {
    const intent = validateAiIntent({ action: id, intensity: confidence, tags });
    // Rotate through pool files by how often this id has already played, so
    // generic requests (pose, greeting) never repeat the same clip twice in a row.
    const pick = this.history.filter((entry) => entry === id).length;
    const url = intent ? resolveIntentUrl(intent, pick, tags) : null;
    return {
      id,
      label: intent?.label ?? id,
      kind: "emote",
      url: url ?? undefined,
      priority,
      confidence,
      interruptible: !["kiss", "blow_kiss"].includes(id),
      reason,
    };
  }

  private enqueue(action: ScheduledAction, merge = true): void {
    if (!action.url && action.kind === "emote") return;
    if (
      merge &&
      (this.currentAction?.id === action.id || this.queue.some((entry) => entry.id === action.id))
    )
      return;
    if (this.isCoolingDown(action.id) && action.priority < 90) return;
    this.queue.push(action);
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  private selectWeighted(candidates: Candidate[]): Candidate | null {
    const valid = candidates
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!valid.length) return null;
    const top = valid.filter(
      (candidate) => candidate.score >= valid[0].score - this.config.hysteresis,
    );
    const total = top.reduce((sum, candidate) => sum + candidate.score, 0);
    let cursor = Math.random() * total;
    for (const candidate of top) {
      cursor -= candidate.score;
      if (cursor <= 0) return candidate;
    }
    return top[0];
  }

  private applyEmotion(name: EmotionName, intensity: number): void {
    const now = performance.now();
    const target = this.emotion[name];
    const existing = target.value;
    target.value = Math.max(existing * 0.55, clamp(intensity));
    target.updatedAt = now;
    if (name !== "neutral") {
      this.emotion.neutral.value *= 0.65;
      const conflicting: EmotionName[] = [
        "happiness",
        "sadness",
        "anger",
        "excitement",
        "embarrassment",
        "gratitude",
      ];
      for (const other of conflicting) {
        if (other !== name) this.emotion[other].value *= 0.86;
      }
    }
  }

  private decayEmotions(seconds: number, now: number): void {
    for (const [name, value] of Object.entries(this.emotion) as Array<
      [EmotionName, EmotionValue]
    >) {
      value.value *= Math.exp(-DECAY_PER_SECOND[name] * seconds);
      value.updatedAt = now;
    }
    this.emotion.neutral.value = Math.max(this.emotion.neutral.value, 0.12);
  }

  private getDominantEmotion(): { name: EmotionName; value: number } {
    let best: EmotionName = "neutral";
    let value = this.emotion.neutral.value;
    for (const [name, entry] of Object.entries(this.emotion) as Array<
      [EmotionName, EmotionValue]
    >) {
      if (entry.value > value) {
        best = name;
        value = entry.value;
      }
    }
    return { name: best, value };
  }

  private normalizeEmotion(value: string): EmotionName | null {
    const normalized = value.toLowerCase();
    if (normalized === "happy") return "happiness";
    if (normalized === "sad" || normalized === "scared") return "sadness";
    if (normalized === "angry" || normalized === "annoyed") return "anger";
    if (normalized === "excited") return "excitement";
    if (normalized === "embarrassed" || normalized === "bashful") return "embarrassment";
    if (normalized === "thankful") return "gratitude";
    if (normalized === "neutral" || normalized === "calm") return "neutral";
    return null;
  }

  private hasMusicDance(): boolean {
    return this.externalDance || this.isMusicPlaying();
  }

  private isTtsPlaying(): boolean {
    return this.ttsState === "TTS_PLAYING" || this.ttsState === "TTS_STARTING";
  }

  private cooldownFor(action: ScheduledAction): number {
    if (action.kind === "dance") return 20_000;
    if (action.id === "look_around") return 30_000;
    if (action.priority >= 80) return 14_000;
    return 12_000;
  }

  private isCoolingDown(id: string): boolean {
    return (this.cooldowns.get(id) ?? 0) > performance.now();
  }

  private record(id: string): void {
    this.history.push(id);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  private randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }
}
