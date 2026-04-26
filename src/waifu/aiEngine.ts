import { chatWaifu } from "@/server/chat";

export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function chatWithAI(history: ChatMsg[]): Promise<string> {
  const res = await chatWaifu({ data: { history } });
  return res.reply;
}

const POSITIVE = ["yay", "happy", "love", "great", "haha", "awesome", "cute", "wonderful", "yes!", "sugoi", "miss you", "darling", "sweet"];
const NEGATIVE = ["scared", "sad", "no!", "afraid", "sorry", "bad", "lonely"];

export function sentimentEmotion(text: string): "happy" | "scared" | "calm" {
  const low = text.toLowerCase();
  if (POSITIVE.some((w) => low.includes(w))) return "happy";
  if (NEGATIVE.some((w) => low.includes(w))) return "scared";
  return "calm";
}
