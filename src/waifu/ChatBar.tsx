import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Mic, MicOff } from "lucide-react";
import { VoiceInput, formatKeyCode } from "@/waifu/voiceInput";
import { cn } from "@/lib/utils";
import { GLASS_FOCUS } from "./hudTheme";

interface Props {
  onSend: (text: string) => Promise<void>;
  busy: boolean;
  /** Name used in the composer copy, so the app speaks about one person. */
  peerName?: string;
  pushToTalkEnabled?: boolean;
  pushToTalkKey?: string;
  pushToTalkListening?: boolean;
  pushToTalkPartial?: string;
  /** Inline error text shown in the dock instead of a browser alert(). */
  micError?: string | null;
  onDismissMicError?: () => void;
}

export function ChatBar({
  onSend,
  busy,
  peerName = "her",
  pushToTalkEnabled = false,
  pushToTalkKey = "Space",
  pushToTalkListening = false,
  pushToTalkPartial = "",
  micError = null,
  onDismissMicError,
}: Props) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const voiceRef = useRef<VoiceInput | null>(null);

  useEffect(() => {
    voiceRef.current = new VoiceInput();
    return () => voiceRef.current?.abort();
  }, []);

  const error = micError ?? localError;
  const clearError = () => {
    setLocalError(null);
    onDismissMicError?.();
  };

  const submit = async () => {
    const t = text.trim();
    // Sends are always accepted — while a turn is in flight the request is
    // queued so every user message still gets its own response.
    if (!t) return;
    clearError();
    setText("");
    await onSend(t);
  };

  const toggleMic = async () => {
    const voice = voiceRef.current;
    if (!voice?.supported) {
      setLocalError("This browser has no speech recognition. Use Chrome or Edge to talk to her.");
      return;
    }

    if (listening) {
      const transcript = await voice.stopAsync();
      setListening(false);
      if (transcript.trim()) {
        setText("");
        await onSend(transcript.trim());
      }
      return;
    }

    const started = voice.start(
      (partial) => setText(partial),
      (msg) => {
        setListening(false);
        if (msg !== "no-speech") setLocalError(msg);
      },
    );
    if (!started) {
      setLocalError("She can't hear you — check the microphone permission for this site.");
      return;
    }
    clearError();
    setListening(true);
  };

  const pttActive = pushToTalkEnabled && pushToTalkListening;
  const displayText = pttActive && pushToTalkPartial ? pushToTalkPartial : text;
  const micActive = listening || pttActive;
  const keyLabel = formatKeyCode(pushToTalkKey);
  const canSend = !!text.trim() && !pttActive;

  const placeholder = pttActive
    ? "Listening…"
    : busy
      ? "She's writing…"
      : pushToTalkEnabled
        ? `Message ${peerName}, or hold ${keyLabel}`
        : `Message ${peerName}…`;

  return (
    <div className="w-full">
      {error && (
        <p
          role="alert"
          className="mb-2.5 flex items-start gap-2 rounded-xl border border-red-400/15 bg-red-500/[0.08] px-3 py-2 text-[11px] leading-snug text-red-200"
        >
          <MicOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={clearError}
            aria-label="Dismiss"
            className="focus-ring shrink-0 rounded px-1 text-red-200/60 transition-colors hover:text-red-100"
          >
            ✕
          </button>
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex w-full items-center gap-2"
      >
        {!pushToTalkEnabled ? (
          <button
            type="button"
            onClick={() => void toggleMic()}
            aria-label={listening ? "Stop dictating" : "Dictate a message"}
            title={listening ? "Stop dictating" : "Dictate"}
            className={cn(
              "focus-ring grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors",
              micActive
                ? "bg-red-500/20 text-red-300"
                : "text-white/40 hover:bg-white/[0.08] hover:text-white/85",
            )}
          >
            <Mic className={cn("h-4 w-4", micActive && "animate-pulse")} />
          </button>
        ) : (
          <span
            title={`Hold ${keyLabel} to talk`}
            className={cn(
              "grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors",
              pttActive ? "bg-red-500/20 text-red-300" : "text-white/30",
            )}
          >
            <Mic className={cn("h-4 w-4", pttActive && "animate-pulse")} />
            <span className="sr-only">Hold {keyLabel} to talk</span>
          </span>
        )}

        <div className="composer-well">
          <input
            value={displayText}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            maxLength={500}
            readOnly={pttActive}
            aria-label="Message"
            className="h-8 min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-white/90 outline-none placeholder:text-white/35"
          />
          {busy && (
            <Loader2 className="mr-1 h-3.5 w-3.5 shrink-0 animate-spin text-white/25" aria-hidden />
          )}
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            title="Send"
            className={cn(
              "focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-full transition-all duration-200",
              canSend
                ? "bg-[var(--hud-accent)] text-[#0b0e19] shadow-[0_2px_12px_-3px_var(--hud-accent)] hover:brightness-110"
                : "cursor-not-allowed bg-white/[0.04] text-white/20",
            )}
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>
      </form>
    </div>
  );
}
