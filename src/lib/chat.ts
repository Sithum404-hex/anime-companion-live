import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { classifyApiError } from "@/config/models";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT = 12_000;

/** Normalized chat result — callers never see the raw OpenRouter envelope. */
export interface ChatCompletion {
  /** Assistant message content (empty string when the model produced nothing). */
  text: string;
  /**
   * Why generation stopped: "stop" | "length" | "content_filter" | …
   *
   * `length` with empty text is the signature of a reasoning model that spent
   * the whole `max_tokens` budget thinking — see CHAT_TOKEN_BUDGET.
   */
  finishReason: string | null;
}

/**
 * Server-side OpenRouter chat completion.
 * Errors are classified into typed ModelErrors with detailed detection of
 * upstream provider rate limits vs. OpenRouter-level rate limits.
 */
export const chat = createServerFn({ method: "POST" })
  .validator(
    z.object({
      messages: z.array(
        z.object({
          role: z.string(),
          content: z.string(),
        }),
      ),
      model: z.string().min(1),
      jsonMode: z.boolean().default(true),
      // Reasoning models need a real budget — the cap is generous on purpose so
      // a starvation retry has room to double the request without hitting the
      // validator ceiling.
      maxTokens: z.number().min(1).max(8192).default(2000),
      temperature: z.number().min(0).max(2).default(0.7),
      /** Strip the model's reasoning tokens (reasoning models leak them otherwise) */
      excludeReasoning: z.boolean().default(false),
      /** Overall request timeout in ms — callers may set lower for faster fallback */
      timeout: z.number().min(5000).max(120000).default(REQUEST_TIMEOUT),
    }),
  )
  .handler(async ({ data }): Promise<ChatCompletion> => {
    const { messages, model, jsonMode, maxTokens, temperature, timeout, excludeReasoning } = data;

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };

    if (jsonMode) {
      body.response_format = { type: "json_object" };
    }

    // Reasoning models (e.g. Nemotron 3) put their chain-of-thought in
    // message.content unless we ask OpenRouter to exclude it.
    if (excludeReasoning) {
      body.reasoning = { exclude: true };
      // Belt and suspenders: some chain-of-thought is written as plain
      // content, which `exclude` cannot reach — these models also honor an
      // inline "/no_think" switch that disables it at the prompt level. It
      // must go on the MAIN prompt (messages[0]); later system messages are
      // auxiliary notes (screen context, history summaries).
      if (messages.length > 0 && messages[0].role === "system") {
        if (!messages[0].content.includes("/no_think")) {
          messages[0] = { ...messages[0], content: `${messages[0].content} /no_think` };
        }
      }
    }

    const controller = new AbortController();
    const tId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.SITE_URL || "http://localhost:3000",
          "X-Title": "AI Anime Waifu",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[chat.ts] OpenRouter Error ${response.status}:`, errorText);
        clearTimeout(tId);
        throw classifyApiError(response.status, errorText, false);
      }

      const data = (await response.json()) as {
        choices: { message: { content: string | null }; finish_reason?: string | null }[];
      };

      clearTimeout(tId);
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        finishReason: data.choices?.[0]?.finish_reason ?? null,
      };
    } catch (err) {
      clearTimeout(tId);

      if (err instanceof DOMException && err.name === "AbortError") {
        throw classifyApiError(0, "", true);
      }

      if (err && typeof err === "object" && "code" in (err as Record<string, unknown>)) {
        throw err;
      }

      throw classifyApiError(0, `Network error: ${(err as Error).message}`, false);
    }
  });
