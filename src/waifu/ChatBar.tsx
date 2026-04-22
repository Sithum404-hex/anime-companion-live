import { useState, useRef, useEffect } from "react";
import { Mic, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getRecognizer } from "@/waifu/speechRecognition";

interface Props {
  onSend: (text: string) => Promise<void>;
  busy: boolean;
}

export function ChatBar({ onSend, busy }: Props) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const recRef = useRef<ReturnType<typeof getRecognizer>>(null);

  useEffect(() => {
    recRef.current = getRecognizer();
  }, []);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    await onSend(t);
  };

  const toggleMic = () => {
    const r = recRef.current;
    if (!r) {
      alert("Speech recognition not supported in this browser.");
      return;
    }
    if (listening) {
      r.stop();
      setListening(false);
      return;
    }
    r.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setText(transcript);
      setListening(false);
      void onSend(transcript);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    r.start();
    setListening(true);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex w-full max-w-2xl items-center gap-2 rounded-full border border-border bg-card/80 px-2 py-2 backdrop-blur-xl shadow-2xl"
    >
      <Button
        type="button"
        variant={listening ? "default" : "ghost"}
        size="icon"
        onClick={toggleMic}
        className="rounded-full shrink-0"
        aria-label="Voice input"
      >
        <Mic className={`h-4 w-4 ${listening ? "animate-pulse" : ""}`} />
      </Button>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={busy ? "Thinking…" : "Say something to your waifu…"}
        disabled={busy}
        className="border-0 bg-transparent shadow-none focus-visible:ring-0"
      />
      <Button type="submit" size="icon" disabled={busy || !text.trim()} className="rounded-full shrink-0">
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );
}
