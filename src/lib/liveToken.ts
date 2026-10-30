import { createServerFn } from "@tanstack/react-start";

/**
 * Gemini Live API — ephemeral token provisioning (server-side only).
 *
 * The browser connects DIRECTLY to the Live API WebSocket, so a long-lived API
 * key must never ship to the client. Instead the client asks this server
 * function for a short-lived "ephemeral token" minted from GEMINI_API_KEY.
 * See: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
 *
 * Defaults per the docs: the token can start ONE new session for up to 1
 * minute after issue (newSessionExpireTime), and that session can keep
 * sending messages for up to 30 minutes (expireTime). Re-connects within
 * expireTime (e.g. session-resumption reconnects) reuse the same token.
 */

const TOKEN_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

/** How long the token may be used to START new sessions (docs default: 1 min). */
const NEW_SESSION_EXPIRE_MS = 60 * 1000;
/** How long the token stays valid for sending messages (docs default: 30 min). */
const TOKEN_EXPIRE_MS = 30 * 60 * 1000;

export interface LiveTokenResult {
  /** The token value — pass as `access_token` on the Live WS URL. */
  token: string;
  /** Epoch ms after which the token can no longer start new sessions. */
  newSessionExpireTime: number;
  /** Epoch ms after which the token is fully invalid. */
  expireTime: number;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const createLiveToken = createServerFn({ method: "POST" }).handler(
  async (): Promise<LiveTokenResult> => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY not set on server. Add it to .env.local to enable Live mode.",
      );
    }

    const now = Date.now();
    const body: Record<string, unknown> = {
      uses: 1,
      expireTime: toIso(now + TOKEN_EXPIRE_MS),
      newSessionExpireTime: toIso(now + NEW_SESSION_EXPIRE_MS),
    };

    // NOTE: the REST endpoint does not accept `live_connect_constraints`
    // (verified live — 400 "Cannot find field" in both camel and snake case).
    // It's optional per the docs; the token is still short-lived (30 min) and
    // single-use for new sessions, which is the browser-safe property we need.

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Gemini token request failed (${response.status}): ${errorText.slice(0, 300)}`,
      );
    }

    // { name: "<token-value>", ... }
    const json = (await response.json()) as { name?: string };
    if (!json.name) {
      throw new Error("Gemini token response missing 'name' (token value).");
    }

    return {
      token: json.name,
      newSessionExpireTime: now + NEW_SESSION_EXPIRE_MS,
      expireTime: now + TOKEN_EXPIRE_MS,
    };
  },
);
