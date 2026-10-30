import { useCallback, useEffect, useRef, useState } from "react";
import {
  VoiceInput,
  isEditableTarget,
  shouldCaptureFromEditable,
  type VoiceInputStartOptions,
} from "./voiceInput";

interface Options {
  enabled: boolean;
  keyCode: string;
  busy: boolean;
  onSend: (text: string) => Promise<void>;
  onListeningChange?: (active: boolean) => void;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
}

export function usePushToTalk({
  enabled,
  keyCode,
  busy,
  onSend,
  onListeningChange,
  onPartial,
  onError,
}: Options) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const voiceRef = useRef<VoiceInput | null>(null);
  const holdingRef = useRef(false);

  // Callbacks arrive as fresh inline closures every render. Keeping them in
  // refs lets the keyboard effect subscribe ONCE — re-subscribing on every
  // render used to run its cleanup mid-listen, which abort()ed recognition
  // the moment the first interim transcript triggered a re-render.
  const busyRef = useRef(busy);
  const onSendRef = useRef(onSend);
  const cbsRef = useRef({ onListeningChange, onPartial, onError });
  busyRef.current = busy;
  onSendRef.current = onSend;
  cbsRef.current = { onListeningChange, onPartial, onError };

  useEffect(() => {
    voiceRef.current = new VoiceInput();
    return () => voiceRef.current?.abort();
  }, []);

  const setActive = useCallback((active: boolean) => {
    setListening(active);
    cbsRef.current.onListeningChange?.(active);
    if (!active) setPartial("");
  }, []);

  useEffect(() => {
    if (!enabled || !keyCode) return;

    const voice = () => voiceRef.current;

    const release = async () => {
      if (!holdingRef.current) return;
      holdingRef.current = false;
      setActive(false);

      const text = (await voice()?.stopAsync()) ?? "";
      // Always forward — handleSend queues turns while a reply is in flight,
      // so a transcript captured during a busy period is never lost.
      if (text) {
        await onSendRef.current(text);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== keyCode || e.repeat) return;
      if (holdingRef.current) return;

      // Let the user finish typing in a drafted message; an empty field is
      // surrendered to the mic so the hotkey works right after focusing it.
      if (isEditableTarget(e.target) && !shouldCaptureFromEditable(e.target)) return;

      const v = voice();
      if (!v?.supported) {
        cbsRef.current.onError?.("Speech recognition is not supported in this browser.");
        return;
      }

      e.preventDefault();
      if (isEditableTarget(e.target)) (e.target as HTMLElement).blur();
      holdingRef.current = true;
      setActive(true);

      const restartOptions: VoiceInputStartOptions = {
        shouldRestart: () => holdingRef.current,
      };
      const started = v.start(
        (text) => {
          setPartial(text);
          cbsRef.current.onPartial?.(text);
        },
        (msg) => cbsRef.current.onError?.(msg),
        restartOptions,
      );

      if (!started) {
        holdingRef.current = false;
        setActive(false);
        cbsRef.current.onError?.("Could not start microphone. Check browser permissions.");
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== keyCode) return;
      void release();
    };

    const onWindowBlur = () => {
      if (!holdingRef.current) return;
      voice()?.abort();
      holdingRef.current = false;
      setActive(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      if (holdingRef.current) {
        holdingRef.current = false;
        voice()?.abort();
        setActive(false);
      }
    };
  }, [enabled, keyCode, setActive]);

  return {
    listening,
    partial,
    supported: voiceRef.current?.supported ?? false,
  };
}
