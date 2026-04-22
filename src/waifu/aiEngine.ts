const SYSTEM = `You're a cute anime assistant. Speak in short, expressive, playful sentences. Use emotions like 'ehh?', 'yay!', 'hmm~'. Keep replies under 2 sentences.`;

export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function chatWithAI(apiKey: string, history: ChatMsg[]): Promise<string> {
  if (!apiKey) throw new Error("Missing OpenRouter API key. Add it in Settings.");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "",
      "X-Title": "AI Anime Waifu",
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.2-3b-instruct:free",
      messages: [{ role: "system", content: SYSTEM }, ...history],
      max_tokens: 200,
      temperature: 0.9,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI error ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content as string) ?? "...ehh?";
}

const POSITIVE = ["yay", "happy", "love", "great", "haha", "awesome", "cute", "wonderful", "yes!", "sugoi"];
const NEGATIVE = ["scared", "sad", "no!", "afraid", "sorry", "bad"];

export function sentimentEmotion(text: string): "happy" | "scared" | "calm" {
  const low = text.toLowerCase();
  if (POSITIVE.some((w) => low.includes(w))) return "happy";
  if (NEGATIVE.some((w) => low.includes(w))) return "scared";
  return "calm";
}
