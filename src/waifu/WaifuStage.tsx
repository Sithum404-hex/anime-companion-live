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

interface Props {
  settings: Settings;
  modelUrl: string;
  onSpeakRef: (fn: (text: string) => Promise<void>) => void;
  onStatus?: (s: string) => void;
}

export function WaifuStage({ settings, modelUrl, onSpeakRef, onStatus }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    const renderer = new Renderer(container);
    const state = new StateManager();
    const voice = new VoiceEngine();
    const mic = new MicInput();
    const motion = new MotionDetect();

    let vrm: VRM | null = null;
    let anim: AnimationController | null = null;
    let lip: LipSync | null = null;
    let reaction: ReactionSystem | null = null;

    onStatus?.("Loading model…");
    loadVRM(modelUrl)
      .then((loaded) => {
        if (disposed) {
          disposeVRM(loaded);
          return;
        }
        vrm = loaded;
        renderer.scene.add(loaded.scene);
        loaded.scene.position.y = 0;
        anim = new AnimationController(loaded);
        lip = new LipSync(loaded, voice.getLipSyncSampler());
        reaction = new ReactionSystem({
          state,
          mic,
          motion,
          voice,
          anim,
          settings: settingsRef.current,
        });
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

    onSpeakRef(async (text: string) => {
      if (!settingsRef.current.voiceEnabled) return;
      const emo = state.emotion;
      const offset = emo === "happy" ? 0.1 : emo === "scared" ? 0.2 : 0;
      await voice.speak(text, {
        pitch: settingsRef.current.pitch,
        rate: settingsRef.current.rate,
        volume: settingsRef.current.volume,
        emotionPitchOffset: offset,
      });
    });

    return () => {
      disposed = true;
      stop();
      voice.cancel();
      mic.stop();
      motion.stop();
      if (vrm) disposeVRM(vrm);
      renderer.dispose();
    };
  }, [modelUrl, onSpeakRef, onStatus]);

  // toggle mic / webcam based on settings
  useEffect(() => {
    // We can't easily reach mic/motion instances from above effect; re-create on modelUrl change.
    // Instead, attach handlers to settings via window event to stay simple.
    const event = new CustomEvent("waifu:settings", { detail: settings });
    window.dispatchEvent(event);
  }, [settings]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      {error && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-destructive/90 px-4 py-3 text-destructive-foreground text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
