import type { WaifuState, Emotion, Settings } from "../types";

/** Abstract interface for sensor data — keeps InteractionManager decoupled from concrete input/AI modules. */
export interface InteractionInputs {
  isSpeaking: () => boolean;
  micActive: () => boolean;
  micLevel: () => number;
  motionActive: () => boolean;
  readMotion: () => { x: number; y: number; score: number } | null;
  isMusicPlaying: () => boolean;
}

export class InteractionManager {
  state: WaifuState = "IDLE";
  emotion: Emotion = "calm";
  motionLookX = 0;
  motionLookY = 0;
  private settings: Settings;
  private idleTimer = 0;
  private lockedUntil = 0;
  private lastTime = 0;
  private timeRefreshInterval = 0;
  private scaredCooldownUntil = 0;
  private listeners: Array<(s: WaifuState, e: Emotion) => void> = [];

  constructor(
    private inputs: InteractionInputs,
    settings: Settings,
  ) {
    this.settings = settings;
  }

  onStateChange(fn: (s: WaifuState, e: Emotion) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private getTime(): number {
    this.timeRefreshInterval++;
    if (this.timeRefreshInterval > 10) {
      this.lastTime = performance.now();
      this.timeRefreshInterval = 0;
    }
    return this.lastTime;
  }

  setState(s: WaifuState, holdMs = 0): void {
    if (this.listeners.length === 0) {
      this.state = s;
      this.lockedUntil = holdMs > 0 ? this.getTime() + holdMs : 0;
      return;
    }
    if (this.getTime() < this.lockedUntil && s !== this.state) return;
    if (s === this.state) return;
    this.state = s;
    this.lockedUntil = holdMs > 0 ? this.getTime() + holdMs : 0;
    this.emit();
  }

  setEmotion(e: Emotion): void {
    if (e === this.emotion) return;
    this.emotion = e;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state, this.emotion);
  }

  updateSettings(s: Settings): void {
    this.settings = s;
  }

  tick(dt: number): void {
    // 1. Music has top priority
    if (this.inputs.isMusicPlaying()) {
      this.setState("DANCING");
      this.idleTimer = 0;
      return;
    }

    // 2. Speaking (TTS)
    if (this.inputs.isSpeaking()) {
      this.setState("TALKING");
      this.idleTimer = 0;
      return;
    }

    // 3. Webcam face tracking — works even during screen vision
    if (this.settings.webcamEnabled && this.inputs.motionActive()) {
      const m = this.inputs.readMotion();
      if (m && m.score > 0.05) {
        const threshold = 0.12 - this.settings.motionSensitivity * 0.08;
        if (m.score > threshold) {
          this.motionLookX = m.x;
          this.motionLookY = m.y;
          this.setState("CURIOUS", 1200);
          this.setEmotion("curious");
          this.idleTimer = 0;
          return;
        }
      }
    }

    // 4. Mic loudness reactions — disabled during screen vision (separate stream)
    //    Speech sits around 0.02–0.12 RMS; the old 0.22–0.4 gate never fired.
    if (!this.settings.screenVisionEnabled && this.settings.micEnabled && this.inputs.micActive()) {
      const lvl = this.inputs.micLevel();
      const threshold = 0.16 - this.settings.soundSensitivity * 0.12;
      const now = this.getTime();
      if (lvl > threshold && now >= this.scaredCooldownUntil) {
        this.scaredCooldownUntil = now + 2500;
        this.setState("SCARED", 1500);
        this.setEmotion("scared");
        this.idleTimer = 0;
        return;
      }
    }

    // 5. Screen vision keeps a calm idle when no other sensor fired
    if (this.settings.screenVisionEnabled) {
      this.setState("IDLE");
      if (this.emotion !== "calm") this.setEmotion("calm");
      return;
    }

    this.idleTimer += dt;
    if (this.idleTimer > 3) {
      this.setState("IDLE");
      if (this.emotion !== "happy") this.setEmotion("calm");
    }
  }

  resetIdleTimer(): void {
    this.idleTimer = 0;
  }

  dispose(): void {
    this.listeners = [];
  }
}
