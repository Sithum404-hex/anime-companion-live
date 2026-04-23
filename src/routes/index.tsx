import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Settings as SettingsIcon, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WaifuStage, type WaifuHandle } from "@/waifu/WaifuStage";
import { SettingsPanel } from "@/waifu/SettingsPanel";
import { ChatBar } from "@/waifu/ChatBar";
import { DEFAULT_SETTINGS, type Settings, type ModelManifest } from "@/waifu/types";
import { chatWithAI, sentimentEmotion, type ChatMsg } from "@/waifu/aiEngine";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "AI Anime Waifu — Live Wallpaper" },
      { name: "description", content: "An interactive 3D anime character that talks, listens, and reacts — runs entirely in your browser." },
    ],
  }),
});

const STORAGE_KEY = "waifu.settings.v1";

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function Index() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Loading…");
  const [isFs, setIsFs] = useState(false);
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [subtitle, setSubtitle] = useState<string>("");
  const [manifest, setManifest] = useState<ModelManifest | null>(null);

  const handleRef = useRef<WaifuHandle | null>(null);
  const hideTimer = useRef<number | null>(null);
  const subtitleTimer = useRef<number | null>(null);

  const showSubtitle = useCallback((text: string, ms?: number) => {
    setSubtitle(text);
    if (subtitleTimer.current) window.clearTimeout(subtitleTimer.current);
    const duration = ms ?? Math.min(8000, 2500 + text.length * 40);
    subtitleTimer.current = window.setTimeout(() => setSubtitle(""), duration);
  }, []);

  // Hydrate settings on client
  useEffect(() => {
    setSettings(loadSettings());
    setHydrated(true);
  }, []);

  // Persist settings
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings, hydrated]);

  // Load manifest for model URL resolution
  useEffect(() => {
    fetch("/models/manifest.json")
      .then((r) => r.json())
      .then(setManifest)
      .catch(() => setManifest({ models: [{ id: "waifu", label: "Waifu", file: "/models/waifu.vrm" }] }));
  }, []);

  const modelUrl = useMemo(() => {
    const m = manifest?.models.find((x) => x.id === settings.modelId) ?? manifest?.models[0];
    return m?.file ?? "/models/waifu.vrm";
  }, [manifest, settings.modelId]);

  // Auto-hide UI after 3s of mouse inactivity
  const showUi = useCallback(() => {
    setUiVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setUiVisible(false), 3000);
  }, []);

  useEffect(() => {
    showUi();
    const onMove = () => showUi();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchstart", onMove);
    window.addEventListener("keydown", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchstart", onMove);
      window.removeEventListener("keydown", onMove);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [showUi]);

  // Fullscreen tracking
  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFs = async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen().catch(() => {});
    } else {
      await document.exitFullscreen().catch(() => {});
    }
  };

  const handleSend = useCallback(
    async (text: string) => {
      if (!settings.apiKey) {
        toast.error("Add your OpenRouter API key in Settings to chat.");
        setSettingsOpen(true);
        return;
      }
      setBusy(true);
      const newHist: ChatMsg[] = [...history, { role: "user", content: text }];
      setHistory(newHist);
      try {
        const reply = await chatWithAI(settings.apiKey, newHist);
        setHistory((h) => [...h, { role: "assistant", content: reply }]);
        const emo = sentimentEmotion(reply);
        if (emo === "happy") handleRef.current?.triggerHappy();
        showSubtitle(reply);
        void handleRef.current?.speak(reply);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(msg);
        showSubtitle(`⚠️ ${msg}`, 5000);
      } finally {
        setBusy(false);
      }
    },
    [history, settings.apiKey, showSubtitle],
  );

  const bgStyle = useMemo(() => {
    if (settings.background.startsWith("color:")) {
      return { backgroundColor: settings.background.slice("color:".length) };
    }
    return {
      backgroundImage: `url(${settings.background})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  }, [settings.background]);

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground" style={bgStyle}>
      {/* subtle vignette */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.55)_100%)]" />

      {/* 3D stage */}
      <WaifuStage settings={settings} modelUrl={modelUrl} handleRef={handleRef} onStatus={setStatus} />

      {/* Top-right controls */}
      <AnimatePresence>
        {uiVisible && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="absolute right-4 top-4 z-30 flex items-center gap-2"
          >
            <span className="rounded-full bg-card/70 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
              {status}
            </span>
            <Button variant="secondary" size="icon" onClick={toggleFs} aria-label="Toggle fullscreen" className="rounded-full">
              {isFs ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
            <Button variant="secondary" size="icon" onClick={() => setSettingsOpen(true)} aria-label="Open settings" className="rounded-full">
              <SettingsIcon className="h-4 w-4" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Subtitle (AI reply shown like a movie subtitle) */}
      <AnimatePresence>
        {subtitle && (
          <motion.div
            key={subtitle}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.25 }}
            className="pointer-events-none absolute bottom-28 left-1/2 z-20 w-[90%] max-w-3xl -translate-x-1/2 text-center"
          >
            <p className="inline-block rounded-xl bg-black/60 px-5 py-2.5 text-base sm:text-lg font-medium leading-snug text-white shadow-2xl backdrop-blur-md [text-shadow:_0_2px_4px_rgba(0,0,0,0.8)]">
              {subtitle}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom chat bar */}
      <AnimatePresence>
        {uiVisible && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-6 left-1/2 z-30 w-[92%] -translate-x-1/2 flex justify-center"
          >
            <ChatBar onSend={handleSend} busy={busy} />
          </motion.div>
        )}
      </AnimatePresence>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
      />

      <Toaster />

      <h1 className="sr-only">AI Anime Waifu Live Wallpaper</h1>
    </div>
  );
}
