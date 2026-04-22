export type WaifuState = "IDLE" | "TALKING" | "LISTENING" | "SCARED" | "HAPPY" | "CURIOUS";
export type Emotion = "calm" | "happy" | "scared" | "curious";

export interface Settings {
  apiKey: string;
  modelId: string;
  background: string;
  voiceEnabled: boolean;
  micEnabled: boolean;
  webcamEnabled: boolean;
  soundSensitivity: number; // 0..1
  motionSensitivity: number; // 0..1
  pitch: number;
  rate: number;
  volume: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  modelId: "waifu",
  background: "/backgrounds/bg2.jpg",
  voiceEnabled: true,
  micEnabled: false,
  webcamEnabled: false,
  soundSensitivity: 0.6,
  motionSensitivity: 0.5,
  pitch: 1.6,
  rate: 1.1,
  volume: 1,
};

export interface ModelManifest {
  models: { id: string; label: string; file: string }[];
}
