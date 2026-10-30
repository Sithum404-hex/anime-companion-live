import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Camera, CameraOff, Loader2, Mic, Monitor, MessagesSquare, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LiveStatus } from "./liveMode";
import { formatKeyCode } from "./voiceInput";
import { GLASS_FOCUS } from "./hudTheme";

export type AppMode = "chat" | "screen" | "live";

interface ModeDef {
  id: AppMode;
  label: string;
  icon: typeof MessagesSquare;
  /** Tooltip and switcher hint — states what the mode actually does. */
  hint: string;
}

const MODES: ModeDef[] = [
  { id: "chat", label: "Chat", icon: MessagesSquare, hint: "Talk to her by text or voice" },
  { id: "screen", label: "Screen", icon: Monitor, hint: "Share your screen so she can react" },
  { id: "live", label: "Live", icon: Radio, hint: "Hold to talk. She sees your camera" },
];

/**
 * Mode switcher — a permanent segmented control, not a hidden dropdown.
 *
 * It used to sit behind a Layers icon inside an auto-hiding layer, so the two
 * features nobody could find (Screen Vision, Live) were genuinely unreachable.
 *
 * The selection is a single sliding thumb rather than a per-button highlight:
 * the control reads as one object that changes state, the way an iOS
 * segmented control does. The thumb is measured from the live DOM so it stays
 * correct at any font size or zoom level. Arrow keys move between modes.
 */
export function ModeSelector({
  mode,
  onChange,
  disabledIds = [],
  className,
}: {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
  /** Modes that cannot be entered right now (rendered disabled, still labelled). */
  disabledIds?: AppMode[];
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Partial<Record<AppMode, HTMLButtonElement | null>>>({});
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  const measure = useCallback(() => {
    const track = trackRef.current;
    const btn = btnRefs.current[mode];
    if (!track || !btn) return;
    const t = track.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    setThumb({ left: b.left - t.left, width: b.width });
  }, [mode]);

  // Measure before paint so the thumb never appears at 0px and slides in.
  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // Web fonts can settle after mount and shift the labels under the thumb.
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready?.then(measure).catch(() => {});
  }, [measure]);

  const move = (direction: 1 | -1) => {
    const current = MODES.findIndex((m) => m.id === mode);
    for (let step = 1; step <= MODES.length; step++) {
      const nextIndex = (current + direction * step + MODES.length) % MODES.length;
      const candidate = MODES[nextIndex];
      if (!disabledIds.includes(candidate.id)) {
        onChange(candidate.id);
        requestAnimationFrame(() => btnRefs.current[candidate.id]?.focus());
        return;
      }
    }
  };

  return (
    <div
      ref={trackRef}
      role="tablist"
      aria-label="Interaction mode"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          move(-1);
        }
      }}
      className={`seg-track glass ${className ?? ""}`}
    >
      {thumb && (
        <motion.span
          aria-hidden
          className="seg-thumb"
          style={{ left: thumb.left, width: thumb.width }}
          initial={false}
          animate={{ left: thumb.left, width: thumb.width }}
          transition={{ type: "spring", stiffness: 420, damping: 36, mass: 0.7 }}
        />
      )}

      {MODES.map((m) => {
        const Icon = m.icon;
        const active = mode === m.id;
        const disabled = disabledIds.includes(m.id);
        return (
          <button
            key={m.id}
            ref={(el) => {
              btnRefs.current[m.id] = el;
            }}
            role="tab"
            type="button"
            aria-label={m.label}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={m.hint}
            disabled={disabled}
            onClick={() => onChange(m.id)}
            className={[
              "focus-ring relative z-[2] flex items-center gap-1.5 rounded-full px-2.5 py-1.5 min-[350px]:px-3",
              "text-xs font-medium transition-colors duration-200",
              active ? "text-white" : "text-white/50 hover:text-white/85",
              disabled ? "cursor-not-allowed opacity-30 hover:text-white/50" : "",
            ].join(" ")}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
            <span className="hidden min-[350px]:inline">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const STATE_COPY: Record<LiveStatus["state"], string> = {
  IDLE: "Ready — hold to talk",
  LISTENING: "Listening",
  PROCESSING: "Thinking",
  SPEAKING: "Speaking",
  ERROR: "Link problem",
};

const STATE_DOT: Record<LiveStatus["state"], string> = {
  IDLE: "bg-white/35",
  LISTENING: "bg-red-400",
  PROCESSING: "bg-amber-400 animate-pulse",
  SPEAKING: "bg-[var(--hud-accent)]",
  ERROR: "bg-red-400",
};

interface LiveControlProps {
  status: LiveStatus;
  pttHeld: boolean;
  pttKey: string;
  onPressStart: () => void;
  onPressEnd: () => void;
}

/**
 * Live-mode console: a link readout plus one full-width push-to-talk surface.
 *
 * Renders inside the same dock shell as the chat composer, so switching modes
 * changes what the surface DOES rather than making it look like a different app.
 * The button uses pointer capture semantics (press-and-hold) so mouse and touch
 * behave identically.
 */
export function LiveControl({
  status,
  pttHeld,
  pttKey,
  onPressStart,
  onPressEnd,
}: LiveControlProps) {
  const pressingRef = useRef(false);

  const start = () => {
    if (pressingRef.current) return;
    pressingRef.current = true;
    onPressStart();
  };
  const end = () => {
    if (!pressingRef.current) return;
    pressingRef.current = false;
    onPressEnd();
  };

  // Safety nets: a pointer released outside the button, or a lost window focus,
  // must still end the turn — otherwise the mic would stay open.
  useEffect(() => {
    const onUp = () => end();
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasError = status.state === "ERROR" && !!status.error;

  return (
    <div className="w-full">
      {/* Link readout — the one row that answers "is this actually working?" */}
      <div className="mb-2 flex items-center gap-2">
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          {status.state === "LISTENING" && (
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-70",
                STATE_DOT[status.state],
              )}
            />
          )}
          <span
            className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", STATE_DOT[status.state])}
          />
        </span>

        <span
          className={cn(
            "text-[11px] font-medium",
            status.state === "ERROR"
              ? "text-red-300"
              : status.state === "SPEAKING"
                ? "text-[var(--hud-accent)]"
                : "text-white/65",
          )}
        >
          {STATE_COPY[status.state]}
        </span>

        {status.emotion && status.emotion !== "neutral" && (
          <span className="hidden truncate text-[11px] text-white/30 sm:inline">
            feeling {status.emotion.replace(/_/g, " ")}
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {status.reconnecting && (
            <span className="flex items-center gap-1 text-[10px] text-amber-300/80">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="sr-only sm:not-sr-only">Reconnecting</span>
            </span>
          )}
          <MediaBadge on={pttHeld} icon={Mic} label="Microphone" />
          <MediaBadge
            on={status.cameraActive}
            icon={status.cameraActive ? Camera : CameraOff}
            label="Camera"
          />
        </div>
      </div>

      {/* Transcript — what you said, then what she said. */}
      {(status.userTranscript || status.reply || hasError) && (
        <div className="mb-2.5 space-y-2">
          {hasError && (
            <p className="rounded-xl border border-red-400/15 bg-red-500/[0.08] px-3 py-2 text-[11px] leading-snug text-red-200">
              {status.error}
            </p>
          )}
          {status.userTranscript && (
            <p className="px-1 text-right text-[11px] leading-snug text-white/40">
              {status.userTranscript}
            </p>
          )}
          {status.reply && (
            <p className="bubble-them max-h-28 overflow-y-auto px-3 py-2 text-[13px] leading-snug text-white/90">
              {status.reply}
            </p>
          )}
        </div>
      )}

      {/* Hold-to-talk — the whole bar is the target, not just the mic glyph. */}
      <button
        type="button"
        onPointerDown={(e) => {
          e.preventDefault();
          start();
        }}
        onPointerUp={end}
        onPointerLeave={end}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={pttHeld ? "Release to send" : "Hold to talk"}
        className={cn(
          "focus-ring flex w-full select-none items-center gap-3 rounded-2xl border px-3 py-2 text-left transition-all duration-200",
          pttHeld
            ? "border-red-400/35 bg-red-500/[0.14]"
            : "border-white/10 bg-white/[0.045] hover:border-white/[0.16] hover:bg-white/[0.07]",
        )}
      >
        <span
          className={cn(
            "relative grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors",
            pttHeld ? "bg-red-500 text-white" : "live-mic-orb",
          )}
        >
          {pttHeld && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 animate-[ring-expand_1.4s_ease-out_infinite] rounded-full border border-white/45"
            />
          )}
          <Mic className={cn("relative h-4 w-4", pttHeld && "animate-pulse")} strokeWidth={2} />
        </span>

        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-[13px] font-medium",
              pttHeld ? "text-red-100" : "text-white/85",
            )}
          >
            {pttHeld ? "Listening — release to send" : "Hold to talk"}
          </span>
          <span
            className={cn(
              "block truncate text-[11px]",
              pttHeld ? "text-red-200/60" : "text-white/35",
            )}
          >
            {pttHeld
              ? "She's all ears."
              : `Press ${formatKeyCode(pttKey)}, or press and hold here.`}
          </span>
        </span>

        <KeyCap>{formatKeyCode(pttKey)}</KeyCap>
      </button>
    </div>
  );
}

function MediaBadge({ on, icon: Icon, label }: { on: boolean; icon: typeof Mic; label: string }) {
  return (
    <span
      title={`${label} ${on ? "on" : "off"}`}
      className={cn(
        "flex h-6 items-center gap-1 rounded-full border px-2 transition-colors duration-200",
        on ? "border-white/12 bg-white/10 text-white/75" : "border-white/[0.06] text-white/20",
      )}
    >
      <Icon className="h-3 w-3" />
      <span className="hidden text-[10px] sm:inline">{on ? "on" : "off"}</span>
      <span className="sr-only">
        {label} {on ? "on" : "off"}
      </span>
    </span>
  );
}

/** A literal keycap — the one place a monospace face is functional, not decorative. */
function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="shrink-0 rounded-md border border-white/12 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/60">
      {children}
    </kbd>
  );
}
