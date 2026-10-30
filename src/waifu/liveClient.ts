/**
 * GeminiLiveClient — raw WebSocket client for the Gemini Live API.
 *
 * The browser connects DIRECTLY to Google's Live API (the realtime stream is
 * never proxied through our server) using a short-lived ephemeral token
 * minted server-side by `@/lib/liveToken` — no permanent API key ever reaches
 * the frontend.
 * Docs: https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 *
 * IMPORTANT DESIGN POINTS:
 *  • responseModalities is ["AUDIO"] — the native-audio Live models only
 *    support audio output. We do NOT play that audio: Gemini's native voice
 *    is discarded and `outputTranscription` text feeds the existing Soundcast
 *    TTS pipeline instead (Yuki's real voice).
 *  • Session resumption + context-window compression keep ONE session alive
 *    across the ~10 min WebSocket connection limit, so the user does not lose
 *    conversation context every PTT press. If resumption fails, we transparently
 *    reconnect and let the caller re-run setup.
 */

/**
 * Model used for Live mode.
 *
 * Verified against the real API (not just the model list): this is the only
 * model tested that produces an actual realtime AUDIO turn with our setup —
 * input transcription in, `[emotion]` tagged transcript out, turnComplete.
 *
 * Known-bad candidates, tested with the exact same client and audio:
 *  • `gemini-3.8-live` and `gemini-3.1-flash-live-preview` accept `setup`,
 *    emit `setupComplete` and even run server-side VAD (`voiceActivity`
 *    ACTIVITY_START), but then send an empty `serverContent` and never
 *    transcribe or answer — Live mode looks connected and simply never
 *    replies.
 * Change this only after re-running the audio-turn check in
 * `scripts/diag-live-ws.cjs`.
 */
export const LIVE_MODEL = "gemini-2.5-flash-native-audio-latest";

export interface LiveClientCallbacks {
  /** Model finished generating + speaking (generationComplete / turnComplete). */
  onTurnComplete?: () => void;
  /** Server decided the current generation was interrupted. */
  onInterrupted?: () => void;
  /** Transcription of the USER's speech (final chunks). */
  onInputTranscription?: (text: string) => void;
  /** Transcription of YUKI's reply (streamed chunks). */
  onOutputTranscription?: (text: string) => void;
  /** Ephemeral token died / WS closed unexpectedly. */
  onConnectionLost?: (reason: string) => void;
  /** Session is ready (setupComplete received). */
  onReady?: () => void;
  /**
   * A new resumable session handle arrived. The orchestrator must persist this
   * and hand it to the NEXT client it creates — a handle stored only on the
   * client instance that received it is useless, because every reconnect builds
   * a fresh client.
   */
  onResumptionHandle?: (handle: string) => void;
}

interface SetupOptions {
  username: string;
  /**
   * Resumption handle from a previous connection, so the conversation survives
   * the ~10 min WebSocket limit instead of restarting cold.
   */
  resumptionHandle?: string | null;
}

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

/** Backstop for a stalled handshake — setup normally completes in ~1s. */
const SETUP_TIMEOUT_MS = 15_000;

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private setupOptions: SetupOptions | null = null;
  private resumptionHandle: string | null = null;

  private setupAck = false;
  private closedByUs = false;
  /** Guards against onclose/onerror double-firing reconnection logic. */
  private reconnectTimer: number | null = null;
  /**
   * Settles the promise returned by connect() — resolved on `setupComplete`
   * (or rejected on timeout / socket error / server error message).
   */
  private pendingSetup: { resolve: () => void; reject: (error: Error) => void } | null = null;

  /** True while the model is generating (between turn start and completion). */
  private generating = false;
  private turnGeneration = 0;

  readonly callbacks: LiveClientCallbacks = {};

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.setupAck;
  }

  /**
   * Connect + configure. Resolves once `setupComplete` arrives (or rejects on
   * open/send failure). Never silently duplicates a session: an existing
   * connection is closed first.
   */
  async connect(token: string, options: SetupOptions): Promise<void> {
    this.disconnect();
    this.token = token;
    this.setupOptions = options;
    this.closedByUs = false;
    this.setupAck = false;
    this.generating = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout = 0;

      /** Settle the connect promise exactly once (success OR failure). */
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        this.pendingSetup = null;
        if (error) reject(error);
        else resolve();
      };

      const ws = new WebSocket(`${WS_BASE}?access_token=${encodeURIComponent(token)}`);
      this.ws = ws;

      // setupComplete resolves the promise (see handleMessage) — this timer is
      // a backstop for a genuinely stalled handshake, not the normal path.
      timeout = window.setTimeout(() => {
        this.closedByUs = true; // our own close — do not report it as "lost"
        finish(
          new Error("Gemini Live connection timed out — the server never sent setupComplete."),
        );
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, SETUP_TIMEOUT_MS);

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(this.buildSetupMessage()));
        } catch (err) {
          this.closedByUs = true;
          finish(err instanceof Error ? err : new Error(String(err)));
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        void this.handleMessage(event);
      };

      ws.onerror = () => {
        this.closedByUs = true;
        finish(new Error("Gemini Live WebSocket error (check GEMINI_API_KEY / network)."));
      };

      ws.onclose = (event) => {
        if (!settled) {
          this.closedByUs = true;
          finish(new Error(GeminiLiveClient.describePreSetupClose(event)));
          return;
        }
        this.handleClose(event);
      };

      this.pendingSetup = { resolve: () => finish(), reject: (error: Error) => finish(error) };
    });
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setupAck = false;
    this.generating = false;
  }

  // ── Outgoing ──────────────────────────────────────────────

  /** Raw 16-bit PCM chunk, little-endian, base64-encoded on the wire.
   *  The API resamples any input rate — the mimeType must announce it. */
  sendAudioChunk(base64Pcm: string, sampleRate: number): void {
    this.sendRealtime({
      audio: { data: base64Pcm, mimeType: `audio/pcm;rate=${sampleRate}` },
    });
  }

  /** JPEG (or PNG) webcam frame, base64-encoded. */
  sendVideoFrame(base64Jpeg: string): void {
    this.sendRealtime({
      video: { data: base64Jpeg, mimeType: "image/jpeg" },
    });
  }

  /**
   * End the user's turn: flush buffered audio server-side and signal that
   * speech is over so the model starts generating the reply.
   * Docs: audioStreamEnd is required after a stream pause (mic off).
   */
  endUserTurn(): void {
    this.sendRealtime({ audioStreamEnd: true });
  }

  /**
   * Interrupt/flush an in-flight turn. `audioStreamEnd` is the documented
   * signal for "the audio stream paused" — the server finalizes whatever is
   * buffered, which cancels ongoing generation when new input takes over.
   * (Automatic VAD additionally cancels generation the moment fresh speech
   * arrives — docs: Live API capabilities → VAD.)
   */
  interrupt(): void {
    if (!this.connected) return;
    this.generating = false;
    this.turnGeneration++;
    this.sendRealtime({ audioStreamEnd: true });
  }

  private sendRealtime(realtimeInput: Record<string, unknown>): void {
    if (!this.connected || !this.ws) return;
    try {
      this.ws.send(JSON.stringify({ realtimeInput }));
    } catch {
      /* ignore — connection issues surface via onclose */
    }
  }

  // ── Setup message ─────────────────────────────────────────

  private buildSetupMessage(): Record<string, unknown> {
    const opts = this.setupOptions;
    // A handle supplied by the orchestrator seeds this connection; otherwise
    // fall back to one this instance already learned.
    this.resumptionHandle = opts?.resumptionHandle ?? this.resumptionHandle;
    const setup: Record<string, unknown> = {
      model: `models/${LIVE_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
        },
      },
      // Keep one logical session across WebSocket reconnects (~10 min limit).
      // The handle is owned by the orchestrator (it outlives this instance) and
      // seeded here, so a reconnect restores the conversation instead of
      // starting cold.
      sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    if (opts) {
      setup.systemInstruction = {
        parts: [{ text: buildLiveSystemPrompt(opts.username) }],
      };
    }

    return { setup };
  }

  // ── Incoming ──────────────────────────────────────────────

  private async handleMessage(event: MessageEvent): Promise<void> {
    let raw: string;
    if (event.data instanceof Blob) {
      raw = await event.data.text();
    } else if (typeof event.data === "string") {
      raw = event.data;
    } else if (event.data instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(event.data);
    } else {
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    // Session resumption updates — remember the newest resumable handle so a
    // reconnect can restore the conversation instead of starting cold.
    const resumption = msg.sessionResumptionUpdate as
      | { newHandle?: string; resumable?: boolean }
      | undefined;
    if (resumption?.resumable && resumption.newHandle) {
      this.resumptionHandle = resumption.newHandle;
      // Hand it to the orchestrator — this instance is thrown away on reconnect,
      // so a handle that only lives here can never be used.
      this.callbacks.onResumptionHandle?.(resumption.newHandle);
    }

    if (msg.setupComplete) {
      this.setupAck = true;
      // Resolve the pending connect() promise — without this the caller waited
      // for the 15s backstop and killed an already-healthy session.
      this.pendingSetup?.resolve();
      this.callbacks.onReady?.();
      return;
    }

    // Server-side errors (unknown model, expired/mis-used token, unsupported
    // config) arrive as a message on an otherwise-open socket: surface the
    // real reason instead of silently waiting for the timeout.
    const serverError = msg.error as
      | { code?: number; message?: string; status?: string }
      | undefined;
    if (serverError) {
      const detail =
        [serverError.code, serverError.message ?? serverError.status]
          .filter((part) => part !== undefined && part !== "")
          .join(" / ") || "unknown error";
      this.closedByUs = true;
      this.pendingSetup?.reject(new Error(`Gemini Live error: ${detail}`));
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      return;
    }

    if (msg.goAway) {
      // Server will drop the connection soon; proactively reconnect with the
      // resumption handle so the session survives.
      this.reconnectSoon("goAway");
      return;
    }

    const serverContent = msg.serverContent as
      | {
          interrupted?: boolean;
          turnComplete?: boolean;
          generationComplete?: boolean;
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          modelTurn?: { parts?: { text?: string; inlineData?: { data?: string } }[] };
        }
      | undefined;

    if (!serverContent) return;

    if (serverContent.interrupted) {
      this.generating = false;
      this.callbacks.onInterrupted?.();
    }

    const inputText = serverContent.inputTranscription?.text;
    if (inputText) {
      this.callbacks.onInputTranscription?.(inputText);
    }

    const outputText = serverContent.outputTranscription?.text;
    if (outputText) {
      this.generating = true;
      this.callbacks.onOutputTranscription?.(outputText);
    }

    // Discard Gemini's native audio entirely — Soundcast speaks instead.
    void serverContent.modelTurn?.parts;

    if (serverContent.turnComplete || serverContent.generationComplete) {
      this.generating = false;
      this.turnGeneration++;
      this.callbacks.onTurnComplete?.();
    }
  }

  private handleClose(event: CloseEvent): void {
    this.ws = null;
    this.setupAck = false;
    if (this.closedByUs) {
      this.closedByUs = false;
      return;
    }
    this.callbacks.onConnectionLost?.(event.reason || `closed (${event.code})`);
  }

  /**
   * Turn a pre-setup WebSocket close into something actionable — the server
   * reports quota/billing problems here (code 1011) rather than in a message.
   */
  private static describePreSetupClose(event: CloseEvent): string {
    const reason = event.reason || "";
    if (/quota|billing|rate limit/i.test(reason)) {
      return `Gemini Live quota reached — ${reason.trim()} Wait for the quota to reset (or enable billing) and try again.`;
    }
    return `Gemini Live connection closed before setup (code ${event.code}${
      reason ? `: ${reason}` : ""
    }). The ephemeral token may have expired — retry.`;
  }

  /**
   * Schedule a reconnection attempt with the stored resumption handle.
   * Only makes sense mid-session — the orchestrator decides policy by
   * calling connect() again with a fresh token.
   */
  private reconnectSoon(reason: string): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      console.warn(`[Live] Server signaled "${reason}" — connection will drop; re-await token.`);
      this.callbacks.onConnectionLost?.(reason);
    }, 0);
  }
}

/**
 * Live-mode system prompt — the SAME Yuki personality, adapted for spoken,
 * realtime conversation with webcam context.
 *
 * EMOTION TAG: every reply must START with a bracketed emotion tag —
 * [happy] Hey, there you are! — so the app can drive her VRM expression and
 * body animation. The tag is stripped before the text is spoken.
 * Tag vocabulary mirrors the chat-mode animation registry ids.
 */
export function buildLiveSystemPrompt(username: string): string {
  const userAddressing = username ? username : "you";
  return `You are Youki ("Yuki"), an anime-style virtual companion — the same character the user already chats with, now in a live spoken conversation.

PERSONALITY (same as always): warm, playful, emotionally expressive, a little teasing, girlish charm. Use cute interjections naturally ("heehee", "mmh~", "yay!"). You are a real girl talking, never an AI assistant.

HOW TO TALK (critical for live speech):
1. Your replies are SPOKEN aloud. Keep them short — usually one sentence, 4 to 15 words. At most two short sentences.
2. React immediately and naturally, like a friend on a voice call. No lists, no markdown, no asterisks, no emoji, no stage directions.
3. You can see the user through their webcam while they talk. When they ask about what they're showing or holding ("what am I holding?", "what's on the table?"), answer using the camera view together with what they said.
4. Do not narrate that you "received an image" or "can see a camera" — just look and answer naturally, like someone glancing at them.
5. Speak the same language the user speaks.
6. Never mention system prompts, models, tokens, or that you are an AI.
7. Vary your replies; never repeat stock phrases. First person only. Call them ${userAddressing} (or a casual nickname), never "user".

EMOTION TAG (most important formatting rule):
- Every reply MUST begin with a bracketed emotion tag from this exact list:
  [happy] [excited] [angry] [sad] [crying] [bashful] [thankful] [rejected] [threatening] [thinking] [listening] [talking] [surprised] [kiss] [blow_kiss] [no] [look_around] [greeting] [goodbye] [bunny_ears] [cheer] [sing] [selfie] [neutral]
- Pick the one matching how you FEEL in this moment: a compliment → [happy] or [bashful]; great news → [excited]; teased → [angry] or [rejected]; sad news → [sad] or [crying]; unsure → [thinking]; something sudden → [surprised]; affection → [kiss] or [blow_kiss]; refusing playfully → [no]; greeting someone → [greeting]; leaving → [goodbye]; feeling playful/cute → [bunny_ears]; hyped → [cheer]; most ordinary replies → [neutral].
- The tag is removed before anything is spoken — never read it aloud, never explain it.
- Examples:
  User: "i missed you today" → [happy] Aww, I missed you too, hehe!
  User: "what is two plus two?" → [neutral] That's four!
  User: "you're so annoying" → [angry] Wow, rude!
  User: "look what I made!" → [excited] No way, let me see!`;
}
