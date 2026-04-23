import { useEffect, useRef, useState } from "react";
import { Renderer } from "@/waifu/renderer";
import { loadVRM, disposeVRM } from "@/waifu/vrmLoader";
import { AnimationController } from "@/waifu/animation";
import { VoiceEngine } from "@/waifu/voiceEngine";
import { LipSync } from "@/waifu/lipSync";
import { MicInput } from "@/waifu/micInput";
import { MotionDetect } from "@/waifu/motionDetect";
import { StateManager } from "@/waifu/stateManager";
import { ReactionSystem } from "@/waifu/reactionSystem";
import type { Settings } from "@/waifu/types";
import type { VRM } from "@pixiv/three-vrm";

export interface WaifuHandle {
  speak: (text: string) => Promise<void>;
  triggerHappy: () => void;
}

interface Props {
  settings: Settings;
  modelUrl: string;
  handleRef: { current: WaifuHandle | null };
  onStatus?: (s: string) => void;
}

export function WaifuStage({ settings, modelUrl, handleRef, onStatus }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [error, setError] = useState<string | null>(null);

  // Hold instances in refs so the settings effect can reach them
  const micRef = useRef<MicInput | null>(null);
  const motionRef = useRef<MotionDetect | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    const renderer = new Renderer(container);
    const state = new StateManager();
    const voice = new VoiceEngine();
    const mic = new MicInput();
    const motion = new MotionDetect();
    micRef.current = mic;
    motionRef.current = motion;

    let vrm: VRM | null = null;
    let anim: AnimationController | null = null;
    let lip: LipSync | null = null;
    let reaction: ReactionSystem | null = null;

    onStatus?.("Loading…");
    loadVRM(modelUrl)
      .then((loaded) => {
        if (disposed) {
          disposeVRM(loaded);
          return;
        }
        vrm = loaded;
        renderer.scene.add(loaded.scene);

        // Auto-frame the camera on the head/upper body using VRM bones.
        try {
          const hum = loaded.humanoid;
          const head = hum?.getNormalizedBoneNode("head" as never);
          const hips = hum?.getNormalizedBoneNode("hips" as never);
          const headWorld = new (require("three") as typeof import("three")).Vector3();
          if (head) {
            head.getWorldPosition(headWorld);
          } else if (hips) {
            hips.getWorldPosition(headWorld);
            headWorld.y += 0.6;
          } else {
            headWorld.set(0, 1.4, 0);
          }
          const targetY = headWorld.y - 0.15;
          renderer.camera.position.set(0, targetY + 0.05, 2.4);
          renderer.camera.lookAt(0, targetY, 0);
        } catch {
          /* keep default framing */
        }

        anim = new AnimationController(loaded);
        lip = new LipSync(loaded, voice.getLipSyncSampler());
        reaction = new ReactionSystem({ state, mic, motion, voice, anim, settings: settingsRef.current });
        state.on((s, e) => {
          anim?.setState(s);
          anim?.setEmotion(e);
        });
        onStatus?.("Ready");
      })
      .catch((e) => {
        console.error(e);
        setError(`Failed to load VRM: ${e instanceof Error ? e.message : String(e)}`);
        onStatus?.("Error");
      });

    const stop = renderer.addUpdate((dt) => {
      if (anim) anim.update(dt);
      if (lip) lip.update(dt);
      if (reaction) {
        reaction.updateSettings(settingsRef.current);
        reaction.tick(dt);
      }
    });

    handleRef.current = {
      speak: async (text: string) => {
        if (!settingsRef.current.voiceEnabled) return;
        const emo = state.emotion;
        const offset = emo === "happy" ? 0.1 : emo === "scared" ? 0.2 : 0;
        await voice.speak(text, {
          pitch: settingsRef.current.pitch,
          rate: settingsRef.current.rate,
          volume: settingsRef.current.volume,
          emotionPitchOffset: offset,
        });
      },
      triggerHappy: () => {
        state.setEmotion("happy");
        state.setState("HAPPY", 2500);
      },
    };

    return () => {
      disposed = true;
      stop();
      voice.cancel();
      mic.stop();
      motion.stop();
      if (vrm) disposeVRM(vrm);
      renderer.dispose();
      handleRef.current = null;
      micRef.current = null;
      motionRef.current = null;
    };
  }, [modelUrl, handleRef, onStatus]);

  // Mic toggle
  useEffect(() => {
    const m = micRef.current;
    if (!m) return;
    if (settings.micEnabled && !m.active) {
      m.start().catch((e) => console.warn("Mic failed:", e));
    } else if (!settings.micEnabled && m.active) {
      m.stop();
    }
  }, [settings.micEnabled]);

  // Webcam toggle
  useEffect(() => {
    const m = motionRef.current;
    if (!m) return;
    if (settings.webcamEnabled && !m.active) {
      m.start().catch((e) => console.warn("Webcam failed:", e));
    } else if (!settings.webcamEnabled && m.active) {
      m.stop();
    }
  }, [settings.webcamEnabled]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      {error && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-md rounded-lg bg-destructive/90 px-4 py-3 text-destructive-foreground text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
