import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { VRMAAnimationName } from "@/waifu/vrmAnimationLoader";
import { loadVRM, disposeVRM } from "@/waifu/vrmLoader";
import { WaifuCharacterController } from "@/waifu/WaifuCharacterController";
import { StageGestureCallbacks, StageGestureRecognizer } from "@/waifu/stageGestures";
import { RenderingController } from "@/waifu/controller/RenderingController";
import { EventBus } from "@/waifu/controller/EventBus";
import type { Settings } from "@/waifu/types";
import type { AudioPlayerManager } from "@/systems/audioPlayer";
import type { DanceDebugInfo } from "@/waifu/DanceDirector";
import { getQualitySettings, detectQualityTier } from "@/waifu/performance";
import { spawnHeartBurst } from "@/waifu/touchHeartFx";
import type { RawAiIntent } from "@/waifu/types";
import type { CharacterBehaviorDebugState } from "@/waifu/CharacterBehaviorEngine";

export interface WaifuHandle {
  speak: (text: string, emotion?: string) => Promise<void>;
  triggerHappy: () => void;
  playAnimation: (name: VRMAAnimationName) => Promise<void>;
  stopAnimation: () => void;
  onUserMessage: (text?: string) => void;
  onAIResponse: (emotion: string, intensity: number, response?: string) => void;
  onAiAnimationIntent: (intent: RawAiIntent | null) => void;
  onAiGenerationFailed: () => void;
  onGreeting: () => void;
  onSilence: () => void;
  setListening: (active: boolean) => void;
  setAudioPlayer: (ap: AudioPlayerManager | null) => void;
  startDance: () => void;
  stopDance: () => void;
  prewarmAudio: () => void;
  /** Immediately stop Soundcast playback + speaking animation (Live PTT interruption). */
  cancelSpeech: () => void;
  getAiAnimationDebug: () => CharacterBehaviorDebugState | null;
  onTwoFingerConfettiBurst: () => void;
  updateDanceCameraEnabled: (v: boolean) => void;
}

interface Props {
  settings: Settings;
  modelUrl: string;
  handleRef: { current: WaifuHandle | null };
  onStatus?: (s: string) => void;
  audioPlayer?: AudioPlayerManager | null;
  /**
   * Fired every time the character controller finishes (re)creating. Parents
   * must re-apply cross-cutting wiring (audio player, …) here — the old
   * mount-time-only effects ran before the async VRM load completed and
   * silently never attached.
   */
  onControllerReady?: () => void;
}

export function WaifuStage({
  settings,
  modelUrl,
  handleRef,
  onStatus,
  audioPlayer,
  onControllerReady,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const audioPlayerRef = useRef(audioPlayer);
  audioPlayerRef.current = audioPlayer;
  const onControllerReadyRef = useRef(onControllerReady);
  onControllerReadyRef.current = onControllerReady;
  const [error, setError] = useState<string | null>(null);
  /** Increments whenever a fresh WaifuCharacterController is live. */
  const [ctrlVersion, setCtrlVersion] = useState(0);

  const controllerRef = useRef<WaifuCharacterController | null>(null);
  const renderingRef = useRef<RenderingController | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const [danceDebug, setDanceDebug] = useState<DanceDebugInfo | null>(null);
  const [aiAnimDebug, setAiAnimDebug] = useState<CharacterBehaviorDebugState | null>(null);

  // Poll the dance director at ~2 Hz while the analysis overlay is enabled
  useEffect(() => {
    if (!settings.showMusicAnalysis) {
      setDanceDebug(null);
      return;
    }
    const id = window.setInterval(() => {
      const ctrl = controllerRef.current;
      if (ctrl) setDanceDebug(ctrl.getDanceDebugInfo());
    }, 500);
    return () => window.clearInterval(id);
  }, [settings.showMusicAnalysis]);

  // Poll the AI Animation Director at ~2 Hz while its debug overlay is enabled
  useEffect(() => {
    if (!settings.showAiAnimationDebug) {
      setAiAnimDebug(null);
      return;
    }
    const id = window.setInterval(() => {
      const ctrl = controllerRef.current;
      if (ctrl) setAiAnimDebug(ctrl.getAiAnimationDebug());
    }, 500);
    return () => window.clearInterval(id);
  }, [settings.showAiAnimationDebug]);

  // Main effect — ONLY depends on modelUrl. Quality tier changes are handled
  // separately below to avoid tearing down the ASM mid-dance.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!modelUrl) {
      onStatusRef.current?.("No model");
      setError("No VRM model configured. Add one in public/models/manifest.json.");
      return;
    }
    setError(null);
    let disposed = false;
    let gestureRecognizer: StageGestureRecognizer | null = null;

    // Global event bus — shared across all controllers
    const bus = new EventBus();

    // RenderingController owns all Three.js (scene, camera, renderer, lights)
    const quality = getQualitySettings(settingsRef.current.qualityTier || detectQualityTier());
    const rendering = new RenderingController(container, bus, quality);

    onStatusRef.current?.("Loading…");
    loadVRM(modelUrl)
      .then((loaded) => {
        if (disposed) {
          disposeVRM(loaded);
          rendering.dispose();
          return;
        }

        // Add VRM model to rendering scene
        rendering.add(loaded.scene);
        rendering.setClickableObjects(loaded.scene);

        // Calculate initial camera position from model bounds
        try {
          loaded.scene.updateWorldMatrix(true, true);
          const box = new THREE.Box3().setFromObject(loaded.scene);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const targetY = center.y + size.y * 0.18;
          rendering.setCameraTarget(0, targetY - 0.08, 0);
        } catch {
          // fall through with defaults
        }

        if (!loaded.humanoid) {
          throw new Error("[WaifuStage] Loaded VRM has no humanoid — cannot animate");
        }

        // Create coordinator that wires all domain controllers
        const ctrl = new WaifuCharacterController(
          loaded,
          rendering,
          bus,
          settingsRef.current,
          quality,
        );
        // Heart FX on head pats — the controller fires once per debounced
        // reaction; we project the world-space point into this container.
        ctrl.touchReactions.onHeartBurst = (worldPoint) => {
          const el = containerRef.current;
          if (!el) return;
          spawnHeartBurst(el, worldPoint, rendering.camera, rendering.domElement);
        };

        controllerRef.current = ctrl;
        renderingRef.current = rendering;
        onStatusRef.current?.("Ready");

        // Stage-gesture recognizer — wires double-tap, two-finger tap, and swipe-up
        // to the renderer callbacks, which are dance-gated at the controller layer.
        const gestureCallbacks: StageGestureCallbacks = {
          onDoubleTap: () => renderingRef.current?.onStageDoubleTap?.(),
          onTwoFingerTap: () => renderingRef.current?.onStageTwoFingerTap?.(),
          onSwipeUp: () => renderingRef.current?.onStageSwipeUp?.(),
        };
        gestureRecognizer = new StageGestureRecognizer(gestureCallbacks, containerRef.current!);

        // Re-attach the CURRENT audio player — the prop captured by this
        // effect closure is stale (null) whenever the player was created
        // after mount. Without this, beat/energy analysis never reached the
        // dance director and dances ran blind to the music.
        if (audioPlayerRef.current) {
          ctrl.setAudioPlayer(audioPlayerRef.current);
        }

        setCtrlVersion((v) => v + 1);
        onControllerReadyRef.current?.();

        // Dev/e2e hook — never shipped in production builds.
        if (import.meta.env.DEV) {
          (window as unknown as Record<string, unknown>).__waifuDebug = {
            getController: () => controllerRef.current,
            getAudioPlayer: () => audioPlayerRef.current,
            getState: () => controllerRef.current?.animation.currentAnimState ?? null,
            /** Introspect ASM wiring (dev diagnostics only). */
            probeAsm: () => {
              const c = controllerRef.current;
              if (!c) return null;
              const asm = c.animation.stateMachine as unknown as {
                director?: unknown;
                getAudioFeatures?: () => unknown;
                danceRequested?: boolean;
                animState?: string;
              };
              const snap = asm.getAudioFeatures?.();
              return {
                hasDirector: !!asm.director,
                danceRequested: asm.danceRequested,
                animState: asm.animState,
                snapIsNull: snap === null || snap === undefined,
                snapFeaturesNull: !snap || (snap as { features?: unknown }).features == null,
                songVersion: snap ? (snap as { songVersion?: number }).songVersion : null,
              };
            },
          };
        }
      })
      .catch((e) => {
        console.error(e);
        setError(`Failed to load VRM: ${e instanceof Error ? e.message : String(e)}`);
        onStatusRef.current?.("Error");
        rendering.dispose();
      });

    handleRef.current = {
      speak: async (text: string, emotion?: string) => {
        if (!settingsRef.current.voiceEnabled) return;
        await controllerRef.current?.speak(text, emotion);
      },
      triggerHappy: () => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;
        ctrl.queueExpression({ emotion: "happy", intensity: 0.6, duration: 2.5 });
        ctrl.setState("HAPPY", 2500);
      },
      playAnimation: async (name: VRMAAnimationName) => {
        await controllerRef.current?.playAnimation(name);
      },
      stopAnimation: () => {
        controllerRef.current?.stopAnimation();
      },
      onUserMessage: (text) => {
        controllerRef.current?.onUserMessage(text);
      },
      onAIResponse: (emotion, intensity, response) => {
        controllerRef.current?.onAIResponse(emotion, intensity, response);
      },
      onAiAnimationIntent: (intent) => {
        controllerRef.current?.onAiAnimationIntent(intent);
      },
      onAiGenerationFailed: () => {
        controllerRef.current?.onAiGenerationFailed();
      },
      onGreeting: () => {
        controllerRef.current?.onGreeting();
      },
      onSilence: () => {
        controllerRef.current?.onSilence();
      },
      setListening: (active) => {
        controllerRef.current?.setListening(active);
      },
      setAudioPlayer: (ap) => {
        controllerRef.current?.setAudioPlayer(ap);
      },
      updateDanceCameraEnabled: (v: boolean) => {
        controllerRef.current?.setDanceCameraEnabled(v);
      },
      startDance: () => {
        controllerRef.current?.startDance();
      },
      stopDance: () => {
        controllerRef.current?.stopDance();
      },
      prewarmAudio: () => {
        controllerRef.current?.prewarmAudio();
      },
      cancelSpeech: () => {
        controllerRef.current?.cancelSpeech();
      },
      getAiAnimationDebug: () => controllerRef.current?.getAiAnimationDebug() ?? null,
      onTwoFingerConfettiBurst: () => {
        // Two-finger confetti is a stage-level effect and is safe during dance.
        const ctrl = controllerRef.current;
        if (!ctrl) return;
        ctrl.onTwoFingerConfettiBurst?.();
      },
    };

    return () => {
      disposed = true;
      gestureRecognizer?.dispose();
      gestureRecognizer = null;
      controllerRef.current?.dispose();
      controllerRef.current = null;
      renderingRef.current = null;
      handleRef.current = null;
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).__waifuDebug;
      }
    };
    // Intentionally keyed to modelUrl only: live settings are read through
    // settingsRef, the audio player through audioPlayerRef, and handleRef is a
    // stable ref owned by the parent. Re-running on those would tear down and
    // rebuild the whole stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl]);

  // Quality tier changes — update the live controller without destroying the ASM
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.setQuality(getQualitySettings(settings.qualityTier));
  }, [settings.qualityTier, ctrlVersion]);

  // Frame-rate ceiling — orthogonal to the quality tier, so it gets its own
  // effect. Folding it into the one above would re-seat the DRS ceiling and
  // churn the backing store every time the cap changed.
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.setFpsCap(settings.fpsCap);
  }, [settings.fpsCap, ctrlVersion]);

  // Max Performance mode — takes priority over the FPS cap when enabled.
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.rendering.setMaxPerfMode(settings.maxPerfMode);
  }, [settings.maxPerfMode, ctrlVersion]);

  // Settings sync — must also run when a fresh controller appears, otherwise
  // saved settings (sensitivities, dance prefs) never reach it.
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.updateSettings(settings);
    // Reflect the dance camera setting. The controller itself still gates the
    // active behavior on the actual animation state, so this only enables/disables
    // the feature at the renderer level.
    ctrl.updateDanceCameraEnabled(settings.danceCameraEnabled);
    // If the VRM has no hips bone, the dance camera must never start tracking from
    // the world origin even when a dance plays. Keeping it disabled protects the
    // framing and avoids a weird first-frame jump.
    if (!ctrl.hasHipsAnchor && settings.danceCameraEnabled) {
      ctrl.updateDanceCameraEnabled(false);
    }
  }, [settings, ctrlVersion]);

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    if (settings.micEnabled && !ctrl.input.micActive) {
      ctrl.startMic().catch((e) => console.warn("Mic failed:", e));
    } else if (!settings.micEnabled && ctrl.input.micActive) {
      ctrl.stopMic();
    }
  }, [settings.micEnabled, ctrlVersion]);

  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    if (settings.webcamEnabled && !ctrl.input.motionActive) {
      ctrl.startMotion().catch((e) => console.warn("Webcam failed:", e));
    } else if (!settings.webcamEnabled && ctrl.input.motionActive) {
      ctrl.stopMotion();
    }
  }, [settings.webcamEnabled, ctrlVersion]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      {error && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-md rounded-lg bg-destructive/90 px-4 py-3 text-destructive-foreground text-sm">
          {error}
        </div>
      )}
      {danceDebug && settings.showMusicAnalysis && (
        <div className="absolute bottom-4 left-4 z-20 rounded-lg bg-black/60 px-3 py-2 text-[11px] leading-relaxed text-white/90 backdrop-blur-md">
          <div>
            BPM: ~{Math.round(danceDebug.bpm)} ({Math.round(danceDebug.bpmConfidence * 100)}% conf)
          </div>
          <div>Energy: {Math.round(danceDebug.energy * 100)}%</div>
          <div>Beat: {danceDebug.beat ? "detected" : "—"}</div>
          <div>
            Bass/Mid/Treble: {danceDebug.bass.toFixed(2)} / {danceDebug.mid.toFixed(2)} /{" "}
            {danceDebug.treble.toFixed(2)}
          </div>
          <div>
            Tier: {danceDebug.tier} → {danceDebug.desiredTier}
          </div>
          <div>Current Dance: {danceDebug.currentDance ?? "—"}</div>
          <div>Dance Style: {danceDebug.currentStyle ?? "—"}</div>
          <div>Next: {danceDebug.nextDance ?? "—"}</div>
          <div>
            BPM recheck:{" "}
            {danceDebug.bpmChangedPending
              ? "tempo changed — switching…"
              : `in ${(danceDebug.bpmRecheckDueInMs / 1000).toFixed(0)}s`}
            {danceDebug.bpmAtDanceStart > 0
              ? ` (dance BPM ${Math.round(danceDebug.bpmAtDanceStart)})`
              : ""}
          </div>
          <div>
            Next transition in:{" "}
            {Number.isFinite(danceDebug.timeUntilNextAllowedTransition)
              ? `${(danceDebug.timeUntilNextAllowedTransition / 1000).toFixed(1)}s`
              : "—"}
          </div>
        </div>
      )}
      {aiAnimDebug && settings.showAiAnimationDebug && (
        <div className="absolute bottom-4 right-4 z-20 w-64 rounded-lg bg-black/60 px-3 py-2 text-[11px] leading-relaxed text-white/90 backdrop-blur-md">
          <div className="mb-1 border-b border-white/20 pb-1 font-semibold text-white">
            Character Behavior
          </div>
          <div>State: {aiAnimDebug.state}</div>
          <div>Animation: {aiAnimDebug.currentAnimation ?? "—"}</div>
          <div>Action: {aiAnimDebug.currentAction ?? "—"}</div>
          <div>Priority: {aiAnimDebug.priority}</div>
          <div>TTS: {aiAnimDebug.tts}</div>
          <div>Attention: {aiAnimDebug.attention}</div>
          <div>Music: {aiAnimDebug.music}</div>
          <div>Last AI intent: {aiAnimDebug.lastAiIntent ?? "—"}</div>
          <div>Reason: {aiAnimDebug.reason}</div>
        </div>
      )}
    </div>
  );
}
