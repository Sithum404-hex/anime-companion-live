import type { StateManager } from "./stateManager";
import type { MicInput } from "./micInput";
import type { MotionDetect } from "./motionDetect";
import type { VoiceEngine } from "./voiceEngine";
import type { Settings } from "./types";
import type { AnimationController } from "./animation";

export class ReactionSystem {
  state: StateManager;
  mic: MicInput;
  motion: MotionDetect;
  voice: VoiceEngine;
  anim: AnimationController;
  settings: Settings;
  private idleTimer = 0;

  constructor(opts: {
    state: StateManager;
    mic: MicInput;
    motion: MotionDetect;
    voice: VoiceEngine;
    anim: AnimationController;
    settings: Settings;
  }) {
    Object.assign(this, opts);
    this.state = opts.state;
    this.mic = opts.mic;
    this.motion = opts.motion;
    this.voice = opts.voice;
    this.anim = opts.anim;
    this.settings = opts.settings;
  }

  updateSettings(s: Settings) {
    this.settings = s;
  }

  tick(dt: number) {
    // Talking takes priority — voice engine controls it
    if (this.voice.isSpeaking()) {
      this.state.setState("TALKING");
      this.idleTimer = 0;
      return;
    }

    // Mic loudness → SCARED
    if (this.settings.micEnabled && this.mic.active) {
      const lvl = this.mic.level();
      const threshold = 0.4 - this.settings.soundSensitivity * 0.3; // 0.1..0.4
      if (lvl > threshold) {
        this.state.setState("SCARED", 1500);
        this.state.setEmotion("scared");
        this.idleTimer = 0;
        return;
      }
    }

    // Webcam motion → CURIOUS + look
    if (this.settings.webcamEnabled && this.motion.active) {
      const m = this.motion.tick();
      const threshold = 0.25 - this.settings.motionSensitivity * 0.2; // 0.05..0.25
      if (m.score > threshold) {
        this.anim.setLook(-m.cx, m.cy); // mirror x for natural feel
        this.state.setState("CURIOUS", 1200);
        this.state.setEmotion("curious");
        this.idleTimer = 0;
        return;
      }
    }

    // Decay back to IDLE / calm
    this.idleTimer += dt;
    if (this.idleTimer > 1.5) {
      this.state.setState("IDLE");
      if (this.state.emotion !== "happy") this.state.setEmotion("calm");
      // soft drift gaze
      this.anim.setLook(Math.sin(performance.now() * 0.0003) * 0.4, Math.cos(performance.now() * 0.0002) * 0.2);
    }
  }
}
