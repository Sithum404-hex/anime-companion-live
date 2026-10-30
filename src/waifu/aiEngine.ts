import { generateDirectedReply } from "@/systems/aiSystem";
import type { AiEmotion, Emotion, RawAiIntent, RelationshipMode } from "@/waifu/types";

export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
  /** Epoch ms when the message was created — used to auto-expire old history. */
  ts?: number;
}

export interface AiChatResult {
  /** Cleaned natural-language reply. */
  response: string;
  /** Registry-validated animation intent (null = no animation). */
  animation: RawAiIntent | null;
}

export async function chatWithAI(
  history: ChatMsg[],
  username?: string,
  relationshipMode?: string,
): Promise<AiChatResult> {
  const userTurn = history[history.length - 1];
  const userText = userTurn?.role === "user" ? userTurn.content : "";
  return generateDirectedReply(userText, username, relationshipMode as RelationshipMode);
}

const POSITIVE = [
  "yay",
  "happy",
  "love",
  "great",
  "haha",
  "awesome",
  "cute",
  "wonderful",
  "yes!",
  "sugoi",
  "pretty",
  "beautiful",
  "amazing",
  "best",
  "sweet",
  "adore",
];
const NEGATIVE = [
  "scared",
  "sad",
  "no!",
  "afraid",
  "sorry",
  "bad",
  "hate",
  "mean",
  "stupid",
  "ugly",
  "worst",
  "terrible",
  "annoying",
];
const ROMANTIC = [
  "miss you",
  "love you",
  "love",
  "kiss",
  "hug",
  "heart",
  "sweetie",
  "baby",
  "dear",
  "darling",
  "beautiful",
  "pretty",
  "cute",
  "adorable",
  "waifu",
  "girlfriend",
];
const EXCITED = [
  "yay",
  "wow",
  "really",
  "awesome",
  "amazing",
  "cool",
  "fun",
  "play",
  "game",
  "excited",
  "happy",
];
const CURIOUS = [
  "what",
  "why",
  "how",
  "when",
  "where",
  "who",
  "tell me",
  "explain",
  "question",
  "think",
];

export function sentimentEmotion(text: string): "happy" | "scared" | "calm" {
  const low = text.toLowerCase();
  if (ROMANTIC.some((w) => low.includes(w))) return "happy";
  if (POSITIVE.some((w) => low.includes(w))) return "happy";
  if (NEGATIVE.some((w) => low.includes(w))) return "scared";
  return "calm";
}

export function getAnimationForEmotion(
  text: string,
): "idle" | "Angry" | "Excited" | "Happy" | "Rejected" | "DwarfIdle" | "DwarfIdle2" {
  const low = text.toLowerCase();

  if (ROMANTIC.some((w) => low.includes(w))) return "Happy";
  if (EXCITED.some((w) => low.includes(w))) return "Excited";
  if (CURIOUS.some((w) => low.includes(w))) return "DwarfIdle";
  if (["oh", "wow", "surprise", "unexpected"].some((w) => low.includes(w))) return "Excited";
  if (NEGATIVE.some((w) => low.includes(w))) return "Angry";

  return "idle";
}

const AI_EMOTION_TO_EXPRESSION: Record<AiEmotion, Emotion> = {
  happy: "happy",
  sad: "sad",
  angry: "scared",
  annoyed: "scared",
  embarrassed: "calm",
  excited: "happy",
  nervous: "curious",
  neutral: "calm",
};

const AI_EMOTION_TO_ANIMATION: Record<AiEmotion, string> = {
  happy: "Happy",
  sad: "Rejected",
  angry: "Angry",
  annoyed: "Angry",
  embarrassed: "Happy",
  excited: "Excited",
  nervous: "Idle",
  neutral: "idle",
};

export function mapAiEmotion(aiEmotion: AiEmotion): { expression: Emotion; animation: string } {
  return {
    expression: AI_EMOTION_TO_EXPRESSION[aiEmotion] || "calm",
    animation: AI_EMOTION_TO_ANIMATION[aiEmotion] || "idle",
  };
}
