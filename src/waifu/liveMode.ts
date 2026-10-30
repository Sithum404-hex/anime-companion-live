/**
 * LiveModeController — orchestrator for the LIVE mode.
 *
 * Pipeline:  PTT hold → mic (16 kHz PCM) + webcam (1 fps JPEG) → Gemini Live
 *            → output transcription (text) → EXISTING VoiceEngine (Soundcast
 *            TTS) → EXISTING lip-sync/animation via WaifuHandle callbacks.
 *
 * Data-saving rules (hard requirements):
 *  • PTT NOT held → no mic, no webcam, nothing sent.
 *  • PTT pressed  → camera on, one frame sent immediately.
 *  • While held   → ~1 resized/compressed frame per second (skipping
 *                   near-identical scenes).
 *  • PTT released → capture stops, frame timer stops, ALL media tracks stop
 *                   (camera light goes off between turns).
 *
 * Media lifecycle is strictly PTT-scoped: streams are re-acquired per press
 * (cheap after the first grant) and always released on release/cancel so no
 * MediaStream leaks and the browser camera indicator matches reality.
 */

import { GeminiLiveClient, LIVE_MODEL, buildLiveSystemPrompt } from "./liveClient";
import { createLiveToken } from "@/lib/liveToken";
import { validateAiIntent } from "./animationRegistry";
import type { AiEmotion, RawAiIntent } from "./types";
// ── Tunables ──────────────────────────────────────────────

/** Capture resolution — the API accepts arbitrary frame sizes; 640×360 is plenty. */
const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 360;
const FRAME_INTERVAL_MS = 1000; // ~1 fps while PTT is held
const JPEG_QUALITY = 0.6;

/**
 * ScriptProcessor window. MUST be 0 or a power of two in [256, 16384] — the
 * Web Audio API rejects anything else (which silently made the mic dead).
 * 2048 samples @ 48 kHz ≈ 43 ms of audio per chunk.
 */
const MIC_BUFFER_SIZE = 2048;

/**
 * Gemini Live requires 16-bit little-endian mono PCM at 16 kHz for input.
 * Browsers hand us whatever the device runs at (usually 48 kHz), so the
 * capture rate is always downsampled to this before it goes on the wire.
 */
const TARGET_SAMPLE_RATE = 16_000;

/** Scene-change check: fraction of sampled pixels that must differ to resend. */
const SCENE_DIFF_THRESHOLD = 0.01;
const SCENE_DIFF_PIXEL_STEP = 40; // sample every Nth pixel (lightweight)
const SCENE_DIFF_CHANNEL_TOLERANCE = 12;

export type LiveState = "IDLE" | "LISTENING" | "PROCESSING" | "SPEAKING" | "ERROR";

export interface LiveStatus {
  state: LiveState;
  /** Gemini session ready (setupComplete received). */
  connected: boolean;
  /** True while a background auto-reconnect is scheduled/in progress. */
  reconnecting: boolean;
  /** User transcript for the current/last turn. */
  userTranscript: string;
  /** Yuki's current/last reply text (the Soundcast TTS input). */
  reply: string;
  /** Emotion tag parsed from the latest reply (drives expression + animation). */
  emotion: string | null;
  /** True while the webcam is actually captured AND frames are being sent. */
  cameraActive: boolean;
  error: string | null;
  model: string;
}

interface LiveModeDeps {
  /** Display name used in the system prompt (same character, same user). */
  username: string;
  /** Called whenever status changes (state, transcript, reply, camera…). */
  onStatus: (status: LiveStatus) => void;
  /**
   * Speak a reply through the EXISTING Soundcast pipeline.
   * Resolves when playback finishes; rejects when cancelled/failed.
   */
  speak: (text: string, emotion: string) => Promise<void>;
  /**
   * Kick off Soundcast synthesis early for a sentence that is still queued
   * behind a playing one (reuses the existing TTS audio cache). Optional.
   */
  prefetch?: (text: string, emotion: string) => void;
  /** Immediately stop current Soundcast playback + speaking animation (PTT interruption). */
  cancelSpeech: () => void;
  /** Character reactions from the existing VRM controller. */
  onListeningChange: (active: boolean) => void;
  onUserMessage: () => void;
  onAIResponse: (emotion: string) => void;
  /**
   * Body animation from the [emotion] tag — routed through the character's
   * AI Animation Director (already registry-validates the intent again).
   */
  onAnimationIntent?: (intent: { action: string; confidence: number }) => void;
}

export class LiveModeController {
  private client: GeminiLiveClient | null = null;
  private deps: LiveModeDeps;

  private micStream: MediaStream | null = null;
  private micAudioCtx: AudioContext | null = null;
  private micProcessor: ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  /** In-flight startMic() — kept so a second press can't double-open the mic. */
  private micPending: Promise<void> | null = null;

  private camStream: MediaStream | null = null;
  private camVideo: HTMLVideoElement | null = null;
  private frameCanvas: HTMLCanvasElement | null = null;
  private frameCtx: CanvasRenderingContext2D | null = null;
  private frameTimer: number | null = null;
  private lastFrameData: ImageData | null = null;

  private status: LiveStatus = {
    state: "IDLE",
    connected: false,
    reconnecting: false,
    userTranscript: "",
    reply: "",
    emotion: null,
    cameraActive: false,
    error: null,
    model: LIVE_MODEL,
  };

  private pttHeld = false;
  private connecting: Promise<void> | null = null;
  private disposed = false;
  /** True while the user is inside Live mode (gates background reconnect). */
  private inLiveMode = false;
  private lastEmotion = "happy";
  private userTranscriptParts: string[] = [];
  /** Emotion resolved from the current reply's leading [emotion] tag. */
  private currentEmotion: string | null = null;

  // ── Sentence-level speech queue ────────────────────────
  // Reply text is synthesized and spoken one sentence at a time: she starts
  // talking as soon as the FIRST sentence arrives instead of waiting for the
  // whole reply, while the sentences still play strictly in order.
  /** Sentences waiting to be synthesized + spoken, in order. */
  private queue: string[] = [];
  /** Reply text received since the last sentence boundary. */
  private sentenceBuffer = "";
  /** True while a queued sentence is playing (the queue's single consumer). */
  private speaking = false;
  /**
   * Bumped by resetSpeechQueue(). An in-flight consumer compares the value it
   * captured before recursing, so a cancelled playback can never resume the
   * *previous* reply's remaining sentences.
   */
  private speechGen = 0;

  /** Set once Gemini signals the reply turn is complete. */
  private turnDone = false;
  /**
   * Streaming replies may split the leading emotion tag across chunks, so the
   * first few characters are buffered until the tag can be resolved (or ruled
   * out) before anything is spoken.
   */
  private pendingPrefix = "";
  private emotionResolved = false;

  /**
   * Fires when a finished turn produced NO model output at all (silence, no
   * speech detected, dropped input) — without it the UI would sit on
   * "Thinking…" forever, because a non-turn gets no turnComplete.
   */
  private turnWatchdog: number | null = null;
  private static readonly TURN_WATCHDOG_MS = 15_000;

  // ── Background auto-reconnect ──────────────────────────
  // If the WebSocket drops (server ~10 min connection limit, network blip,
  // expired token), reconnect automatically in the background with
  // exponential backoff instead of waiting for the next PTT press.
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private static readonly RECONNECT_BASE_MS = 1_000;
  private static readonly RECONNECT_MAX_MS = 15_000;

  /**
   * Gemini session-resumption handle, owned HERE rather than on the client.
   *
   * ensureSession() builds a brand-new GeminiLiveClient for every connect, so a
   * handle stored only on the client died with it and session resumption never
   * actually happened — every reconnect (the ~10 min WebSocket limit, a network
   * blip, an expired token) silently restarted the conversation from nothing.
   */
  private resumptionHandle: string | null = null;

  /**
   * PCM captured while the Gemini handshake was still in flight, as base64.
   *
   * The mic MUST open before connecting — browsers gate AudioContext.resume on
   * transient user activation, so waiting for the socket leaves the context
   * suspended and captures nothing at all. The cost of that ordering is that
   * ~1–2 s of speech is recorded before there is anywhere to send it, and it
   * used to be silently dropped. That made Gemini reliably miss the START of
   * every sentence (measured: "…strawberry milk. Do you want some?" arriving as
   * just "milk. Do you want some?"), so users had to hold PTT longer purely to
   * be heard. The chunks are buffered here and flushed, in order, the moment the
   * session reports ready.
   */
  private audioPreRoll: string[] = [];
  /** ~4 s of audio at 2048 samples / 43 ms — bounded so a stalled connect is cheap. */
  private static readonly PRE_ROLL_MAX_CHUNKS = 96;

  constructor(deps: LiveModeDeps) {
    this.deps = deps;
  }

  // ── Status plumbing ───────────────────────────────────────

  getStatus(): LiveStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<LiveStatus>): void {
    if (this.disposed) return;
    this.status = { ...this.status, ...patch };
    this.deps.onStatus(this.getStatus());
  }

  // ── Session lifecycle ─────────────────────────────────────

  /** Ensure exactly one configured Gemini session exists (idempotent). */
  private ensureSession(): Promise<void> {
    if (this.client?.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    // A user-initiated connect preempts any pending background retry.
    this.clearReconnectTimer();

    const run = async (): Promise<void> => {
      // A background reconnect while idle must not flash "Thinking…" — only
      // user-driven connects (PTT press / turn finish) claim PROCESSING.
      const background = !this.pttHeld && this.status.reconnecting;
      this.setStatus({
        state: this.pttHeld ? "LISTENING" : background ? "IDLE" : "PROCESSING",
        error: null,
      });

      // Fresh token per connect — tokens are single-use for NEW sessions
      // (docs default `uses: 1`) but reusable for resumption reconnects
      // within their 30-minute expiry.
      const { token } = await createLiveToken();

      const client = new GeminiLiveClient();
      // Handles can arrive before we adopt the client (during the handshake), so
      // stage them locally and commit only once this client is the live one.
      let pendingHandle: string | null = null;
      client.callbacks.onResumptionHandle = (handle) => {
        pendingHandle = handle;
        if (this.client === client) this.resumptionHandle = handle;
      };
      client.callbacks.onReady = () => {
        if (this.client === client) {
          // A (re)connected session has no image context — clear the frame
          // diff baseline so the next PTT tick re-sends a frame immediately.
          this.lastFrameData = null;
          this.setStatus({
            connected: true,
            reconnecting: false,
            state: this.pttHeld ? "LISTENING" : "IDLE",
            error: null,
          });
        }
      };
      client.callbacks.onInputTranscription = (text) => {
        this.userTranscriptParts.push(text);
        this.setStatus({ userTranscript: this.userTranscriptParts.join("").trim() });
      };
      client.callbacks.onOutputTranscription = (text) => this.onReplyChunk(text);
      client.callbacks.onTurnComplete = () => this.onTurnComplete();
      client.callbacks.onInterrupted = () => {
        this.clearTurnWatchdog();
        this.pendingPrefix = "";
        this.emotionResolved = false;
        this.setStatus({ state: this.pttHeld ? "LISTENING" : "IDLE" });
      };
      client.callbacks.onConnectionLost = (reason) => {
        console.warn("[Live] connection lost:", reason);
        if (this.client === client) {
          this.client = null;
          this.connecting = null;
          this.scheduleReconnect();
        }
      };

      await client.connect(token, {
        username: this.deps.username,
        resumptionHandle: this.resumptionHandle,
      });

      // Accept the new client only if nothing replaced us meanwhile.
      if (!this.disposed && !this.client) {
        this.client = client;
        if (pendingHandle) this.resumptionHandle = pendingHandle;
        this.reconnectAttempts = 0;
        this.setStatus({ reconnecting: false });
      } else {
        client.disconnect();
      }
    };

    // The finally-block references `p` before assignment completes, which is
    // safe at runtime (the async body runs after the executor returns) but
    // needs a definite-assignment assertion for TypeScript.
    const p = Promise.resolve()
      .then(run)
      .finally(() => {
        if (this.connecting === p) this.connecting = null;
      });
    this.connecting = p;
    return p;
  }

  // ── Background auto-reconnect ─────────────────────────────
  /**
   * Schedule a background reconnect with exponential backoff (1s → 2s → 4s …
   * capped at 15s). Only runs while the user stays in Live mode — exit and
   * dispose cancel it. The retry itself goes through ensureSession(), so the
   * same single-session, fresh-token path as a PTT press is reused.
   */
  private scheduleReconnect(): void {
    if (this.disposed || !this.inLiveMode) return;
    if (this.connecting) return; // an attempt is already in flight
    if (this.reconnectTimer !== null) return; // already scheduled

    const attempt = ++this.reconnectAttempts;
    const delay = Math.min(
      LiveModeController.RECONNECT_BASE_MS * 2 ** (attempt - 1),
      LiveModeController.RECONNECT_MAX_MS,
    );
    console.warn(`[Live] scheduling background reconnect #${attempt} in ${Math.round(delay)}ms`);
    this.setStatus({ connected: false, reconnecting: true });

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureSession().catch((err) => {
        console.warn("[Live] background reconnect failed:", err);
        this.scheduleReconnect(); // backoff continues from the next attempt
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Emotion tag handling ─────────────────────────────────

  /**
   * Apply a reply's [emotion] tag: neutral is display-only; anything else
   * plays her VRM body animation through the SAME registry-validated path
   * chat mode uses (CharacterBehaviorEngine → AnimationStateMachine).
   */
  private handleEmotionTag(emotion: string): void {
    this.currentEmotion = emotion;
    this.setStatus({ emotion });

    if (emotion === "neutral" || emotion === "talking") return;

    const intent: RawAiIntent = { action: emotion, confidence: 0.7 };
    const valid = validateAiIntent(intent);
    if (valid) {
      // Validated against the animation registry, then passed to the
      // character's existing AI Animation Director.
      this.deps.onAnimationIntent?.({ action: valid.id, confidence: valid.intensity });
    } else {
      // Unknown tag (model drift) — fall back to a plain expression only.
      this.deps.onAIResponse("nervous");
    }
  }

  /** Tear the Gemini session down (used by exit/dispose). */
  disconnectSession(): void {
    this.client?.disconnect();
    this.client = null;
    this.connecting = null;
    // The handle belongs to the session we just dropped — keeping it would make
    // the next session try to resume a conversation that no longer exists.
    this.resumptionHandle = null;
    this.setStatus({ connected: false });
  }

  /** Update the display name used in the system prompt. */
  setUsername(username: string): void {
    this.deps.username = username;
  }

  /**
   * Enter Live mode: reset state and show the panel. The Gemini session is
   * created lazily on the first PTT press (single session reused while the
   * user stays in Live mode — see ensureSession).
   */
  enterLiveMode(): void {
    this.disposed = false;
    this.inLiveMode = true;
    this.pttHeld = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.resetSpeechQueue();
    this.turnDone = false;
    this.userTranscriptParts = [];
    this.currentEmotion = null;
    this.pendingPrefix = "";
    this.emotionResolved = false;
    this.setStatus({
      state: "IDLE",
      connected: false,
      reconnecting: false,
      userTranscript: "",
      reply: "",
      emotion: null,
      cameraActive: false,
      error: null,
    });
  }

  /**
   * Leave Live mode: stop capture, cancel playback, close the Gemini session.
   * Background auto-reconnect is cancelled — nothing should reconnect after
   * the user has left. Everything is re-initialized cleanly on re-entry.
   */
  exitLiveMode(): void {
    this.inLiveMode = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.cancelListening();
    this.stopMedia();
    this.disconnectSession();
    this.setStatus({
      state: "IDLE",
      connected: false,
      reconnecting: false,
      cameraActive: false,
      userTranscript: "",
      reply: "",
      emotion: null,
    });
  }

  // ── Push-to-talk ──────────────────────────────────────────

  async startListening(): Promise<void> {
    if (this.disposed || this.pttHeld) return;
    this.pttHeld = true;
    // A fresh press must never inherit the previous turn's buffered audio.
    this.audioPreRoll = [];

    // Interruption: new user input always wins — kill current playback first.
    this.deps.cancelSpeech();
    this.turnDone = false;
    this.resetSpeechQueue();
    this.clearTurnWatchdog();
    this.currentEmotion = null;
    this.pendingPrefix = "";
    this.emotionResolved = false;

    this.userTranscriptParts = [];
    this.setStatus({
      state: "LISTENING",
      userTranscript: "",
      reply: "",
      error: null,
    });
    this.deps.onListeningChange(true);
    this.deps.onUserMessage();

    // 1) Mic FIRST, synchronously inside the press gesture. The AudioContext
    //    must be created/resumed while transient activation is still alive —
    //    awaiting the Gemini handshake first left it suspended and the turn
    //    captured no audio at all.
    try {
      await this.startMic();
    } catch (err) {
      console.error("[Live] microphone failed:", err);
      this.pttHeld = false;
      this.stopMedia();
      this.deps.onListeningChange(false);
      this.setStatus({ state: "ERROR", error: describeLiveError(err), cameraActive: false });
      return;
    }

    if (!this.pttHeld || this.disposed) {
      // Released while the mic was opening — finish the half-turn gracefully.
      await this.finishTurn();
      return;
    }
    // The webcam does not open until the handshake finishes (startCamera), so
    // leave the badge honest here — it is switched on when frames really flow
    // and switched off again if the camera fails to open.
    this.setStatus({ cameraActive: false });

    // 2) Then the session handshake. Audio captured in the meantime is buffered
    //    (see audioPreRoll) and replayed the moment the session is ready, so the
    //    opening of the sentence is not lost.
    try {
      await this.ensureSession();
      if (!this.pttHeld || this.disposed) {
        await this.finishTurn();
        return;
      }
      // The socket is live — replay what the mic captured during the handshake
      // so the model hears the whole sentence, not just its tail.
      this.flushAudioPreRoll();
      this.startCamera();
    } catch (err) {
      console.error("[Live] startListening failed:", err);
      this.pttHeld = false;
      this.stopMedia();
      this.deps.onListeningChange(false);
      this.setStatus({ state: "ERROR", error: describeLiveError(err), cameraActive: false });
    }
  }

  async stopListening(): Promise<void> {
    if (!this.pttHeld) return;
    this.pttHeld = false;

    // Stop capture FIRST — nothing is sent after release.
    this.stopFrameTimer();
    this.stopMic();
    this.stopCamera();
    // Anything still buffered belongs to a turn that is over; never replay it
    // into the next one.
    this.audioPreRoll = [];
    this.setStatus({ cameraActive: false, state: "PROCESSING" });
    this.deps.onListeningChange(false);

    await this.finishTurn();
  }

  /**
   * Force-abort capture without ending the turn (window blur / unmount).
   * Also drops any queued speech, so this doubles as the "stop everything"
   * call used by exitLiveMode()/dispose().
   */
  cancelListening(): void {
    this.resetSpeechQueue();
    this.clearTurnWatchdog();
    this.audioPreRoll = [];
    if (!this.pttHeld) return;
    this.pttHeld = false;
    this.stopFrameTimer();
    this.stopMic();
    this.stopCamera();
    this.setStatus({ cameraActive: false, state: "IDLE" });
    this.deps.onListeningChange(false);
  }

  /**
   * Send the audio captured during the handshake, oldest first.
   *
   * Ordering matters: Gemini's VAD needs the sentence to arrive front-to-back,
   * so this must complete before any live chunk is streamed. Called right after
   * the session becomes ready.
   */
  private flushAudioPreRoll(): void {
    const chunks = this.audioPreRoll;
    this.audioPreRoll = [];
    if (chunks.length === 0) return;
    if (!this.client?.connected) return; // dropped: nothing to replay onto
    for (const chunk of chunks) {
      this.client.sendAudioChunk(chunk, TARGET_SAMPLE_RATE);
    }
    console.warn(`[Live] replayed ${chunks.length} pre-roll chunks captured during handshake`);
  }

  private async finishTurn(): Promise<void> {
    try {
      await this.ensureSession();
      this.client?.endUserTurn();
      // Response arrives via callbacks (onOutputTranscription → speak()).
      this.startTurnWatchdog();
      // Gemini's VAD can end the turn *while PTT is still held*, so the reply
      // may already be finished by the time the user releases. Settle here
      // instead of leaving the panel on "Thinking…" for the rest of the turn.
      this.maybeFinishSpeaking();
    } catch (err) {
      console.error("[Live] finishing turn failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus({ state: "ERROR", error: msg });
    }
  }

  // ── Gemini callbacks ──────────────────────────────────────

  private onReplyChunk(rawChunk: string): void {
    // The leading [emotion] tag may straddle a chunk boundary — buffer the
    // first characters until the tag resolves (or is ruled out) so the model
    // never reads its own tag aloud.
    let text = rawChunk;
    if (!this.emotionResolved) {
      this.pendingPrefix += rawChunk;
      const resolved = extractLeadingEmotion(this.pendingPrefix);
      if (resolved === null) return; // still ambiguous — wait for more chunks
      this.pendingPrefix = "";
      this.emotionResolved = true;
      // emotion === null means the reply simply has no tag — nothing to apply.
      if (resolved.emotion) this.handleEmotionTag(resolved.emotion);
      text = resolved.rest;
    }

    const trimmed = text.trim();
    if (!trimmed) return;

    this.lastEmotion = this.currentEmotion
      ? tagToAiEmotion(this.currentEmotion)
      : ("happy" as AiEmotion);
    // Real output arrived — the turn is alive, so disarm the watchdog.
    this.clearTurnWatchdog();
    this.setStatus({ state: "SPEAKING", reply: joinStreamedText(this.status.reply, trimmed) });
    // Expression reacts through the SAME path chat uses (InteractionManager
    // → ExpressionController → VRM blendshapes).
    this.deps.onAIResponse(this.lastEmotion);
    // Accumulate into sentence-sized utterances instead of speaking raw
    // network chunks (choppy) or waiting for the whole reply (slow).
    this.pushSentenceText(trimmed);
  }

  // ── Sentence-level utterance queue ─────────────────────────────

  /** Accumulate reply text; enqueue each completed sentence immediately. */
  private pushSentenceText(text: string): void {
    // She answers in the user's language, so only join chunks with a space
    // when neither side already has one (a space would be wrong in Japanese).
    this.sentenceBuffer = joinStreamedText(this.sentenceBuffer, text);

    // Boundaries: ASCII . ! ? … only count when whitespace follows (so "3.14"
    // stays whole), while CJK 。！？ terminate on their own.
    const parts = this.sentenceBuffer.split(/(?<=[.!?…])(?=\s)|(?<=[。！？])/);
    const tail = parts.pop() ?? ""; // last part may still be incomplete

    const utterances: string[] = [];
    let pending = "";
    for (const raw of parts) {
      const sentence = raw.trim();
      if (!sentence) continue;
      pending = pending ? `${pending} ${sentence}` : sentence;
      // "Mr."/"e.g." end with a period but the sentence continues — keep
      // accumulating instead of speaking a fragment on its own.
      if (endsWithAbbreviation(pending)) continue;
      utterances.push(pending);
      pending = "";
    }
    this.sentenceBuffer = `${pending}${tail}`;

    for (const utterance of utterances) this.enqueueUtterance(utterance);
  }

  private enqueueUtterance(sentence: string): void {
    this.queue.push(sentence);
    if (this.speaking) {
      // This sentence waits behind the one playing — start its Soundcast
      // synthesis now (existing audio cache) so the wait time overlaps
      // playback instead of being added to the reply latency.
      this.deps.prefetch?.(sentence, this.lastEmotion);
      return;
    }
    void this.playNextUtterance();
  }

  /** Play queued sentences strictly in order (single consumer). */
  private async playNextUtterance(): Promise<void> {
    if (this.speaking) return;
    const sentence = this.queue.shift();
    if (!sentence) {
      this.maybeFinishSpeaking();
      return;
    }

    const gen = this.speechGen;
    this.speaking = true;
    try {
      await this.deps.speak(sentence, this.lastEmotion);
    } catch {
      /* cancelled or failed — continue with the next sentence */
    } finally {
      this.speaking = false;
    }

    // A reset while this sentence was playing means the turn was superseded
    // (new PTT press / exit) — stop here, or the old reply would resume.
    if (gen !== this.speechGen) return;
    void this.playNextUtterance();
  }

  /**
   * Drop pending sentences and invalidate the running consumer. Called when a
   * turn is superseded (new PTT press), cancelled, or Live mode is left, so no
   * stale sentence from a previous reply is ever spoken.
   */
  private resetSpeechQueue(): void {
    this.speechGen++;
    this.queue.length = 0;
    this.sentenceBuffer = "";
    this.speaking = false;
  }

  /** Start the "did this turn produce anything?" timer (see turnWatchdog). */
  private startTurnWatchdog(): void {
    this.clearTurnWatchdog();
    this.turnWatchdog = window.setTimeout(() => {
      this.turnWatchdog = null;
      if (this.status.state !== "PROCESSING" || this.status.reply) return;
      this.setStatus({ state: "IDLE", error: "No response received — try again." });
    }, LiveModeController.TURN_WATCHDOG_MS);
  }

  private clearTurnWatchdog(): void {
    if (this.turnWatchdog !== null) {
      window.clearTimeout(this.turnWatchdog);
      this.turnWatchdog = null;
    }
  }

  private onTurnComplete(): void {
    this.turnDone = true;
    this.clearTurnWatchdog();
    // Flush any trailing text after the final punctuation as the last sentence.
    const tail = this.sentenceBuffer.trim();
    this.sentenceBuffer = "";
    if (tail) this.enqueueUtterance(tail);
    // Reset tag parsing so the next reply is parsed from a clean slate even
    // if this turn ended mid-prefix.
    this.pendingPrefix = "";
    this.emotionResolved = false;

    if (this.pttHeld) return;
    if (this.status.state === "PROCESSING" && !this.status.reply) {
      this.setStatus({ state: "ERROR", error: "No response received — try again." });
      return;
    }
    // Nothing queued/playing anymore → the turn is over (no-op otherwise).
    this.maybeFinishSpeaking();
  }

  /**
   * Leave SPEAKING once the queue is drained AND Gemini finished generating.
   */
  private maybeFinishSpeaking(): void {
    if (this.speaking || this.queue.length > 0) return;
    if (!this.turnDone || this.pttHeld) return;
    // PROCESSING settles too: when the reply was already generated and spoken
    // during the hold, the PTT release re-marks the turn as PROCESSING and
    // without this the panel sits on "Thinking…" forever.
    if (this.status.state === "SPEAKING" || this.status.state === "PROCESSING") {
      this.setStatus({ state: "IDLE" });
    }
  }

  // ── Microphone (16 kHz mono PCM16 chunks) ─────────────────

  /**
   * Acquire the mic and build the audio graph.
   *
   * MUST be invoked synchronously from the press gesture: browsers gate
   * AudioContext creation/resume on transient user activation, and it expires
   * in ~5s. Connecting to Gemini first (token mint + WS handshake ≈ 1–5s) used
   * to burn that window, so the context came back suspended, `onaudioprocess`
   * never fired, and Live mode simply never heard anything.
   */
  private startMic(): Promise<void> {
    if (this.micPending) return this.micPending;

    const run = async (): Promise<void> => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      // Released while the permission prompt was open — stop the track
      // immediately or it stays live with nobody consuming it.
      if (!this.pttHeld || this.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      this.micAudioCtx = ctx;

      // resume() is the gesture-gated call — await it BEFORE returning so the
      // graph is genuinely pulling by the time audio starts flowing.
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => {});
      }
      if (ctx.state === "suspended") {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error(
          "The browser blocked audio playback. Click anywhere on the page, then hold to talk again.",
        );
      }

      this.micStream = stream;

      const source = ctx.createMediaStreamSource(stream);
      this.micSource = source;

      // ScriptProcessor is deprecated but universally supported and enough for
      // short low-latency chunks; AudioWorklet would need a separate module file.
      const processor = ctx.createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);
      this.micProcessor = processor;
      const inputRate = ctx.sampleRate;

      processor.onaudioprocess = (e) => {
        if (!this.pttHeld) return;
        const input = e.inputBuffer.getChannelData(0);
        // Resample to the rate the API expects; pass through untouched when the
        // device already runs at 16 kHz.
        const pcm16 =
          inputRate === TARGET_SAMPLE_RATE
            ? floatTo16BitPcm(input)
            : floatTo16BitPcm(resampleTo16k(input, inputRate));
        const base64 = arrayBufferToBase64(pcm16.buffer as ArrayBuffer);

        if (this.client?.connected) {
          this.client.sendAudioChunk(base64, TARGET_SAMPLE_RATE);
          return;
        }
        // The handshake is still in flight (see audioPreRoll) — hold this chunk
        // instead of losing the opening of the sentence.
        if (this.audioPreRoll.length < LiveModeController.PRE_ROLL_MAX_CHUNKS) {
          this.audioPreRoll.push(base64);
        }
      };

      source.connect(processor);
      // Muted tail keeps the graph pulling without monitoring the mic.
      const silent = ctx.createGain();
      silent.gain.value = 0;
      processor.connect(silent);
      silent.connect(ctx.destination);
    };

    const p = run().finally(() => {
      if (this.micPending === p) this.micPending = null;
    });
    this.micPending = p;
    return p;
  }

  private stopMic(): void {
    this.micPending = null;
    this.micProcessor?.disconnect();
    this.micSource?.disconnect();
    this.micProcessor = null;
    this.micSource = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    if (this.micAudioCtx) {
      void this.micAudioCtx.close().catch(() => {});
      this.micAudioCtx = null;
    }
  }

  // ── Webcam + data-saving frame algorithm ──────────────────

  private startCamera(): void {
    if (this.camStream) return;

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: FRAME_WIDTH },
            height: { ideal: FRAME_HEIGHT },
            frameRate: { ideal: 15, max: 30 },
          },
          audio: false,
        });
        if (!this.pttHeld || this.disposed) {
          // Released before the camera finished opening — bail out cleanly.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.camStream = stream;

        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        this.camVideo = video;
        await video.play().catch(() => {});

        this.frameCanvas = document.createElement("canvas");
        this.frameCanvas.width = FRAME_WIDTH;
        this.frameCanvas.height = FRAME_HEIGHT;
        this.frameCtx = this.frameCanvas.getContext("2d", { willReadFrequently: true });
        this.lastFrameData = null;

        // The webcam is genuinely streaming now, so the badge may claim it.
        this.setStatus({ cameraActive: true });

        // Immediate first frame, then ~1 fps while held.
        this.sendCurrentFrame();
        this.frameTimer = window.setInterval(() => this.sendCurrentFrame(), FRAME_INTERVAL_MS);
      } catch (err) {
        console.warn("[Live] webcam unavailable (mic keeps working):", err);
        // Non-fatal: vision is optional for a turn — but the "Cam ON" badge
        // must not lie, since no frames will be sent.
        this.setStatus({ cameraActive: false });
      }
    })();
  }

  private stopCamera(): void {
    this.stopFrameTimer();
    this.camStream?.getTracks().forEach((t) => t.stop());
    this.camStream = null;
    if (this.camVideo) {
      this.camVideo.pause();
      this.camVideo.srcObject = null;
      this.camVideo = null;
    }
    this.frameCanvas = null;
    this.frameCtx = null;
    this.lastFrameData = null;
  }

  private stopFrameTimer(): void {
    if (this.frameTimer !== null) {
      window.clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }

  /** Capture → resize → scene check → JPEG-compress → send. */
  private sendCurrentFrame(): void {
    if (!this.pttHeld || !this.camVideo || !this.frameCtx || !this.frameCanvas) return;
    if (this.camVideo.readyState < 2) return;
    if (!this.client?.connected) return;

    const ctx = this.frameCtx;
    ctx.drawImage(this.camVideo, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);

    const current = ctx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    if (this.lastFrameData && isSceneUnchanged(current, this.lastFrameData)) {
      return; // nearly identical — skip this tick
    }
    this.lastFrameData = current;

    const jpegBase64 = this.frameCanvas.toDataURL("image/jpeg", JPEG_QUALITY).split(",")[1];
    if (jpegBase64) this.client.sendVideoFrame(jpegBase64);
  }

  // ── Teardown ──────────────────────────────────────────────

  private stopMedia(): void {
    this.stopFrameTimer();
    this.stopMic();
    this.stopCamera();
  }

  /** Full cleanup for leaving Live mode. Safe to call multiple times. */
  dispose(): void {
    this.disposed = true;
    this.inLiveMode = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.currentEmotion = null;
    this.pendingPrefix = "";
    this.emotionResolved = false;
    this.cancelListening();
    this.stopMedia();
    this.disconnectSession();
    this.setStatus({
      state: "IDLE",
      connected: false,
      reconnecting: false,
      cameraActive: false,
      emotion: null,
    });
  }
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Linear-interpolation resampler from an arbitrary capture rate down to 16 kHz.
 * Chunk boundaries keep the fractional read position so consecutive chunks
 * don't drift out of alignment with the source stream.
 */
function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function floatTo16BitPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[],
    );
  }
  return btoa(binary);
}

/** Turn a capture/connection failure into something the user can act on. */
function describeLiveError(err: unknown): string {
  const name = typeof DOMException !== "undefined" && err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
      return "Microphone access was blocked — allow the mic for this site, then hold to talk again.";
    case "NotFoundError":
      return "No microphone found — connect one and try again.";
    case "NotReadableError":
      return "The microphone is busy in another app — close it and try again.";
    case "IndexSizeError":
      return "Audio capture could not start (browser audio API error).";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

/** Lightweight scene-change check — sampled pixels, tolerates sensor noise. */
function isSceneUnchanged(a: ImageData, b: ImageData): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const pa = a.data;
  const pb = b.data;
  let diff = 0;
  let samples = 0;
  for (let i = 0; i < pa.length; i += 4 * SCENE_DIFF_PIXEL_STEP) {
    samples++;
    if (
      Math.abs(pa[i] - pb[i]) > SCENE_DIFF_CHANNEL_TOLERANCE ||
      Math.abs(pa[i + 1] - pb[i + 1]) > SCENE_DIFF_CHANNEL_TOLERANCE ||
      Math.abs(pa[i + 2] - pb[i + 2]) > SCENE_DIFF_CHANNEL_TOLERANCE
    ) {
      diff++;
    }
  }
  return samples === 0 || diff / samples < SCENE_DIFF_THRESHOLD;
}

// ── Sentence splitting ───────────────────────────────────

/** Tokens whose trailing period is NOT a sentence end (mid-sentence usage). */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "fig",
  "e.g",
  "i.e",
]);

/** True when a candidate sentence ends in a period that is part of a word/abbreviation. */
const NO_SPACE_BEFORE = /^[,.;:!?%)}\u2019\u201d\u2026]/;
const NO_SPACE_AFTER = /[({\u2018\u201c/\u2013\u2014-]$/;

/**
 * Join streamed reply deltas into one string without losing the spaces the
 * model puts between them. Gemini streams word-sized pieces, so trimming each
 * delta and concatenating glues words together ("missedyoutoo") — the panel
 * text reads wrong and the synthesised sentence is mispronounced. A space is
 * only inserted when neither side already provides one, and never inside CJK
 * text, where it would be wrong.
 */
function joinStreamedText(current: string, next: string): string {
  if (!current) return next;
  if (/[\u3000-\u9fff]$/.test(current)) return current + next;
  if (/\s$/.test(current) || /^\s/.test(next)) return current + next;
  // Punctuation and mid-token pieces attach to the previous fragment: a delta
  // may be just "", or split "3" + ".14", so never pad those with a space.
  if (NO_SPACE_BEFORE.test(next) || NO_SPACE_AFTER.test(current)) return current + next;
  return `${current} ${next}`;
}

function endsWithAbbreviation(sentence: string): boolean {
  const token = /([A-Za-z][A-Za-z.]*)\.$/.exec(sentence)?.[1];
  return token ? ABBREVIATIONS.has(token.toLowerCase()) : false;
}

// ── Emotion tag parsing ───────────────────────────────────

/**
 * Vocabulary of the leading [emotion] tag, mirroring the animation registry
 * ids (plus display-only "neutral"). "talking" is accepted for prompt
 * robustness but never triggers an animation.
 */
const EMOTION_TAGS = new Set([
  "happy",
  "excited",
  "angry",
  "sad",
  "crying",
  "bashful",
  "thankful",
  "rejected",
  "threatening",
  "thinking",
  "listening",
  "talking",
  "surprised",
  "kiss",
  "blow_kiss",
  "no",
  "look_around",
  "greeting",
  "goodbye",
  "bunny_ears",
  "cheer",
  "sing",
  "selfie",
  "neutral",
]);

/**
 * Registry tags → the app's AiEmotion vocabulary (the 8 values chat mode
 * uses). Keeps her FACIAL expression and TTS prosody consistent with the
 * tag: [sad] speaks with sad prosody, [bashful] blushes embarrassed,
 * [rejected] pouts annoyed — same mappings the chat pipeline applies.
 */
const TAG_TO_AI_EMOTION: Record<string, AiEmotion> = {
  happy: "happy",
  excited: "excited",
  angry: "angry",
  sad: "sad",
  crying: "sad",
  bashful: "embarrassed",
  thankful: "happy",
  rejected: "annoyed",
  threatening: "angry",
  thinking: "nervous",
  listening: "neutral",
  talking: "neutral",
  surprised: "nervous",
  kiss: "happy",
  blow_kiss: "happy",
  no: "annoyed",
  look_around: "nervous",
  greeting: "happy",
  goodbye: "happy",
  bunny_ears: "happy",
  cheer: "excited",
  sing: "happy",
  selfie: "happy",
  neutral: "neutral",
};

/** Map an [emotion] tag to the internal AiEmotion (unknown → happy). */
function tagToAiEmotion(tag: string): AiEmotion {
  return TAG_TO_AI_EMOTION[tag] ?? "happy";
}

/** Longest possible partial prefix of "[xxxxx]" that could still become a tag. */
function couldBecomeTag(buffer: string): boolean {
  const prefix = "[";
  for (const tag of EMOTION_TAGS) {
    const full = prefix + tag + "]";
    if (full.startsWith(buffer) && buffer.length < full.length) return true;
  }
  return false;
}

/**
 * Extract the leading [emotion] tag from a (possibly partial) reply stream.
 *
 * Returns:
 *  - { emotion, rest }  when a valid tag was found at the start
 *  - { emotion: null, rest } when the reply definitely has NO tag at the start
 *  - null when the buffer is still too short to decide (keep buffering)
 */
export function extractLeadingEmotion(
  buffer: string,
): { emotion: string | null; rest: string } | null {
  const trimmedStart = buffer.trimStart();

  // Direct match — including the straddled case where the tag is complete.
  const match = trimmedStart.match(/^\[([a-z_]+)\]\s*/i);
  if (match) {
    const tag = match[1].toLowerCase();
    if (EMOTION_TAGS.has(tag)) {
      return { emotion: tag, rest: trimmedStart.slice(match[0].length) };
    }
    // Tag-shaped but unknown (model drift) — strip it so it's never read
    // aloud, but apply no emotion.
    return { emotion: null, rest: trimmedStart.slice(match[0].length) };
  }

  // Still ambiguous: could grow into "[happy]" etc. — keep buffering.
  if (couldBecomeTag(trimmedStart)) return null;

  // Definitely no tag at the start ("Hmm...", "Hehe", empty, …).
  return { emotion: null, rest: trimmedStart };
}
