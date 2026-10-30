import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { EventBus } from "./EventBus";
import {
  loadVRMAnimation,
  loadBuiltInAnimation,
  clearAnimationCache,
  resolveAnimationUrl,
  type VRMAAnimationName,
} from "../vrmAnimationLoader";
import type { AudioAnalysisSnapshot } from "../AudioAnalyzer";
import type { DanceDirector } from "../DanceDirector";
import type { DanceMetadata } from "../danceMetadata";

export type AnimState =
  | "idle"
  | "talking"
  | "listening"
  | "happy"
  | "sad"
  | "thinking"
  | "gesture"
  | "surprised"
  | "dance"
  | "pose";

const FADE_DURATION = 0.4;
const INACTIVITY_TIMEOUT = 30;
const STATE_TIMEOUTS: Record<AnimState, number> = {
  idle: Infinity,
  talking: Infinity,
  listening: Infinity,
  happy: 4,
  sad: 4,
  thinking: Infinity,
  gesture: 4,
  surprised: 3.5,
  dance: Infinity,
  pose: Infinity,
};

const STATE_PRIORITY: Record<AnimState, number> = {
  idle: 0,
  listening: 1,
  thinking: 2,
  sad: 3,
  happy: 3,
  gesture: 4,
  surprised: 4,
  dance: 5,
  pose: 4,
  talking: 10,
};

const ONESHOT_STATES: Set<AnimState> = new Set<AnimState>([
  "happy",
  "sad",
  "gesture",
  "surprised",
  "pose",
]);

/** Exact, verified animation names. Named assets resolve through the shared loader. */
const VRMA_MAP: Record<AnimState, string> = {
  idle: "Idle",
  talking: "Talking",
  listening: "Idle",
  happy: "Happy",
  sad: "Rejected",
  thinking: "Thinking",
  gesture: "Excited",
  surprised: "Angry",
  dance: "Idle",
  pose: "Female Standing Pose",
};

const STATE_LABELS: Record<AnimState, string> = {
  idle: "Idle",
  talking: "Talking",
  listening: "Listening",
  happy: "Happy",
  sad: "Sad",
  thinking: "Thinking",
  gesture: "Gesture",
  surprised: "Surprised",
  dance: "Dance",
  pose: "Pose",
};

export class AnimationStateMachine {
  private mixer: THREE.AnimationMixer;
  private currentAction: THREE.AnimationAction | null = null;
  private currentClipName = "";
  private idleAction: THREE.AnimationAction | null = null;
  private fadingAction: THREE.AnimationAction | null = null;

  private animState: AnimState = "idle";
  private prevAnimState: AnimState | null = null;
  private stateTimer = 0;
  private inactivityTimer = 0;
  private totalTransitions = 0;
  private dancePool: string[] = [];
  private danceAction: THREE.AnimationAction | null = null;
  private danceTimer = 0;
  private danceDuration = 15;
  private danceRequested = false;
  private nextDanceAction: THREE.AnimationAction | null = null;
  private nextDanceUrl: string | null = null;
  private director: DanceDirector | null = null;
  private currentDanceMeta: DanceMetadata | null = null;
  private manualEmoteActive = false;
  private getAudioFeatures: () => AudioAnalysisSnapshot | null = () => null;

  // ── AI Animation Director support ──────────────────────
  /** True while an AI-directed emote is playing (protects it from TTS-start). */
  private aiEmoteActive = false;
  /** Locked dance URL for explicit AI dance requests (no auto-cycling). */
  private aiDanceUrl: string | null = null;
  private aiDanceUntil = 0;
  /** Timestamp of the last manual (user-triggered) animation. */
  private manualEmoteAt = 0;
  /** Fired when a locked AI dance finishes its duration. */
  onAiDanceEnded?: () => void;

  // ── Idle flavor breaks ──
  // Idle variations are scheduled by CharacterBehaviorEngine, never by an
  // independent mixer timer. This guard remains for backward compatibility.
  private readonly idleFlavorPool: string[] = [];
  private idleFlavorTimer = 15 + Math.random() * 15;
  private idleFlavorAccum = 0;
  private flavorActive = false;

  private _isDisposed = false;
  private _stateToken = 0;
  readonly idleReady: Promise<void>;

  /** Get or create an action for a clip, avoiding duplicates. */
  private _action(clip: THREE.AnimationClip): THREE.AnimationAction {
    return this.mixer.existingAction(clip) || this.mixer.clipAction(clip);
  }

  /** Full action startup — all required flags set, then play(). */
  private _playAction(
    action: THREE.AnimationAction,
    loop: THREE.AnimationActionLoopStyles = THREE.LoopRepeat,
    repetitions = Infinity,
    weight = 1,
  ): void {
    action.reset();
    action.enabled = true;
    action.setLoop(loop, repetitions);
    action.clampWhenFinished = false;
    action.time = 0;
    action.timeScale = 1;
    action.setEffectiveWeight(weight);
    action.play();
  }

  private _onFinished = (e: { action: THREE.AnimationAction }) => {
    if (this._isDisposed) return;
    // Timer handles dance cycling; this is a safety net for oneshots.
    if (this.danceAction && e.action === this.danceAction && this.danceRequested) {
      this.log(`[Dance] Clip finished unexpectedly — cycling`);
      this.playDance();
    }
  };

  constructor(
    private vrm: VRM,
    private events: EventBus,
  ) {
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.mixer.addEventListener("finished", this._onFinished);
    this.idleReady = this.loadIdleAnimation();
    this.log("[Boot] ASM initialized — awaiting idle clip");
  }

  // ── Getters ──────────────────────────────────────────────

  get hasIdleAction(): boolean {
    return this.idleAction !== null && this.idleAction.isRunning();
  }

  get currentAnimState(): AnimState {
    return this.animState;
  }

  get isPlaying(): boolean {
    if (this.currentAction?.isRunning()) return true;
    if (this.fadingAction?.isRunning()) return true;
    return false;
  }

  // ── State requests ───────────────────────────────────────

  requestState(target: AnimState, bypassPriority = false): void {
    if (this._isDisposed) return;

    const dancing = this.animState === "dance";

    // Lockdown: while a dance is active, idle may only be requested explicitly
    // (stopDance() clears the flag and passes bypass). Interaction-driven idle
    // (e.g. screen-vision IDLE emits during a screen-share dance without music)
    // must not stop the dance.
    if (target === "idle" && !bypassPriority && (this.danceRequested || dancing)) {
      this.log(`[DanceLock] Idle ignored while dancing`);
      return;
    }

    // Ambient idle requests must not cut an AI-directed emote short — the
    // one-shot returns to idle on its own when its clip finishes.
    if (target === "idle" && this.aiEmoteActive && !bypassPriority) {
      this.log(`[AiEmote] Idle ignored while AI emote active`);
      return;
    }

    if (target === "idle") {
      this.doTransition(target);
      return;
    }

    if (this.animState === target) {
      this.log(`[KeepAlive] ${STATE_LABELS[target]} extended`);
      this.stateTimer = 0;
      this.inactivityTimer = 0;
      return;
    }

    // While dancing, all other animations are frozen — only TTS talking is
    // let through to the dance-talk guard below.
    if (dancing && target !== "dance" && target !== "talking") {
      this.log(`[DanceLock] ${STATE_LABELS[target]} ignored while dancing`);
      return;
    }

    // When dance is requested, talking should not interrupt dance
    if (target === "talking" && this.animState === "dance" && this.danceRequested) {
      this.log(`[DanceTalk] TTS while dancing — staying in dance state`);
      return;
    }

    // While an AI-directed emote plays, ignore ambient talking requests so
    // the TTS-start transition doesn't instantly cancel the emote.
    if (this.aiEmoteActive && !bypassPriority && target === "talking") {
      this.log(`[AiEmote] Talking ignored while AI emote active`);
      return;
    }

    if (!bypassPriority) {
      const targetPri = STATE_PRIORITY[target];
      const currentPri = STATE_PRIORITY[this.animState];
      if (targetPri <= currentPri) {
        return;
      }
    }

    this.doTransition(target);
  }

  private doTransition(target: AnimState): void {
    if (target === "dance") {
      this.danceRequested = true;
      this.aiEmoteActive = false;
    } else if (target === "idle") {
      this.danceRequested = false;
    }

    this.totalTransitions++;
    this.prevAnimState = this.animState;
    this.animState = target;
    this.stateTimer = 0;
    this.inactivityTimer = 0;

    const timeout = STATE_TIMEOUTS[target];
    const timeoutStr = timeout === Infinity ? "∞" : `${timeout}s`;
    this.log(
      `[#${this.totalTransitions}] ${STATE_LABELS[this.prevAnimState!]} → ${STATE_LABELS[target]} ` +
        `(pri ${STATE_PRIORITY[target]} | timeout ${timeoutStr} | fade ${FADE_DURATION}s)`,
    );

    this.applyStateTransition(target);
  }

  // ── Transition application ──────────────────────────────

  /** States that loop a dedicated VRMA clip (not a oneshot). */
  private readonly LOOPING_VRMA_STATES: Set<AnimState> = new Set<AnimState>([
    "talking",
    "listening",
    "thinking",
  ]);

  private applyStateTransition(target: AnimState): void {
    if (target === "idle") {
      this.transitionToIdle();
      return;
    }

    if (target === "dance") {
      this.playDance();
      return;
    }

    if (ONESHOT_STATES.has(target)) {
      this.playOneShot(target);
    } else if (this.LOOPING_VRMA_STATES.has(target)) {
      this.playLoopingState(target);
    } else {
      this.transitionToIdle();
    }
  }

  private async playLoopingState(target: AnimState): Promise<void> {
    const name = VRMA_MAP[target];
    const myToken = ++this._stateToken;
    try {
      const url = resolveAnimationUrl(name);
      if (!url) throw new Error(`Unknown animation: ${name}`);
      const clip = await loadVRMAnimation(url, this.vrm);
      if (myToken !== this._stateToken || this._isDisposed) return;
      this.crossFadeToClip(clip, `${target}:${name}`, THREE.LoopRepeat, Infinity);
    } catch {
      if (this._isDisposed) return;
      this.log(`[Error] Failed to load ${name} for ${STATE_LABELS[target]} — falling back to idle`);
      this.transitionToIdle();
    }
  }

  private transitionToIdle(): void {
    this.nextDanceAction = null;
    this.nextDanceUrl = null;
    this.currentDanceMeta = null;
    this.manualEmoteActive = false;
    // An AI emote torn down before its clip ended (explicit bypass transition)
    // must still release the director, or it waits forever for a completion
    // that never comes and the action queue stalls.
    const releaseEmote = this.aiEmoteActive && this.currentAction !== null;
    const releasedFrom = this.prevAnimState;
    this.aiEmoteActive = false;
    if (this.danceAction) {
      this.danceAction.fadeOut(FADE_DURATION);
      this.fadingAction = this.danceAction;
      this.danceAction = null;
      this.currentAction = null;
      this.currentClipName = "";
    } else if (this.currentAction) {
      this.currentAction.fadeOut(FADE_DURATION);
      this.fadingAction = this.currentAction;
      this.currentAction = null;
      this.currentClipName = "";
    }
    // Idle is always running (weight may be 0 during dance); fade it back to full
    this.restoreIdleAnimation();
    if (releaseEmote) {
      this.log(`[AiEmote] Released early → ${STATE_LABELS.idle}`);
      this.events.emit("anim:complete", { from: releasedFrom ?? "gesture" });
    }
  }

  private async playOneShot(target: AnimState): Promise<void> {
    const name = VRMA_MAP[target];
    const myToken = ++this._stateToken;
    try {
      const url = resolveAnimationUrl(name);
      if (!url) throw new Error(`Unknown animation: ${name}`);
      const clip = await loadVRMAnimation(url, this.vrm);
      if (myToken !== this._stateToken || this._isDisposed) return;
      this.crossFadeToClip(clip, `${target}:${name}`);
    } catch (err) {
      if (this._isDisposed) return;
      console.warn(`[Animation] Failed to load: ${name}.vrma`);
      console.warn(`[Animation] Reason: ${err instanceof Error ? err.message : String(err)}`);
      this.log(`[Error] Failed to load ${name} for ${STATE_LABELS[target]} — falling back to idle`);
      this.requestState("idle");
    }
  }

  private crossFadeToClip(
    clip: THREE.AnimationClip,
    label: string,
    loopMode: THREE.AnimationActionLoopStyles = THREE.LoopOnce,
    repetitions = 1,
    fadeSeconds = FADE_DURATION,
  ): void {
    const prev = this.currentAction?.isRunning() ? this.currentAction : null;
    const next = this._action(clip);

    const base = prev ?? (this.idleAction?.isRunning() ? this.idleAction : null);

    // Replaying the exact same action (cached clip reused) or transitioning
    // to an alias of the base action (e.g. Listening maps to Idle).
    // Fading out the action we JUST started would immediately drop it to weight
    // 0 — the visible "loop hole" where an emote pops and vanishes.
    if (base === next) {
      this._playAction(next, loopMode, repetitions, 1);
      if (loopMode === THREE.LoopOnce) next.clampWhenFinished = true;
      next.fadeIn(fadeSeconds);

      if (next !== this.idleAction) {
        this.currentAction = next;
        this.currentClipName = label;
      } else {
        this.currentAction = null;
        this.currentClipName = "";
      }

      this.log(`[Crossfade] → ${label} (replayed, ${fadeSeconds}s fade-in)`);
      return;
    }

    // A running base layer (prev action or idle) must hold the pose while the
    // new clip fades in. fadeIn() only ramps a multiplier over the action's
    // base weight, so the new action starts at full weight 1 — calling
    // setEffectiveWeight(0) before fadeIn() would pin its effective weight
    // at 0 forever, dropping both layers to zero (bind/T-pose).
    this._playAction(next, loopMode, repetitions, 1);
    if (loopMode === THREE.LoopOnce) next.clampWhenFinished = true;
    next.fadeIn(fadeSeconds);

    if (base) {
      base.fadeOut(fadeSeconds);
      if (base !== this.idleAction) {
        this.fadingAction = base;
      }
    }

    this.currentAction = next;
    this.currentClipName = label;
    this.log(`[Crossfade] → ${label} (${fadeSeconds}s)`);
  }

  // ── Dance state ──────────────────────────────────────────

  /**
   * Random start point within a looping clip (10%–90% of its duration), so
   * successive dances never begin from the same frame and live swaps don't
   * line up in sync — reads as organic behavior.
   */
  private randomDancePhase(duration: number): number {
    return duration * (0.1 + Math.random() * 0.8);
  }

  /**
   * Intro (0.2s) for a dance action. The running base layer (previous dance,
   * or idle) KEEPS its weight while the new dance fades in from 0 — dropping
   * both layers to zero even for one frame throws the skeleton back to its
   * bind/T-pose. Idle is parked at weight 0 only after the dance owns it.
   */
  private startDanceAction(next: THREE.AnimationAction): void {
    const runningPrev =
      this.currentAction?.isRunning() && this.currentAction !== next
        ? this.currentAction
        : this.danceAction?.isRunning() && this.danceAction !== next
          ? this.danceAction
          : null;
    const base = runningPrev ?? (this.idleAction?.isRunning() ? this.idleAction : null);

    const fade = 0.2;
    // Full weight 1 — fadeIn() multiplies this by its ramp (0→1), starting
    // it at 0 would keep the effective weight at 0 and throw the body back
    // to bind/T-pose once the base layer fades out below it.
    this._playAction(next, THREE.LoopRepeat, Infinity, 1);
    next.fadeIn(fade);
    next.time = this.randomDancePhase(next.getClip().duration);

    if (base) {
      base.fadeOut(fade);
      if (base !== this.idleAction) {
        this.fadingAction = base;
      }
    }

    window.setTimeout(
      () => {
        if (this.idleAction && this.danceAction === next) {
          this.idleAction.setEffectiveWeight(0);
        }
      },
      fade * 1000 + 120,
    );
  }

  /**
   * Idle is the persistent base layer. Its time MUST stay continuous —
   * calling reset() here snaps the whole body back to the clip's first
   * keyframe every time a one-shot finishes, which reads as a visible pop.
   */
  private restoreIdleAnimation(): void {
    if (!this.idleAction) return;
    if (this.idleAction.isRunning()) {
      this.idleAction.enabled = true;
      this.idleAction.setEffectiveWeight(1);
      this.idleAction.fadeIn(FADE_DURATION);
    } else {
      this._playAction(this.idleAction, THREE.LoopRepeat, Infinity, 1);
      this.idleAction.fadeIn(FADE_DURATION);
    }
    this.log("[Idle] Restored idle animation");
  }

  setDancePool(urls: string[]): void {
    if (this._isDisposed) return;
    this.dancePool = urls;
    if (urls.length > 0 && this.danceRequested) {
      this.preloadNextDance();
    }
  }

  setDanceDirector(director: DanceDirector | null): void {
    this.director = director;
    if (director && this.danceRequested) {
      this.preloadNextDance();
    }
  }

  setAudioFeaturesSource(fn: () => AudioAnalysisSnapshot | null): void {
    this.getAudioFeatures = fn;
  }

  get currentDanceName(): string | null {
    return this.currentDanceMeta?.name ?? null;
  }

  async playDance(): Promise<void> {
    if (this._isDisposed) return;

    const directorActive = this.director?.isActive() ?? false;
    if (!this.aiDanceUrl && !directorActive && this.dancePool.length === 0) {
      this.log("[Dance] No clips in dance pool — staying on idle");
      return;
    }

    await this.idleReady;
    if (this._isDisposed) return;

    // Choose the next dance: locked AI dance > director (smart) > random pool
    let url: string | null = null;
    let nextMeta: DanceMetadata | null = null;
    if (this.aiDanceUrl) {
      url = this.aiDanceUrl;
      nextMeta = this.director?.getByUrl(url) ?? null;
    } else if (directorActive && this.director) {
      nextMeta = this.director.selectNext(this.currentDanceMeta);
      url = nextMeta.url;
    } else if (this.dancePool.length > 0) {
      url = this.dancePool[Math.floor(Math.random() * this.dancePool.length)];
    }
    if (!url) return;

    // Discard a stale pre-loaded action if the director changed its mind
    if (this.nextDanceAction && this.nextDanceUrl !== url) {
      this.nextDanceAction.stop();
      this.nextDanceAction = null;
      this.nextDanceUrl = null;
    }

    // Use pre-loaded action immediately — crossfade for zero T-pose gap
    if (this.nextDanceAction && this.nextDanceUrl === url) {
      const next = this.nextDanceAction;
      this.nextDanceAction = null;
      this.nextDanceUrl = null;
      this.startDanceAction(next);
      if (!next.isRunning() || next.getClip().tracks.length === 0) {
        this.log("[Dance] Pre-loaded clip invalid — restoring idle");
        this.restoreIdleAnimation();
        return;
      }
      this.currentAction = next;
      this.danceAction = next;
      this.currentClipName = `dance:${url}`;
      this.danceTimer = 0;
      this.danceDuration = 10 + Math.random() * 20;
      this.currentDanceMeta = nextMeta;
      this.director?.onDanceStarted(nextMeta);
      this.log(`[Dance] → pre-loaded clip "${this.currentDanceMeta?.name ?? url}"`);
      this.preloadNextDance();
      return;
    }

    const myToken = ++this._stateToken;

    try {
      const clip = await loadVRMAnimation(url, this.vrm, { lockRootMotion: true });
      if (myToken !== this._stateToken || this._isDisposed) return;

      if (clip.tracks.length === 0) {
        throw new Error(`Dance clip has no tracks: ${url}`);
      }

      // startDanceAction keeps idle (or the previous dance) at weight until
      // this clip has faded in — no bind/T-pose gap, no hard pop.
      const next = this._action(clip);
      this.startDanceAction(next);

      if (!next.isRunning()) {
        throw new Error(`Dance action failed to start: ${url}`);
      }

      this.log(`[Dance] Clip loaded: "${clip.name}" | tracks: ${clip.tracks.length}`);

      this.currentAction = next;
      this.danceAction = next;
      this.currentClipName = `dance:${url}`;
      this.danceTimer = 0;
      this.danceDuration = Math.max(5, clip.duration * (0.8 + Math.random() * 0.6));
      this.currentDanceMeta = nextMeta;
      this.director?.onDanceStarted(nextMeta);
      this.log(`[Dance] → ${url} for ${this.danceDuration.toFixed(1)}s`);
      this.preloadNextDance();
    } catch {
      this.log(`[Dance] Failed to load: ${url}`);
      this.danceAction = null;
      this.currentAction = null;
      this.currentClipName = "";
      this.currentDanceMeta = null;
      this.restoreIdleAnimation();
    }
  }

  private async preloadNextDance(): Promise<void> {
    if (this._isDisposed) return;
    if (this.aiDanceUrl) return;

    const directorActive = this.director?.isActive() ?? false;
    if (!directorActive && (this.dancePool.length === 0 || !this.danceRequested)) return;

    let url: string | null = null;
    if (directorActive && this.director) {
      url = this.director.peekNext(this.currentDanceMeta)?.url ?? null;
    } else if (this.dancePool.length > 0) {
      url = this.dancePool[Math.floor(Math.random() * this.dancePool.length)];
    }
    if (!url) return;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const clip = await loadVRMAnimation(url, this.vrm, { lockRootMotion: true });
        if (this._isDisposed || !this.danceRequested) return;
        const action = this._action(clip);
        // Never pre-load the action that is already on screen. Clips are cached
        // per URL and `_action()` returns the EXISTING action for a cached clip,
        // so a small pool (or a repeat pick) hands us the running dance — and
        // playing it at weight 0 would blank the performance mid-dance.
        if (action.isRunning() || action === this.currentAction || action === this.danceAction) {
          this.log(`[Dance] Pre-load skipped — "${clip.name}" is already on screen`);
          return;
        }
        this._playAction(action, THREE.LoopRepeat, Infinity, 0); // weight 0 = invisible until crossfade
        this.nextDanceAction = action;
        this.nextDanceUrl = url;
        this.log(`[Dance] Pre-loaded next clip: "${clip.name}" | tracks: ${clip.tracks.length}`);
        return;
      } catch {
        if (this._isDisposed) return;
        this.log(`[Dance] Pre-load attempt ${attempt + 1} failed`);
      }
    }
  }

  setDanceRequested(requested: boolean): void {
    if (this._isDisposed) return;
    this.danceRequested = requested;
  }

  /**
   * Fade the (weight-0) dance action back to full after a manual emote
   * finished playing over it. Time kept advancing on the dance clip, so
   * this resumes mid-loop — no pop.
   */
  private resumeDanceAfterEmote(): void {
    if (this.danceAction && !this._isDisposed) {
      this.danceAction.enabled = true;
      this.danceAction.setEffectiveWeight(1);
      this.danceAction.fadeIn(FADE_DURATION);
      this.currentAction = this.danceAction;
      this.currentClipName = this.currentDanceMeta ? `dance:${this.currentDanceMeta.url}` : "dance";
      this.log("[Dance] Resumed dance after manual emote");
    }
  }

  private getFallbackState(): AnimState {
    return this.danceRequested ? "dance" : "idle";
  }

  setTimeScale(scale: number): void {
    if (this._isDisposed) return;
    if (this.danceAction && this.danceAction.isRunning()) {
      this.danceAction.timeScale = Math.max(0.25, Math.min(3, scale));
    }
  }

  // ── Public animation API ─────────────────────────────────

  async playAnimation(name: VRMAAnimationName): Promise<void> {
    if (name !== "Idle") this.notifyManualEmote();
    if (name === "Idle") {
      this.requestState("idle");
      return;
    }
    const target = this.nameToState(name);
    this.requestState(target);
  }

  async playAnimationFromUrl(url: string): Promise<void> {
    if (this._isDisposed) return;
    this.notifyManualEmote();

    // Manual override: if she's mid-dance, let the user-selected animation play
    // as a one-shot over the dance; the dance resumes when it finishes.
    // Otherwise the clip needs a gesture state to own the mixer channel.
    const overDance = this.animState === "dance";
    if (overDance) {
      this.director?.manualOverride();
      this.manualEmoteActive = true;
    } else {
      this.requestState("gesture");
    }

    const myToken = ++this._stateToken;
    try {
      const clip = await loadVRMAnimation(url, this.vrm);
      if (myToken !== this._stateToken || this._isDisposed) return;
      this.crossFadeToClip(clip, url);
    } catch (err) {
      if (this._isDisposed) return;
      console.warn(`[Animation] Failed to load: ${url}`);
      console.warn(`[Animation] Reason: ${err instanceof Error ? err.message : String(err)}`);
      this.log(`[Error] Failed to load animation from URL: ${url}`);
      // A failed clip over a dance just hands control back to the dance; a
      // failed gesture must fall back to idle so she is never left frozen.
      if (overDance) this.manualEmoteActive = false;
      else this.requestState("idle");
    }
  }

  stopAnimation(): void {
    if (this._isDisposed) return;
    this.requestState("idle");
  }

  /**
   * triggerEmote — instant situational emote from the frontend or AI brain.
   * Resolves the name across all animation pools (main, dance/, new/).
   * Falls back gracefully if the animation can't be found or loaded.
   */
  async triggerEmote(emoteName: string): Promise<void> {
    if (this._isDisposed) return;
    const url = resolveAnimationUrl(emoteName);
    if (!url) {
      this.log(`[Emote] Unknown emote: "${emoteName}" — no matching .vrma found`);
      return;
    }
    this.log(`[Emote] → "${emoteName}" (${url})`);
    await this.playAnimationFromUrl(url);
  }

  // ── AI Animation Director support ───────────────────────

  /**
   * Play an AI-directed one-shot emote (registry-approved URL). Overrides the
   * current state (including talking) so the character can express a line;
   * returns to the fallback state when the clip finishes. While the emote is
   * active, ambient TTS "talking" requests are ignored.
   */
  async playAiEmote(url: string, fadeSeconds?: number): Promise<void> {
    if (this._isDisposed) return;
    if (this.animState === "dance") {
      this.log(`[AiEmote] Ignored while dancing: ${url}`);
      return;
    }
    this.requestState("gesture", true);
    const myToken = ++this._stateToken;
    try {
      const clip = await loadVRMAnimation(url, this.vrm);
      if (myToken !== this._stateToken || this._isDisposed) return;
      this.aiEmoteActive = true;
      this.crossFadeToClip(clip, `ai:${url}`, THREE.LoopOnce, 1, fadeSeconds);
    } catch (err) {
      if (this._isDisposed) return;
      this.aiEmoteActive = false;
      // A single broken .vrma must never break the animation system — log it
      // loudly (with the reason) and let the state fall back to idle.
      console.warn(`[Animation] Failed to load: ${url}`);
      console.warn(`[Animation] Reason: ${err instanceof Error ? err.message : String(err)}`);
      this.log(`[AiEmote] Failed to load: ${url}`);
    }
  }

  /** Mark the AI emote as active for a state-based intent (happy, sad, …). */
  requestAiEmoteState(state: AnimState): void {
    if (this._isDisposed) return;
    if (this.animState === "dance") {
      this.log(`[AiEmote] State "${state}" ignored while dancing`);
      return;
    }
    // Only lock for ONESHOT states — loop/state behaviors (thinking, hand_raise,
    // etc.) must not set aiEmoteActive because nothing clears it for them,
    // which would permanently block talking transitions.
    if (ONESHOT_STATES.has(state)) {
      this.aiEmoteActive = true;
    }
    this.requestState(state, true);
  }

  /**
   * Play an explicit AI-chosen dance. The dance is locked (no director/pool
   * cycling) for durationMs, then onAiDanceEnded() fires so the caller can
   * resume music dancing or return to idle.
   */
  async playAiDance(url: string, durationMs: number): Promise<void> {
    if (this._isDisposed) return;
    this.aiDanceUrl = url;
    this.aiDanceUntil = performance.now() + durationMs;
    this.danceRequested = true;
    this.log(`[AiDance] → locked "${url}" for ${(durationMs / 1000).toFixed(1)}s`);
    if (this.animState !== "dance") {
      this.requestState("dance", true);
    } else {
      await this.playDance();
    }
  }

  isAiDanceActive(): boolean {
    return this.aiDanceUrl !== null;
  }

  /** Cancel a locked AI dance (e.g. music stopped mid-dance). */
  cancelAiDance(): void {
    this.aiDanceUrl = null;
    this.aiDanceUntil = 0;
  }

  /** Manual (user) animation just triggered — highest priority. */
  notifyManualEmote(): void {
    this.manualEmoteAt = performance.now();
  }

  isManualEmoteRecent(withinMs = 4000): boolean {
    return performance.now() - this.manualEmoteAt < withinMs;
  }

  /** Current running clip label (for the debug panel). */
  get currentClipLabel(): string {
    return this.currentClipName;
  }

  private nameToState(name: VRMAAnimationName): AnimState {
    switch (name) {
      case "Happy":
        return "happy";
      case "Rejected":
        return "sad";
      case "Angry":
        return "surprised";
      case "Excited":
        return "gesture";
      default:
        return "gesture";
    }
  }

  // ── Mixer ────────────────────────────────────────────────

  getMixerUpdate(dt: number): void {
    if (this._isDisposed) return;
    this.mixer.update(Math.min(dt, 0.1));
  }

  // ── Tick (called every frame by controller) ──────────────

  tick(dt: number): void {
    if (this._isDisposed) return;
    this.stateTimer += dt;
    this.inactivityTimer += dt;

    // Feed the dance director every frame — NOT only while dancing. BPM,
    // energy tiers and song sections must keep tracking during pauses
    // (TTS replies, idle gaps), otherwise the first seconds of the next
    // dance run on stale analysis and transitions land off-music.
    if (this.director) {
      const snap = this.getAudioFeatures();
      this.director.update(
        snap?.features ?? null,
        snap?.songVersion ?? -1,
        dt,
        snap?.songDuration ?? 0,
      );
    }

    const timeout = STATE_TIMEOUTS[this.animState];

    if (
      this.animState !== "idle" &&
      timeout !== Infinity &&
      this.stateTimer >= timeout &&
      !this.aiEmoteActive
    ) {
      const fallback = this.getFallbackState();
      this.log(
        `[Timeout] ${STATE_LABELS[this.animState]} (${timeout}s elapsed) → ${STATE_LABELS[fallback]}`,
      );
      this.events.emit("anim:timeout", { from: this.animState });
      this.requestState(fallback, true);
      return;
    }

    if (this.animState === "dance") {
      // Guard: if dance action stopped unexpectedly, restart it
      if (this.danceAction && !this.danceAction.isRunning()) {
        this.log(`[Dance] Action stopped unexpectedly — restarting`);
        this._playAction(this.danceAction, THREE.LoopRepeat, Infinity, 1);
        this.danceAction.time = this.randomDancePhase(this.danceAction.getClip().duration);
      }
      // Locked AI dance: no director/pool cycling; expire after its duration.
      if (this.aiDanceUrl) {
        this.danceTimer += dt;
        if (performance.now() >= this.aiDanceUntil) {
          this.log(`[AiDance] Locked AI dance finished`);
          this.aiDanceUrl = null;
          this.aiDanceUntil = 0;
          this.onAiDanceEnded?.();
        }
        return;
      }
      this.danceTimer += dt;
      const director = this.director;
      const directorActive = director?.isActive() ?? false;
      if (directorActive) {
        // Smart mode: the director decides when to switch (musical timing)
        if (director?.shouldTransition() || this.danceTimer >= 30) {
          this.danceTimer = 0;
          this.inactivityTimer = 0;
          void this.playDance();
        }
      } else if (this.danceTimer >= this.danceDuration) {
        this.danceTimer = 0;
        this.inactivityTimer = 0;
        this.danceDuration = 10 + Math.random() * 20;
        void this.playDance();
      }
    }

    // Manual-override emote over a dance: resume the dance when it finishes
    if (this.manualEmoteActive) {
      const clipRunning = this.currentAction?.isRunning() ?? false;
      if (!clipRunning) {
        this.manualEmoteActive = false;
        this.resumeDanceAfterEmote();
      }
    }

    if (ONESHOT_STATES.has(this.animState)) {
      const clipRunning = this.currentAction?.isRunning() ?? false;
      if (this.currentAction && !clipRunning) {
        this.aiEmoteActive = false;
        this.fadingAction = null;
        const fallback = this.getFallbackState();
        this.log(
          `[Complete] One-shot ${STATE_LABELS[this.animState]} finished → ${STATE_LABELS[fallback]}`,
        );
        this.events.emit("anim:complete", { from: this.animState });
        this.requestState(fallback, true);
        return;
      }
      if (!this.currentAction) {
        this.fadingAction = null;
      }
    }

    if (
      this.animState !== "idle" &&
      this.animState !== "dance" &&
      this.inactivityTimer >= INACTIVITY_TIMEOUT &&
      !this.aiEmoteActive
    ) {
      const fallback = this.getFallbackState();
      this.log(
        `[Inactivity] ${STATE_LABELS[this.animState]} idle for ${INACTIVITY_TIMEOUT}s → ${STATE_LABELS[fallback]}`,
      );
      this.events.emit("anim:inactivity", { from: this.animState });
      this.requestState(fallback, true);
    }

    // ── Idle flavor breaks ─────────────────────────────────
    if (
      this.animState === "idle" &&
      !this.danceRequested &&
      !this.flavorActive &&
      !this.fadingAction?.isRunning() &&
      this.idleFlavorPool.length > 0
    ) {
      this.idleFlavorAccum += dt;
      if (this.idleFlavorAccum >= this.idleFlavorTimer) {
        this.idleFlavorAccum = 0;
        this.idleFlavorTimer = 15 + Math.random() * 15;
        this.triggerIdleFlavor();
      }
    }

    // Flavor break recovery: when the oneshot finishes, restore main idle
    if (this.flavorActive && this.currentAction && !this.currentAction.isRunning()) {
      this.flavorActive = false;
      this.transitionToIdle();
    }
  }

  private async triggerIdleFlavor(): Promise<void> {
    const name = this.idleFlavorPool[Math.floor(Math.random() * this.idleFlavorPool.length)];
    const url = resolveAnimationUrl(name);
    if (!url) return;
    const myToken = ++this._stateToken;
    try {
      const clip = await loadVRMAnimation(url, this.vrm);
      if (myToken !== this._stateToken || this._isDisposed) return;
      const prev = this.currentAction || this.idleAction;
      const next = this._action(clip);
      next.reset();
      next.enabled = true;
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
      next.time = 0;
      next.timeScale = 1;
      next.setEffectiveWeight(1);
      next.play();
      next.fadeIn(FADE_DURATION);
      if (prev && prev !== next) {
        prev.fadeOut(FADE_DURATION);
        this.fadingAction = prev !== this.idleAction ? prev : null;
      }
      this.currentAction = next;
      this.currentClipName = `flavor:${name}`;
      this.flavorActive = true;
      this.log(`[Flavor] → ${name}`);
    } catch {
      this.log(`[Flavor] Failed to load: ${name}`);
    }
  }

  // ── Idle clip loading ────────────────────────────────────

  private async loadIdleAnimation(): Promise<void> {
    type NamedSource =
      | { kind: "builtin"; name: VRMAAnimationName; label: string }
      | { kind: "url"; url: string; label: string };
    const sources: NamedSource[] = [
      { kind: "builtin", name: "Idle", label: "Idle" },
      { kind: "builtin", name: "DwarfIdle", label: "DwarfIdle" },
      { kind: "builtin", name: "DwarfIdle2", label: "DwarfIdle2" },
    ];
    const unarmedUrl = resolveAnimationUrl("Unarmed Idle");
    if (unarmedUrl) sources.push({ kind: "url", url: unarmedUrl, label: "Unarmed Idle" });

    for (const src of sources) {
      try {
        const clip =
          src.kind === "builtin"
            ? await loadBuiltInAnimation(src.name, this.vrm)
            : await loadVRMAnimation(src.url, this.vrm);
        if (this._isDisposed) return;
        if (!clip?.tracks.length) {
          this.log(`[Idle] ${src.label} loaded with 0 tracks — trying next fallback`);
          continue;
        }
        this.idleAction = this._action(clip);
        const weight = this.danceAction?.isRunning() ? 0 : 1;
        this._playAction(this.idleAction, THREE.LoopRepeat, Infinity, weight);
        this.log(`[Idle] VRMA "${src.label}" clip loaded (${clip.tracks.length} tracks)`);
        return;
      } catch {
        this.log(`[Idle] Failed to load ${src.label}`);
      }
    }
    if (!this._isDisposed) {
      this.log("[Idle] All VRMA idle clips unavailable — using procedural fallback");
    }
  }

  // ── Logging ──────────────────────────────────────────────

  /**
   * Transition diagnostics are invaluable while tuning, but printing every
   * state change to the browser console is not acceptable for a public
   * release. Dev builds (or a localStorage opt-in) get the full feed.
   */
  private log(msg: string): void {
    if (!import.meta.env.DEV && !this.debugLoggingEnabled()) return;
    console.log(`[ASM] ${msg}`);
  }

  private debugLoggingEnabled(): boolean {
    try {
      return window.localStorage.getItem("waifu.debug") === "1";
    } catch {
      return false;
    }
  }

  // ── Dispose ──────────────────────────────────────────────

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.mixer.removeEventListener("finished", this._onFinished);
    this.nextDanceAction = null;
    this.nextDanceUrl = null;
    this.manualEmoteActive = false;
    this.aiEmoteActive = false;
    this.aiDanceUrl = null;
    this.aiDanceUntil = 0;
    this.onAiDanceEnded = undefined;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.vrm.scene);
    clearAnimationCache();
    this.currentAction = null;
    this.idleAction = null;
    this.danceAction = null;
    this.fadingAction = null;
    this.log("[Dispose] ASM shut down");
  }
}
