import { detectQualityTier } from "./performance";
import type { FpsCap } from "./performance";

export type WaifuState =
  | "IDLE"
  | "TALKING"
  | "LISTENING"
  | "SCARED"
  | "HAPPY"
  | "SAD"
  | "CURIOUS"
  | "SURPRISED"
  | "DANCING";
export type Emotion = "calm" | "happy" | "scared" | "curious" | "sad" | "surprised";

export type QualityTier = "low" | "medium" | "high";
export type PersonalityMode = "neutral" | "friendly" | "close";
export type RelationshipMode = "natural" | "closeFriend" | "crush";
export type DanceIntensityPref = "low" | "normal" | "high" | "auto";

export type AiEmotion =
  | "happy"
  | "sad"
  | "angry"
  | "annoyed"
  | "embarrassed"
  | "excited"
  | "nervous"
  | "neutral";

export interface AiState {
  emotion: AiEmotion;
  friendship: number;
  trust: number;
  respect: number;
  moodHistory?: AiEmotion[];
}

export interface AiResponse {
  segments: string[];
  state: AiState | null;
  /** Structured animation intent emitted by the AI (validated downstream). */
  animation?: RawAiIntent | null;
}

/** Raw animation decision from the AI — action must be registry-approved. */
export interface RawAiIntent {
  action: string;
  /** Preferred 0..1 confidence used by the behavior utility scorer. */
  confidence?: number;
  /** Backward-compatible alias emitted by older model prompts. */
  intensity?: number;
  /** Optional descriptor tags (e.g. pose mood: "cute", "angry", "sad"). */
  tags?: string[];
}

export interface Settings {
  danceCameraEnabled: boolean;
  modelId: string;
  outfitId: string;
  background: string;
  voiceEnabled: boolean;
  micEnabled: boolean;
  webcamEnabled: boolean;
  screenVisionEnabled: boolean;
  screenVisionDanceEnabled: boolean;
  autoAnalyzeScreen: boolean;
  screenAnalysisInterval: number;
  personality: PersonalityMode;
  relationshipMode: RelationshipMode;
  soundSensitivity: number; // 0..1
  motionSensitivity: number; // 0..1
  pitch: number;
  rate: number;
  volume: number;
  qualityTier: QualityTier;
  /** Frame-rate ceiling. Max Performance overrides it when enabled. */
  fpsCap: FpsCap;
  /** When enabled, overrides the FPS cap to maximize smoothness regardless of user selection. */
  maxPerfMode: boolean;
  musicPlayerEnabled: boolean;
  /**
   * All music-reactive visuals: the music-player spectrum + glow (Visualizer
   * v1) and the 3D beat floor rings around her feet. One switch, because both
   * answer the same question — "do I want the music to be visible?".
   */
  visualizersEnabled: boolean;
  /** Visualizer style: controls the appearance of the reactive particle burst and floor rings. */
  visualizerStyle: "default" | "subtle" | "energetic";
  /** Intelligent dance sync master switch. */
  danceSyncEnabled: boolean;
  /** Preferred dance intensity filter. */
  danceIntensity: DanceIntensityPref;
  /**
   * Haptic feedback on supported mobile devices (poke tick + subtle beat
   * pulse). Pure output feedback — never gates or drives animation state.
   */
  hapticsEnabled: boolean;
  /** Show the BPM/energy/beat debug overlay. */
  showMusicAnalysis: boolean;
  /** Show the AI Animation Director debug overlay. */
  showAiAnimationDebug: boolean;
  /** Hold shortcut key to speak a voice command (mic only active while held). */
  pushToTalkEnabled: boolean;
  /** KeyboardEvent.code value, e.g. "Space", "KeyV". */
  pushToTalkKey: string;
}

export const DEFAULT_SETTINGS: Settings = {
  modelId: "waifu",
  outfitId: "yuki_casual",
  background: "/backgrounds/bg2.jpg",
  voiceEnabled: true,
  micEnabled: false,
  webcamEnabled: false,
  screenVisionEnabled: false,
  screenVisionDanceEnabled: false,
  autoAnalyzeScreen: true,
  screenAnalysisInterval: 15,
  personality: "friendly",
  relationshipMode: "natural",
  soundSensitivity: 0.6,
  motionSensitivity: 0.5,
  pitch: 1.0,
  rate: 1.0,
  volume: 1,
  qualityTier: detectQualityTier(),
  // "uncapped" preserves the pre-existing behaviour exactly, so enabling this
  // feature changes nothing for anyone who never touches the setting.
  fpsCap: "uncapped",
  // Max Performance overrides FPS cap when enabled.
  maxPerfMode: false,
  musicPlayerEnabled: false,
  // Default visualizer style is "default" for backward compatibility.
  visualizerStyle: "default",
  visualizersEnabled: true,
  danceSyncEnabled: true,
  danceIntensity: "auto",
  // On by default so the already-shipped poke tick is unchanged for anyone
  // who never opens Settings; the beat pulse rides along with it.
  hapticsEnabled: true,
  showMusicAnalysis: false,
  showAiAnimationDebug: false,
  pushToTalkEnabled: true,
  pushToTalkKey: "Space",

  /**
   * Dance camera: when enabled and a dance is actually playing, the camera
   * smoothly follows and cinematically frames the character with restrained sway,
   * rotation, zoom breathing and beat-aware shake, then returns to normal on
   * exit.
   */
  danceCameraEnabled: true,
};

export interface ModelManifest {
  models: { id: string; label: string; file: string }[];
}

export interface OutfitEntry {
  id: string;
  label: string;
  file: string;
  preview: string | null;
}

export interface WardrobeManifest {
  characterId: string;
  characterLabel: string;
  defaultOutfit: string;
  outfits: OutfitEntry[];
}
