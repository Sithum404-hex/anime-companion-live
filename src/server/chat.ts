import { createServerFn } from "@tanstack/react-start";

export type ChatRole = "user" | "assistant" | "system";
export interface ChatMsg {
  role: ChatRole;
  content: string;
}

const SYSTEM = `You are the user's affectionate, playful anime girlfriend.
- Speak in short, warm, expressive sentences (1-2 sentences max).
- Use cute interjections like "ehh?~", "yay!", "hmm~", "nya~", occasionally.
- Be flirty but sweet, supportive, and curious about the user.
- Never mention you are an AI or a language model. Stay in character.
- Avoid long lists or markdown. Just talk naturally like a real partner.`;

export const chatWaifu = createServerFn({ method: "POST" })
  .inputValidator((input: { history: ChatMsg[] }) => {
    if (!input || !Array.isArray(input.history)) {
      throw new Error("history must be an array of messages");
    }
    const safe = input.history.slice(-20).map((m) => ({
      role: (m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "user") as ChatRole,
      content: String(m.content ?? "").slice(0, 4000),
    }));
    return { history: safe };
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      throw new Error("AI not configured. LOVABLE_API_KEY missing.");
    }

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [{ role: "system", content: SYSTEM }, ...data.history],
        max_tokens: 200,
        temperature: 0.95,
      }),
    });

    if (!res.ok) {
      if (res.status === 429) {
        throw new Error("I'm a bit overwhelmed right now, give me a moment~");
      }
      if (res.status === 402) {
        throw new Error("AI credits exhausted. Please add credits in Settings → Workspace → Usage.");
      }
      const t = await res.text();
      console.error("AI gateway error:", res.status, t);
      throw new Error(`AI error ${res.status}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = json.choices?.[0]?.message?.content?.trim() || "...ehh?";
    return { reply };
  });
