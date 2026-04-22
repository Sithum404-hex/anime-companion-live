// Lightweight wrapper around Web Speech API for STT.
type SR = {
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { results: { isFinal: boolean; 0: { transcript: string } }[] & { length: number } }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
};

export function getRecognizer(): SR | null {
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const r = new Ctor();
  r.continuous = false;
  r.interimResults = false;
  r.lang = "en-US";
  return r;
}
