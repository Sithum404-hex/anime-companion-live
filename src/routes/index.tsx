import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Eye, EyeOff, Maximize2, Minimize2, ScanEye, Settings as SettingsIcon } from "lucide-react";

import { WaifuStage, type WaifuHandle } from "@/waifu/WaifuStage";
import { SettingsPanel } from "@/waifu/SettingsPanel";
import { ChatBar } from "@/waifu/ChatBar";
import { usePushToTalk } from "@/waifu/usePushToTalk";
import { isEditableTarget, shouldCaptureFromEditable } from "@/waifu/voiceInput";
import { ModeSelector, LiveControl, type AppMode } from "@/waifu/LiveControl";
import { Transcript, type TranscriptLine } from "@/waifu/Transcript";
import { accentForEmotion, hudVars } from "@/waifu/hudTheme";
import { cn } from "@/lib/utils";
import { SakuraPetals } from "@/waifu/SakuraParticles";
import { LiveModeController, type LiveStatus } from "@/waifu/liveMode";
import {
  DEFAULT_SETTINGS,
  type Settings,
  type ModelManifest,
  type WardrobeManifest,
} from "@/waifu/types";
import { chatWithAI, sentimentEmotion, type ChatMsg } from "@/waifu/aiEngine";
import { getAiState, setScreenContext, addScreenHistory } from "@/systems/aiSystem";
import { ScreenVisionService, type ScreenAnalysisResult } from "@/waifu/screenVision";
import { useAuth } from "@/lib/auth";
import { AudioPlayerManager } from "@/systems/audioPlayer";
import { prefetchSpeech } from "@/systems/ttsSystem";
import { storageBridge } from "@/lib/storageBridge";
import { loadModelManifest, loadWardrobeManifest } from "@/lib/manifests";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "AI Anime Waifu — Live Wallpaper" },
      {
        name: "description",
        content:
          "An interactive 3D anime character that talks, listens, and reacts — runs entirely in your browser.",
      },
    ],
  }),
});

const CATEGORY_TO_EMOTION: Record<string, string> = {
  work: "nervous",
  entertainment: "happy",
  learning: "nervous",
  social: "happy",
  productivity: "nervous",
  browsing: "nervous",
};

const CHAT_HISTORY_KEY = "waifu.chatHistory.v2";
const MAX_PERSISTED_MESSAGES = 100;
/** Visible chat log entries older than this are dropped automatically. */
const CHAT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const THINKING_LABELS = ["Thinking…", "Hmm, one sec…", "Let me think…", "Ooh, hold on…"];

const pickThinkingLabel = () => THINKING_LABELS[Math.floor(Math.random() * THINKING_LABELS.length)];

function friendlyError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("quota")) {
    return "She's being rate-limited right now. Give it a few seconds and try again.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "She took too long to answer. Try again?";
  }
  if (lower.includes("network") || lower.includes("fetch")) {
    return "Couldn't reach the chat service. Check your connection and try again.";
  }
  if (lower.includes("brain")) {
    return "She couldn't reach her language model. Check the API key, then try again.";
  }
  if (lower.includes("auth") || lower.includes("api key") || lower.includes("key")) {
    return "The chat service needs a fresh API key.";
  }
  return msg;
}

function Index() {
  const { profile, user, mode: authMode } = useAuth();
  const username = profile?.username || user?.email?.split("@")[0] || "Partner";
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Loading…");
  const [isFs, setIsFs] = useState(false);
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [subtitle, setSubtitle] = useState<string>("");
  const [manifest, setManifest] = useState<ModelManifest | null>(null);
  const [wardrobe, setWardrobe] = useState<WardrobeManifest | null>(null);
  const [screenVisionSharing, setScreenVisionSharing] = useState(false);
  const [screenVisionAnalyzing, setScreenVisionAnalyzing] = useState(false);
  /** True from the moment Screen mode is chosen until capture is live (or refused). */
  const [screenStartPending, setScreenStartPending] = useState(false);
  const [audioPlayer, setAudioPlayerState] = useState<AudioPlayerManager | null>(null);
  /** Bumped by WaifuStage each time a fresh character controller is live. */
  const [stageVersion, setStageVersion] = useState(0);
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [nowPlaying, setNowPlaying] = useState("");
  const [pttPartial, setPttPartial] = useState("");
  /** App interaction mode. */
  const [mode, setMode] = useState<AppMode>("chat");
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [livePttHeld, setLivePttHeld] = useState(false);

  /** True wallpaper mode: hides the entire console (press H to bring it back). */
  const [hudHidden, setHudHidden] = useState(false);
  const [transcriptCollapsed, setTranscriptCollapsed] = useState(false);
  /** Inline chat failure — stays in the transcript instead of flashing a toast. */
  const [chatError, setChatError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  /** Her current mood — drives the one accent colour in the whole UI. */
  const [mood, setMood] = useState<string>("neutral");

  const handleRef = useRef<WaifuHandle | null>(null);
  const subtitleTimer = useRef<number | null>(null);
  const busyRef = useRef(false);
  const pendingRef = useRef<{ text: string }[]>([]);
  const screenVisionRef = useRef<ScreenVisionService | null>(null);
  const settingsRef = useRef(settings);
  const historyRef = useRef(history);
  const lastScreenCategoryRef = useRef("");
  const lastScreenCommentRef = useRef(0);
  const lastScreenAnalysisRef = useRef<ScreenAnalysisResult | null>(null);
  const lastVisionErrorToastRef = useRef(0);
  const triggerScreenCommentRef = useRef<((summary: string) => Promise<void>) | null>(null);
  const screenShareDanceRef = useRef(false);
  const isMusicPlayingRef = useRef(false);
  const liveControllerRef = useRef<LiveModeController | null>(null);

  busyRef.current = busy;
  settingsRef.current = settings;
  historyRef.current = history;
  isMusicPlayingRef.current = isMusicPlaying;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const usernameRef = useRef(username);
  usernameRef.current = username;

  const showSubtitle = useCallback((text: string, ms?: number) => {
    setSubtitle(text);
    if (subtitleTimer.current) window.clearTimeout(subtitleTimer.current);
    const duration = ms ?? Math.min(8000, 2500 + text.length * 40);
    subtitleTimer.current = window.setTimeout(() => setSubtitle(""), duration);
  }, []);

  useEffect(() => {
    storageBridge.loadSettings().then((s) => {
      setSettings(s);
      setHydrated(true);
    });
  }, []);

  // Restore the visible chat history. Guests read localStorage; authenticated
  // users also pull their server-side rows so history follows them across
  // devices. Local data remains the offline fallback.
  useEffect(() => {
    let cancelled = false;
    try {
      const raw = localStorage.getItem(CHAT_HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const now = Date.now();
          const valid = parsed.filter(
            (m): m is ChatMsg =>
              !!m &&
              typeof m.content === "string" &&
              (m.role === "user" || m.role === "assistant") &&
              (!m.ts || now - m.ts <= CHAT_TTL_MS),
          );
          if (valid.length > 0) setHistory(valid);
        }
      }
    } catch {
      /* ignore corrupt history */
    }

    if (authMode === "authenticated") {
      void storageBridge.loadMessages().then((remote) => {
        if (!cancelled && remote.length > 0) setHistory(remote);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [authMode]);

  useEffect(() => {
    if (history.length === 0) return;
    try {
      localStorage.setItem(
        CHAT_HISTORY_KEY,
        JSON.stringify(history.slice(-MAX_PERSISTED_MESSAGES)),
      );
    } catch {
      /* storage full — ignore */
    }
  }, [history]);

  // Auto-expire chat log entries after CHAT_TTL_MS even while the tab stays open.
  useEffect(() => {
    const t = window.setInterval(() => {
      setHistory((h) => {
        const now = Date.now();
        const fresh = h.filter((m) => !m.ts || now - m.ts <= CHAT_TTL_MS);
        return fresh.length === h.length ? h : fresh;
      });
    }, 60_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    storageBridge.saveSettings(settings);
  }, [settings, hydrated]);

  // One-time welcome when the character finishes loading — a small alive
  // moment instead of a silent screen. Animation-only unless voice is on.
  const greetedRef = useRef(false);
  useEffect(() => {
    if (status !== "Ready" || greetedRef.current) return;
    greetedRef.current = true;
    const hour = new Date().getHours();
    const greeting =
      hour < 5
        ? "You're up late… hehe, welcome back."
        : hour < 12
          ? "Good morning! I was waiting for you."
          : hour < 18
            ? "Welcome back! Missed me?"
            : "Good evening — perfect timing, actually.";
    showSubtitle(greeting);
    handleRef.current?.onGreeting();
    if (settings.voiceEnabled) {
      handleRef.current?.speak(greeting, "happy").catch(() => {});
    }
    // Runs once per page load as soon as the model reports Ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    loadModelManifest().then((data) => {
      if (!cancelled) setManifest(data);
    });
    loadWardrobeManifest().then((data) => {
      if (!cancelled) setWardrobe(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const modelUrl = useMemo(() => {
    // Wardrobe outfit takes priority: look up outfitId in wardrobe manifest
    if (wardrobe && settings.outfitId) {
      let match = wardrobe.outfits.find((o) => o.id === settings.outfitId);
      // Graceful fallback: if saved outfitId doesn't exist, use manifest default
      if (!match && wardrobe.defaultOutfit) {
        match = wardrobe.outfits.find((o) => o.id === wardrobe.defaultOutfit);
      }
      if (match?.file) {
        console.log(`[Wardrobe] outfit="${match.id}" → ${match.file}`);
        return match.file.trim();
      }
    }
    // Fall back to legacy model manifest
    if (!manifest) return "/models/waifu.vrm";
    const m = manifest.models.find((x) => x.id === settings.modelId) ?? manifest.models[0];
    const file = m?.file?.trim() ?? "/models/waifu.vrm";
    return file;
  }, [manifest, wardrobe, settings.modelId, settings.outfitId]);

  // ── Audio Player ──────────────────────────────────────────

  useEffect(() => {
    const ap = new AudioPlayerManager();
    setAudioPlayerState(ap);
    return () => {
      ap.dispose();
      setAudioPlayerState(null);
    };
  }, []);

  useEffect(() => {
    // Re-applies whenever the audio player OR the character controller is
    // (re)created. The controller is built asynchronously after the VRM
    // loads, so a mount-time-only call attached to nothing and beat/energy
    // analysis never reached the dance director.
    handleRef.current?.setAudioPlayer(audioPlayer);
  }, [audioPlayer, stageVersion]);

  useEffect(() => {
    if (!audioPlayer) return;
    audioPlayer.onPlayStateChange = (playing) => {
      setIsMusicPlaying(playing);
      const s = settingsRef.current;
      const shouldDance = playing && s.musicPlayerEnabled && s.danceSyncEnabled;
      if (shouldDance) {
        handleRef.current?.startDance();
      } else if (!playing && !screenShareDanceRef.current) {
        handleRef.current?.stopDance();
      }
    };
    audioPlayer.onTrackChange = (name) => {
      setNowPlaying(name);
    };
  }, [audioPlayer]);

  useEffect(() => {
    // Turning the music player OFF must stop audible playback too — the
    // controls unmount with the toggle, leaving no other way to pause.
    if (!settings.musicPlayerEnabled && isMusicPlayingRef.current) {
      audioPlayer?.pause();
    }
  }, [settings.musicPlayerEnabled, audioPlayer]);

  useEffect(() => {
    if (!handleRef.current) return;
    const shouldDance =
      settings.musicPlayerEnabled && settings.danceSyncEnabled && isMusicPlayingRef.current;
    if (shouldDance) {
      handleRef.current.startDance();
    } else if (!settings.musicPlayerEnabled || !settings.danceSyncEnabled) {
      if (!screenShareDanceRef.current) {
        handleRef.current.stopDance();
      }
    }
  }, [settings.musicPlayerEnabled, settings.danceSyncEnabled]);

  useEffect(() => {
    if (!handleRef.current) return;
    if (!settings.screenVisionDanceEnabled && screenShareDanceRef.current) {
      screenShareDanceRef.current = false;
      if (!isMusicPlayingRef.current) {
        handleRef.current.stopDance();
      }
    }
  }, [settings.screenVisionDanceEnabled]);

  // ── Screen Vision Service ─────────────────────────────────

  useEffect(() => {
    const sv = new ScreenVisionService();
    sv.loadState();
    screenVisionRef.current = sv;

    sv.setOnStatus((s) => {
      if (
        s.includes("active") ||
        s.includes("stopped") ||
        s.includes("denied") ||
        s.includes("failed") ||
        s.includes("error")
      ) {
        setScreenVisionAnalyzing(false);
      }
      if (s.includes("Analyzing")) {
        setScreenVisionAnalyzing(true);
      }
      // Repeated analysis failures stay quiet in the UI — toast at most once
      // a minute so the user learns WHY vision is silent (rate limit, key…).
      if (s.startsWith("Screen analysis failed")) {
        const now = Date.now();
        if (now - lastVisionErrorToastRef.current > 60_000) {
          lastVisionErrorToastRef.current = now;
          toast.error(s.replace("Screen analysis failed:", "Screen Vision:"));
        }
      }
      if (s.includes("stopped") || s.includes("denied")) {
        setScreenVisionSharing(false);
        setScreenContext(null);
        if (screenShareDanceRef.current && !isMusicPlayingRef.current) {
          screenShareDanceRef.current = false;
          handleRef.current?.stopDance();
        } else {
          screenShareDanceRef.current = false;
        }
      }
    });

    sv.onResult((result) => {
      if (result.summary) {
        const prev = lastScreenAnalysisRef.current;
        const isUnchanged =
          prev &&
          prev.summary === result.summary &&
          prev.screenType === result.screenType &&
          prev.category === result.category;
        lastScreenAnalysisRef.current = result;

        addScreenHistory({
          summary: result.summary,
          screenType: result.screenType,
          category: result.category,
        });

        setScreenContext(result.summary);

        const categoryChanged =
          result.category && result.category !== lastScreenCategoryRef.current;
        const cooldownOk = Date.now() - lastScreenCommentRef.current > 30000;

        if (result.category) {
          lastScreenCategoryRef.current = result.category;
        }

        // Suppress auto-comment if it looks like a music/video session
        const isPassiveMedia =
          result.category === "entertainment" &&
          (result.screenType === "video" ||
            result.screenType === "music" ||
            result.screenType === "other");

        if (
          !isUnchanged &&
          categoryChanged &&
          cooldownOk &&
          !busyRef.current &&
          !screenShareDanceRef.current &&
          !isPassiveMedia
        ) {
          lastScreenCommentRef.current = Date.now();
          triggerScreenCommentRef.current?.(result.summary);
        }

        // Screen-share-driven dancing — music/video content
        if (settingsRef.current.screenVisionDanceEnabled && !screenShareDanceRef.current) {
          if (result.category === "entertainment") {
            screenShareDanceRef.current = true;
            if (!isMusicPlayingRef.current) {
              handleRef.current?.startDance();
            }
          }
        }

        // Don't trigger expressions/emotions during passive media playback
        if (!isPassiveMedia) {
          const emotion = CATEGORY_TO_EMOTION[result.category] || "nervous";
          handleRef.current?.onUserMessage();
          handleRef.current?.onAIResponse(emotion, 0.5);
        }
      }
    });

    return () => {
      sv.dispose();
      screenVisionRef.current = null;
      setScreenVisionSharing(false);
      setScreenContext(null);
    };
  }, []);

  useEffect(() => {
    const sv = screenVisionRef.current;
    if (!sv) return;

    if (settings.screenVisionEnabled && !sv.enabled) {
      sv.start()
        .then(() => {
          setScreenVisionSharing(true);
        })
        .catch((err) => {
          setSettings((s) => ({ ...s, screenVisionEnabled: false }));
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Permission") && !msg.includes("cancel") && !msg.includes("Cancel")) {
            toast.error(`Screen Vision: ${msg}`);
          }
        });
    } else if (!settings.screenVisionEnabled && sv.enabled) {
      sv.stop();
      setScreenVisionSharing(false);
      setScreenContext(null);
    }
  }, [settings.screenVisionEnabled]);

  useEffect(() => {
    const sv = screenVisionRef.current;
    if (!sv) return;

    sv.setAutoAnalyze(settings.autoAnalyzeScreen);
  }, [settings.autoAnalyzeScreen]);

  useEffect(() => {
    const sv = screenVisionRef.current;
    if (!sv) return;

    sv.setAnalysisInterval(settings.screenAnalysisInterval * 1000);
  }, [settings.screenAnalysisInterval]);

  const stopScreenSharing = useCallback(() => {
    const sv = screenVisionRef.current;
    if (sv) {
      sv.stop();
    }
    setScreenVisionSharing(false);
    setScreenContext(null);
    setSettings((s) => ({ ...s, screenVisionEnabled: false }));
    // Sharing can also end from the Settings panel or the browser's own
    // "Stop sharing" button, so the mode has to follow reality — otherwise the
    // pill keeps claiming "Screen" while nothing is being captured.
    setMode((m) => (m === "screen" ? "chat" : m));
  }, []);

  const analyzeNow = useCallback(async () => {
    const sv = screenVisionRef.current;
    if (!sv || !sv.sharing || sv.analyzing) return;
    setScreenVisionAnalyzing(true);
    const result = await sv.analyze();
    if (!result) {
      setScreenVisionAnalyzing(false);
    }
  }, []);

  const triggerScreenComment = useCallback(
    async (summary: string) => {
      if (busyRef.current) return;
      setBusy(true);
      busyRef.current = true;
      showSubtitle(pickThinkingLabel(), 10000);

      const currentHistory = historyRef.current;
      const triggerText = `[I noticed what's on your screen right now] — ${summary}. Make a brief natural comment about what they're doing. Keep it 5-15 words.`;

      try {
        const ai = await chatWithAI(
          [...currentHistory, { role: "user", content: triggerText }],
          username,
          settings.relationshipMode,
        );
        const reply = ai.response;
        const aiState = getAiState();
        const voiceEmotion = aiState?.emotion ?? sentimentEmotion(reply);
        if (aiState?.emotion) setMood(aiState.emotion);

        if (settings.voiceEnabled) {
          // Synthesis overlaps the UI/animation update; speak() reuses this
          // cached in-flight request and does not send a second TTS call.
          prefetchSpeech(reply, { emotion: voiceEmotion });
        }

        const assistantMsg: ChatMsg = { role: "assistant", content: reply, ts: Date.now() };
        historyRef.current = [...historyRef.current, assistantMsg];
        setHistory(historyRef.current);
        void storageBridge.saveMessage(assistantMsg);

        handleRef.current?.onUserMessage();
        handleRef.current?.onAiAnimationIntent(ai.animation ?? null);
        if (aiState) {
          handleRef.current?.onAIResponse(aiState.emotion, 0.7);
        }

        showSubtitle(reply);
        if (settingsRef.current.voiceEnabled) {
          handleRef.current?.speak(reply, voiceEmotion).catch(() => {});
        }
      } catch (e) {
        console.warn("[ScreenVision] Auto-comment failed:", e);
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [showSubtitle, username, settings.relationshipMode, settings.voiceEnabled],
  );

  triggerScreenCommentRef.current = triggerScreenComment;

  // ── End Screen Vision ─────────────────────────────────────

  // H toggles true wallpaper mode, Escape brings the console back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (isEditableTarget(e.target)) return;
      if (e.key === "h" || e.key === "H") setHudHidden((v) => !v);
      else if (e.key === "Escape") setHudHidden(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFs = useCallback(async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen().catch(() => {});
    } else {
      await document.exitFullscreen().catch(() => {});
    }
  }, []);

  const runChatTurn = useCallback(
    async (userMsg: ChatMsg) => {
      setBusy(true);
      busyRef.current = true;
      setChatError(null);
      showSubtitle(pickThinkingLabel(), 10000);
      try {
        await storageBridge.saveMessage(userMsg);
      } catch (e) {
        console.warn("[Chat] Could not persist message — local only:", e);
      }

      // Start the behavioral generation clock at the same moment the request
      // begins. This is what makes Thinking contingent on an actually slow
      // response instead of playing for every turn.
      handleRef.current?.onUserMessage(userMsg.content);

      // Pre-warm TTS AudioContext within the user gesture (before await)
      if (settings.voiceEnabled) {
        handleRef.current?.prewarmAudio();
      }

      try {
        // historyRef already contains this turn's user message.
        const ai = await chatWithAI(historyRef.current, username, settings.relationshipMode);
        const reply = ai.response;
        const aiState = getAiState();
        const voiceEmotion = aiState?.emotion ?? sentimentEmotion(reply);
        if (aiState?.emotion) setMood(aiState.emotion);

        if (settings.voiceEnabled) {
          // Start synthesis before the UI state/animation work below.
          prefetchSpeech(reply, { emotion: voiceEmotion });
        }

        const assistantMsg: ChatMsg = { role: "assistant", content: reply, ts: Date.now() };
        historyRef.current = [...historyRef.current, assistantMsg];
        setHistory(historyRef.current);
        storageBridge.saveMessage(assistantMsg);

        handleRef.current?.onAiAnimationIntent(ai.animation ?? null);
        if (aiState) {
          handleRef.current?.onAIResponse(aiState.emotion, 0.7, reply);
          storageBridge.saveFriendship(aiState);
        } else {
          handleRef.current?.onAIResponse(voiceEmotion, 0.5, reply);
        }

        showSubtitle(reply);
        if (settings.voiceEnabled) {
          handleRef.current?.speak(reply, voiceEmotion).catch((speakError) => {
            console.warn("[Voice] TTS failed:", speakError);
          });
        }
      } catch (e) {
        handleRef.current?.onAiGenerationFailed();
        const msg = friendlyError(e instanceof Error ? e.message : String(e));
        // Persistent row in the transcript — a toast that vanishes in 4s left
        // the user with no idea the message had failed at all.
        setChatError(msg);
        showSubtitle("", 1);
      } finally {
        setBusy(false);
        busyRef.current = false;
        const next = pendingRef.current.shift();
        if (next) {
          const queuedMsg: ChatMsg = { role: "user", content: next.text, ts: Date.now() };
          historyRef.current = [...historyRef.current, queuedMsg];
          setHistory(historyRef.current);
          void runChatTurn(queuedMsg);
        }
      }
    },
    [showSubtitle, settings.voiceEnabled, username, settings.relationshipMode],
  );

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) return;

      // Show the user message immediately — even while a turn is in flight —
      // then queue the request so every user message gets its own response.
      const userMsg: ChatMsg = { role: "user", content: trimmed, ts: Date.now() };
      const nextHistory = [...historyRef.current, userMsg];
      historyRef.current = nextHistory;
      setHistory(nextHistory);

      if (busyRef.current) {
        pendingRef.current.push({ text: trimmed });
        return;
      }

      await runChatTurn(userMsg);
    },
    [runChatTurn],
  );

  const { listening: pttListening } = usePushToTalk({
    // Disabled entirely while Live mode is active — Live owns the PTT key and
    // the mic; letting both hooks react would open two competing audio paths.
    enabled: settings.pushToTalkEnabled && hydrated && mode !== "live",
    keyCode: settings.pushToTalkKey,
    busy,
    onSend: handleSend,
    onListeningChange: (active) => {
      handleRef.current?.setListening(active);
      if (!active) setPttPartial("");
    },
    onPartial: setPttPartial,
    onError: (msg) => {
      // Surface in the dock, not as a toast — and not with alert().
      if (msg.includes("not-allowed") || msg.includes("permission")) {
        setMicError("She can't hear you — the browser blocked microphone access for this site.");
      } else if (msg !== "no-speech") {
        setMicError(`Voice input: ${msg}`);
      }
    },
  });

  /**
   * Entering/leaving a mode reconciles the Screen Vision toggle with the mode
   * selection. "screen" is now a real destination: choosing it starts sharing
   * (and choosing anything else stops it) instead of being a dead button.
   */
  const changeMode = useCallback((next: AppMode) => {
    if (next === "screen") {
      // Mark the request before flipping the toggle so the "not sharing yet"
      // reconciliation below doesn't bounce straight back to Chat while the
      // browser's screen-picker is still open.
      setScreenStartPending(true);
      setSettings((s) => (s.screenVisionEnabled ? s : { ...s, screenVisionEnabled: true }));
    } else {
      setScreenStartPending(false);
      setSettings((s) => (s.screenVisionEnabled ? { ...s, screenVisionEnabled: false } : s));
    }
    setMode(next);
  }, []);

  // Screen Vision ended on its own (track stopped, permission denied, service
  // failure) while Screen mode is selected → fall back to Chat instead of
  // leaving the user on a mode that no longer does anything.
  useEffect(() => {
    if (mode === "screen" && !screenVisionSharing && !screenStartPending && hydrated) {
      changeMode("chat");
    }
  }, [mode, screenVisionSharing, screenStartPending, hydrated, changeMode]);

  // Clear the pending flag as soon as capture is live (or has definitively
  // failed and turned the toggle back off).
  useEffect(() => {
    if (screenVisionSharing) setScreenStartPending(false);
  }, [screenVisionSharing]);
  useEffect(() => {
    if (hydrated && screenStartPending && !settings.screenVisionEnabled) {
      setScreenStartPending(false); // start() rejected → the toggle was rolled back
    }
  }, [hydrated, screenStartPending, settings.screenVisionEnabled]);

  // ── LIVE mode (Gemini Live + Soundcast voice) ────────────

  // Create the Live controller once; its deps read via refs so callbacks stay
  // stable. dispose() tears down the Gemini session, media, timers and status.
  useEffect(() => {
    const controller = new LiveModeController({
      username: "",
      onStatus: setLiveStatus,
      speak: async (text, emotion) => {
        // EXISTING Soundcast pipeline — same voice, same lip-sync.
        await handleRef.current?.speak(text, emotion);
      },
      // Warm the Soundcast cache for the next sentence while the current one
      // plays, so Live replies stream out sentence by sentence without each
      // sentence paying full synthesis latency. Options mirror the speak path
      // exactly (pitch/rate are part of the cache key) to guarantee a hit.
      prefetch: (text, emotion) => {
        prefetchSpeech(text, { pitch: 1.0, rate: 1.0, emotion });
      },
      cancelSpeech: () => {
        handleRef.current?.cancelSpeech();
      },
      onListeningChange: (active) => {
        setLivePttHeld(active);
        handleRef.current?.setListening(active);
      },
      onUserMessage: () => {
        handleRef.current?.onUserMessage();
      },
      onAIResponse: (emotion) => {
        handleRef.current?.onAIResponse(emotion, 0.7);
      },
      // [emotion] tags from Gemini drive her VRM body animation through the
      // exact same registry-validated path chat mode uses.
      onAnimationIntent: (intent) => {
        handleRef.current?.onAiAnimationIntent(intent);
      },
    });
    liveControllerRef.current = controller;
    return () => {
      controller.dispose();
      liveControllerRef.current = null;
      setLiveStatus(null);
      setLivePttHeld(false);
    };
  }, []);

  useEffect(() => {
    const controller = liveControllerRef.current;
    if (controller) controller.setUsername(username);
  }, [username]);

  // Enter/exit Live mode. Screen Vision is reconciled by changeMode(), which
  // owns the toggle for every mode transition — the two features never share
  // a stream (Live uses the webcam, Screen Vision the display).
  const prevModeRef = useRef<AppMode>("chat");
  useEffect(() => {
    const entering = mode === "live" && prevModeRef.current !== "live";
    const leaving = mode !== "live" && prevModeRef.current === "live";
    prevModeRef.current = mode;
    const controller = liveControllerRef.current;
    if (!controller) return;

    if (entering) {
      controller.setUsername(usernameRef.current);
      void controller.enterLiveMode();
    }
    if (leaving) {
      controller.exitLiveMode();
    }
  }, [mode]);

  // Her Live-mode [emotion] tag drives the console accent too.
  useEffect(() => {
    if (mode === "live" && liveStatus?.emotion) setMood(liveStatus.emotion);
  }, [mode, liveStatus?.emotion]);

  // Safety: leaving the page mid-hold must not leak the mic/camera.
  useEffect(() => {
    const onUnload = () => liveControllerRef.current?.dispose();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const livePressStart = useCallback(() => {
    void liveControllerRef.current?.startListening();
  }, []);
  const livePressEnd = useCallback(() => {
    void liveControllerRef.current?.stopListening();
  }, []);

  // Live-mode keyboard PTT — keydown starts, keyup stops, auto-repeat and
  // text fields are ignored, page scrolling is prevented while held.
  useEffect(() => {
    if (mode !== "live") return;
    const keyCode = settingsRef.current.pushToTalkKey || "Space";
    let held = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== keyCode || e.repeat) return;
      if (isEditableTarget(e.target) && !shouldCaptureFromEditable(e.target)) return;
      if (held) return;
      e.preventDefault(); // keep Space from scrolling the page
      if (isEditableTarget(e.target)) (e.target as HTMLElement).blur();
      held = true;
      livePressStart();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== keyCode) return;
      if (!held) return;
      e.preventDefault();
      held = false;
      livePressEnd();
    };
    const onBlur = () => {
      if (!held) return;
      held = false;
      liveControllerRef.current?.cancelListening();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      if (held) {
        held = false;
        liveControllerRef.current?.cancelListening();
      }
    };
  }, [mode, livePressStart, livePressEnd]);

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

  // The single expression element in the UI: every accent follows her mood.
  const rootStyle = useMemo(
    () => ({ ...bgStyle, ...hudVars(accentForEmotion(mood)) }) as React.CSSProperties,
    [bgStyle, mood],
  );

  /** What she is called, taken from the wardrobe/manifest instead of hardcoded. */
  const charName = useMemo(() => {
    const wardrobeLabel = wardrobe?.characterLabel?.trim();
    if (wardrobeLabel) return wardrobeLabel;
    const model = manifest?.models.find((m) => m.id === settings.modelId) ?? manifest?.models[0];
    return model?.label?.trim() || "Youki";
  }, [wardrobe, manifest, settings.modelId]);

  const charInitial = charName.charAt(0).toUpperCase();
  const moodLabel = mood === "neutral" ? "quietly here" : `feeling ${mood.replace(/_/g, " ")}`;
  const statusTone =
    status === "Ready"
      ? "bg-[var(--hud-accent)] shadow-[0_0_7px_var(--hud-accent)]"
      : status.startsWith("Error") || status.startsWith("Failed")
        ? "bg-red-400"
        : "animate-pulse bg-amber-400";

  /** Transcript rows are derived so ids stay stable while the log re-renders. */
  const transcriptLines = useMemo<TranscriptLine[]>(
    () =>
      history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m, i) => ({
          id: `${m.ts ?? 0}-${i}`,
          role: m.role as "user" | "assistant",
          content: m.content,
          ts: m.ts ?? Date.now(),
        })),
    [history],
  );

  return (
    <div
      className="glass-ui relative min-h-screen w-full overflow-hidden text-foreground"
      style={rootStyle}
    >
      {/* Vignette only — it exists to seat the console against the stage, not to decorate. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.6)_100%)]" />

      <WaifuStage
        settings={settings}
        modelUrl={modelUrl}
        handleRef={handleRef}
        onStatus={setStatus}
        audioPlayer={audioPlayer}
        onControllerReady={() => setStageVersion((v) => v + 1)}
      />

      {/* Blossoms drifting in front of the scene. Pure CSS, so it costs the
          Three.js loop nothing. */}
      <SakuraPetals />

      {/* ── Console ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {!hudHidden && (
          <>
            {/* One left-hand column: modes, then conversation. Keeping the
                switcher here (instead of dead-centre above her head) leaves
                the top of the frame to the character. */}
            <motion.div
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.2 }}
              className="pointer-events-auto absolute left-4 top-4 z-30 flex flex-col items-start gap-2.5"
            >
              <ModeSelector mode={mode} onChange={changeMode} />
              <Transcript
                lines={transcriptLines}
                busy={busy}
                error={chatError}
                onClearError={() => setChatError(null)}
                collapsed={transcriptCollapsed}
                onToggleCollapsed={() => setTranscriptCollapsed((v) => !v)}
              />
            </motion.div>

            {/* Utility capsule. One object instead of three floating buttons:
                the console only has one corner of quiet chrome. */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="pointer-events-auto absolute right-4 top-4 z-30"
            >
              <div className="glass glass--chip flex items-center gap-0.5 p-1">
                <ToolButton label="Toggle fullscreen" onClick={toggleFs} className="hidden sm:grid">
                  {isFs ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </ToolButton>
                <span aria-hidden className="mx-0.5 hidden h-4 w-px bg-white/10 sm:block" />
                <ToolButton label="Hide interface (H)" onClick={() => setHudHidden(true)}>
                  <EyeOff className="h-4 w-4" />
                </ToolButton>
                <span aria-hidden className="mx-0.5 h-4 w-px bg-white/10" />
                <ToolButton label="Open settings" onClick={() => setSettingsOpen(true)}>
                  <SettingsIcon className="h-4 w-4" />
                </ToolButton>
              </div>
            </motion.div>

            {/* Transcript — persistent, collapsible, never auto-hides. */}

            {/* Her voice. One subtitle system for every mode — Live used to
                draw its own competing transcript above the dock. */}
            <AnimatePresence>
              {subtitle && (
                <motion.div
                  key={subtitle}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.22 }}
                  className="pointer-events-none absolute bottom-[9.75rem] left-1/2 z-20 w-[min(92%,40rem)] -translate-x-1/2 text-center"
                >
                  <p className="voice-display inline-block max-w-[46ch] rounded-2xl border border-white/[0.07] bg-[#080b14]/78 px-4 py-2.5 text-[15px] leading-relaxed text-white/95 shadow-[0_10px_44px_-14px_rgba(0,0,0,0.95)] backdrop-blur-xl">
                    {subtitle}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Dock — one shell for chat and Live, so a mode change swaps what
                the surface does rather than making it look like another app.
                The header makes the dock a small console rather than a floating
                text field: who she is, how she feels, and whether the model and
                screen link are live all live in one quiet line. */}
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 14 }}
              transition={{ duration: 0.2 }}
              className="pointer-events-auto absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-1/2 z-30 w-[min(94%,32rem)] -translate-x-1/2"
            >
              <div className="glass glass-sheen rounded-[1.75rem] px-3.5 pb-3 pt-2.5">
                <header className="mb-2.5 flex items-center gap-2.5 border-b border-white/[0.06] pb-2.5">
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full border"
                    style={{
                      borderColor:
                        "color-mix(in oklab, var(--hud-accent) 44%, rgba(255,255,255,0.08))",
                      backgroundColor:
                        "color-mix(in oklab, var(--hud-accent) 15%, rgba(255,255,255,0.03))",
                      boxShadow:
                        "inset 0 1px 0 rgba(255,255,255,0.16), 0 0 18px -9px var(--hud-accent)",
                    }}
                    aria-hidden
                  >
                    <span className="voice-display text-[13px] leading-none text-[var(--hud-accent)]">
                      {charInitial}
                    </span>
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="voice-display truncate text-[14px] leading-tight text-white">
                      {charName}
                    </p>
                    <p className="truncate text-[10.5px] leading-tight text-white/45">
                      {moodLabel}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {screenVisionSharing && (
                      <button
                        type="button"
                        onClick={analyzeNow}
                        disabled={screenVisionAnalyzing}
                        title="Analyze my screen now"
                        className="focus-ring flex h-7 items-center gap-1.5 rounded-full bg-emerald-400/[0.09] px-2 text-[10.5px] font-medium text-emerald-100/80 ring-1 ring-inset ring-emerald-300/15 transition-colors hover:bg-emerald-400/[0.16] disabled:opacity-45"
                      >
                        <ScanEye
                          className={cn("h-3 w-3", screenVisionAnalyzing && "animate-pulse")}
                          aria-hidden
                        />
                        {screenVisionAnalyzing ? "Reading…" : "Read now"}
                      </button>
                    )}
                    {mode !== "live" && (
                      <span
                        title={`Model status: ${status}`}
                        className="flex items-center gap-1.5 pr-0.5 text-[10.5px] text-white/45"
                      >
                        <span
                          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusTone)}
                          aria-hidden
                        />
                        <span>{status}</span>
                      </span>
                    )}
                  </div>
                </header>

                {mode === "screen" && !screenVisionSharing && (
                  <p className="mb-2 flex items-start gap-1.5 px-1 text-[11px] leading-snug text-white/45">
                    <ScanEye className="mt-px h-3.5 w-3.5 shrink-0 text-white/30" aria-hidden />
                    Pick a window or screen to share. She'll comment on what you're doing.
                  </p>
                )}

                {mode === "live" ? (
                  liveStatus ? (
                    <LiveControl
                      status={liveStatus}
                      pttHeld={livePttHeld}
                      pttKey={settings.pushToTalkKey}
                      onPressStart={livePressStart}
                      onPressEnd={livePressEnd}
                    />
                  ) : (
                    <p className="py-1 text-center text-xs text-white/40">Opening the live link…</p>
                  )
                ) : (
                  <ChatBar
                    onSend={handleSend}
                    busy={busy}
                    peerName={charName}
                    pushToTalkEnabled={settings.pushToTalkEnabled}
                    pushToTalkKey={settings.pushToTalkKey}
                    pushToTalkListening={pttListening}
                    pushToTalkPartial={pttPartial}
                    micError={micError}
                    onDismissMicError={() => setMicError(null)}
                  />
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Keep the console reachable from true wallpaper mode. */}
      {hudHidden && (
        <button
          type="button"
          onClick={() => setHudHidden(false)}
          aria-label="Show controls"
          className="glass glass--chip glass-press focus-ring absolute bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] text-white/50 transition-colors hover:text-white/90"
        >
          <Eye className="h-3.5 w-3.5" aria-hidden />
          Show controls
          <kbd className="ml-0.5 rounded border border-white/10 bg-white/[0.06] px-1 py-0.5 font-mono text-[9px] leading-none text-white/40">
            H
          </kbd>
        </button>
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
        screenVisionSharing={screenVisionSharing}
        onStopSharing={stopScreenSharing}
        audioPlayer={audioPlayer}
        isMusicPlaying={isMusicPlaying}
        nowPlaying={nowPlaying}
      />

      <Toaster />

      <h1 className="sr-only">AI Anime Waifu Live Wallpaper</h1>
    </div>
  );
}

/** Square icon button used inside the utility capsule. */
function ToolButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "focus-ring grid h-9 w-9 place-items-center rounded-full text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white",
        className,
      )}
    >
      {children}
    </button>
  );
}
