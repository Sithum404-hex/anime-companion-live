import { getRecognizer } from "./speechRecognition";

type SpeechRecognizer = NonNullable<ReturnType<typeof getRecognizer>>;

export interface VoiceInputStartOptions {
  /**
   * Chrome silently ends recognition after a few seconds of silence even in
   * continuous mode. While push-to-talk is still held, this predicate lets
   * the session restart transparently so the full sentence survives.
   */
  shouldRestart?: () => boolean;
}

/** Push-to-talk voice capture — mic is only active while explicitly started. */
export class VoiceInput {
  private rec: SpeechRecognizer | null;
  /** Finalized words from previous auto-restarted sessions. */
  private baseText = "";
  /** Interim words from the running recognition session. */
  private sessionText = "";
  private _listening = false;
  private endResolver: ((text: string) => void) | null = null;
  private restartAllowed = false;

  constructor() {
    this.rec = getRecognizer();
  }

  get supported(): boolean {
    return this.rec !== null;
  }

  get listening(): boolean {
    return this._listening;
  }

  private get fullTranscript(): string {
    const combined = `${this.baseText} ${this.sessionText}`.trim();
    return combined.replace(/\s+/g, " ");
  }

  start(
    onPartial?: (text: string) => void,
    onError?: (message: string) => void,
    options?: VoiceInputStartOptions,
  ): boolean {
    if (!this.rec || this._listening) return false;

    const r = this.rec;
    this.baseText = "";
    this.sessionText = "";
    this.restartAllowed = typeof options?.shouldRestart === "function";
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";

    r.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) {
        if (text) text += " ";
        text += e.results[i][0].transcript;
      }
      this.sessionText = text.trim();
      onPartial?.(this.fullTranscript);
    };

    r.onerror = (e: unknown) => {
      const err = e as { error?: string };
      const code = err?.error ?? "unknown";
      if (code !== "aborted" && code !== "no-speech") {
        onError?.(code);
      }
    };

    r.onend = () => {
      // Silence timeout — restart while the caller still wants to listen.
      if (this.restartAllowed) {
        this.baseText = this.fullTranscript;
        this.sessionText = "";
        try {
          r.start();
          return;
        } catch {
          // fall through to finalize
        }
      }
      this._listening = false;
      if (this.endResolver) {
        const resolve = this.endResolver;
        this.endResolver = null;
        resolve(this.fullTranscript);
      }
    };

    try {
      r.start();
      this._listening = true;
      return true;
    } catch {
      this._listening = false;
      return false;
    }
  }

  /** Stop capture and resolve with the final transcript. */
  stopAsync(): Promise<string> {
    if (!this.rec || !this._listening) {
      return Promise.resolve(this.fullTranscript);
    }

    return new Promise((resolve) => {
      this.endResolver = resolve;
      this.restartAllowed = false;
      try {
        this.rec!.stop();
      } catch {
        this._listening = false;
        this.endResolver = null;
        resolve(this.fullTranscript);
      }
    });
  }

  abort(): void {
    if (!this.rec) return;
    this.endResolver = null;
    this.restartAllowed = false;
    try {
      this.rec.abort();
    } catch {
      // ignore
    }
    this._listening = false;
    this.baseText = "";
    this.sessionText = "";
  }
}

/** Human-readable label for a KeyboardEvent.code value. */
export function formatKeyCode(code: string): string {
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

/** Returns true if the event target is a text-entry control. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * True when a keypress should activate push-to-talk even though an editable
 * control has focus. Typing must keep working: only an EMPTY field is
 * surrendered to the mic (it is blurred for the duration of the hold).
 */
export function shouldCaptureFromEditable(target: EventTarget | null): boolean {
  if (!isEditableTarget(target)) return true;
  const el = target as HTMLInputElement | HTMLTextAreaElement;
  return el.value.trim().length === 0;
}
