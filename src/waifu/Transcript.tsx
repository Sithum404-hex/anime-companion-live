import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, ChevronDown, MessagesSquare } from "lucide-react";
import type { ChatMsg } from "@/waifu/aiEngine";
import { cn } from "@/lib/utils";
import { GLASS_FOCUS } from "./hudTheme";

export interface TranscriptLine {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
}

/**
 * Conversation transcript.
 *
 * The panel is a reading surface, not a second app. A single header states
 * what it is and how much is in it; the log itself uses alignment and one
 * accent to distinguish the two speakers. No stamped speaker labels, no
 * card chrome around every line.
 */
export function Transcript({
  lines,
  busy,
  error,
  onClearError,
  collapsed,
  onToggleCollapsed,
}: {
  lines: TranscriptLine[];
  busy: boolean;
  /** Inline failure row — persistent, not a toast that vanishes. */
  error: string | null;
  onClearError: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, busy]);

  const showPanel = collapsed || lines.length > 0 || !!error;

  return (
    <AnimatePresence initial={false}>
      {showPanel && (
        <motion.aside
          initial={{ opacity: 0, x: -14 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -14 }}
          transition={{ duration: reduceMotion ? 0 : 0.24, ease: "easeOut" }}
          aria-label="Conversation"
          className={cn(
            "glass pointer-events-auto flex flex-col overflow-hidden",
            collapsed ? "w-12 rounded-2xl" : "w-[min(calc(100vw-2rem),21.5rem)] rounded-[1.4rem]",
          )}
        >
          {collapsed ? (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Expand conversation"
              title={`${lines.length} messages — expand`}
              className={cn(
                "grid h-12 w-12 place-items-center text-white/55",
                "transition-colors hover:text-white",
                GLASS_FOCUS,
              )}
            >
              <MessagesSquare className="h-4 w-4" />
            </button>
          ) : (
            <>
              <header className="flex items-center gap-2 border-b border-white/[0.06] px-3.5 pb-2.5 pt-3">
                <MessagesSquare className="h-3.5 w-3.5 text-white/35" aria-hidden />
                <h2 className="text-xs font-medium text-white/75">Conversation</h2>
                <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[10px] tabular-nums leading-none text-white/40">
                  {lines.length}
                </span>
                <button
                  type="button"
                  onClick={onToggleCollapsed}
                  aria-label="Collapse conversation"
                  title="Collapse"
                  className={cn(
                    "ml-auto grid h-6 w-6 place-items-center rounded-full text-white/35",
                    "transition-colors hover:bg-white/10 hover:text-white/80",
                    GLASS_FOCUS,
                  )}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </header>

              <div
                ref={scrollRef}
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                className="scroll-slim flex flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain px-3 pb-3.5 pt-3 max-h-[min(38vh,22rem)] sm:max-h-[min(50vh,28rem)]"
              >
                {lines.map((line) => (
                  <Message key={line.id} line={line} />
                ))}

                {busy && (
                  <div
                    className="flex items-center gap-1.5 px-1 py-0.5"
                    role="status"
                    aria-live="polite"
                  >
                    <span className="sr-only">She is writing a reply</span>
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="h-1 w-1 rounded-full bg-[var(--hud-accent)]"
                        animate={reduceMotion ? { opacity: 0.8 } : { opacity: [0.25, 1, 0.25] }}
                        transition={
                          reduceMotion
                            ? { duration: 0 }
                            : { duration: 1.1, repeat: Infinity, delay: i * 0.18 }
                        }
                      />
                    ))}
                  </div>
                )}

                {error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-red-400/15 bg-red-500/[0.08] px-2.5 py-2 text-[11px] leading-snug text-red-200"
                  >
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <button
                      type="button"
                      onClick={onClearError}
                      className="shrink-0 rounded px-1 text-red-200/60 transition-colors hover:text-red-100"
                      aria-label="Dismiss error"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Message({ line }: { line: TranscriptLine }) {
  const mine = line.role === "user";
  const reduceMotion = useReducedMotion();
  const time = new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
      className={cn("flex", mine ? "justify-end" : "justify-start")}
    >
      <div
        title={time}
        className={cn(
          "max-w-[84%] px-3.5 py-2 text-[13px] leading-[1.55] text-white/90",
          mine ? "bubble-you" : "bubble-them",
        )}
      >
        {line.content}
      </div>
    </motion.div>
  );
}
