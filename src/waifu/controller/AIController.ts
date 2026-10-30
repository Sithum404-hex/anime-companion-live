import type { EventBus } from "./EventBus";
import { VoiceEngine, type AudioFrame } from "../voiceEngine";
import type { QualitySettings } from "../performance";

/**
 * AIController owns voice synthesis, audio analysis, and AI emotion state.
 * No other module plays audio or reads frequency data.
 */
export class AIController {
  readonly voice: VoiceEngine;

  private speaking = false;

  constructor(bus: EventBus, quality: QualitySettings) {
    this.voice = new VoiceEngine();

    if (quality.tier === "low") {
      this.voice.setFftSize(quality.fftSize);
    }
  }

  /** Speak text via TTS with emotion-driven prosody. Returns when speech finishes. */
  async speak(text: string, volume: number, emotion?: string): Promise<void> {
    if (!text) return;
    this.speaking = true;
    try {
      await this.voice.speak(text, {
        pitch: 1.0,
        rate: 1.0,
        volume,
        emotion,
      });
    } finally {
      this.speaking = false;
    }
  }

  cancelSpeech(): void {
    this.voice.cancel();
    this.speaking = false;
  }

  isSpeaking(): boolean {
    return this.speaking || this.voice.isSpeaking();
  }

  /** Get the current audio frame for lip-sync. */
  getAudioFrame(): AudioFrame {
    return this.voice.getAudioFrame();
  }

  dispose(): void {
    this.voice.cancel();
  }
}
