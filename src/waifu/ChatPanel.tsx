import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ChatMsg } from "@/waifu/aiEngine";

interface Props {
  messages: ChatMsg[];
  busy: boolean;
}

export function ChatPanel({ messages, busy }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const visible = messages.filter((m) => m.role !== "system");

  return (
    <div className="pointer-events-auto w-full max-w-2xl rounded-2xl border border-border bg-card/80 backdrop-blur-xl shadow-2xl">
      <ScrollArea className="h-[40vh] max-h-[420px] min-h-[180px] px-4 py-3">
        {visible.length === 0 && !busy ? (
          <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-muted-foreground">
            Say hi to your waifu 👋
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <AnimatePresence initial={false}>
              {visible.map((m, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-snug whitespace-pre-wrap break-words ${
                      m.role === "user"
                        ? "bg-primary text-primary-foreground rounded-br-sm"
                        : "bg-muted text-foreground rounded-bl-sm"
                    }`}
                  >
                    {m.role === "assistant" ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                        <ReactMarkdown>{m.content}</ReactMarkdown>
                      </div>
                    ) : (
                      m.content
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            {busy && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex justify-start"
              >
                <div className="rounded-2xl rounded-bl-sm bg-muted px-4 py-2 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    Thinking
                    <span className="inline-flex gap-0.5">
                      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground" />
                    </span>
                  </span>
                </div>
              </motion.div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
