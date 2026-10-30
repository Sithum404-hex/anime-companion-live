import { useCallback, useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  Music2,
  Pause,
  Play,
  SkipForward,
  SlidersHorizontal,
  Volume2,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_AUDIO_ENGINE_SETTINGS,
  type AudioEngineSettings,
  type AudioPlayerManager,
} from "@/systems/audioPlayer";
import { MusicVisualizer } from "@/waifu/MusicVisualizer";
import type { QualityTier } from "@/waifu/types";

interface Props {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  audioPlayer: AudioPlayerManager | null;
  isPlaying?: boolean;
  nowPlaying?: string;
  /** Visualizer v1 gate (spectrum + reactive glow). Default true. */
  visualizersEnabled?: boolean;
  qualityTier?: QualityTier;
}

/**
 * The music console, folded into the settings drawer.
 *
 * Playback and folder selection are the surface; tone controls live behind one
 * disclosure so the common action is never buried under five sliders that most
 * people set once.
 */
export function MusicPlayer({
  enabled,
  onToggle,
  audioPlayer,
  isPlaying = false,
  nowPlaying = "",
  visualizersEnabled = true,
  qualityTier = "medium",
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [engineSettings, setEngineSettings] = useState<AudioEngineSettings>(
    DEFAULT_AUDIO_ENGINE_SETTINGS,
  );

  useEffect(() => {
    if (!audioPlayer) return;
    setEngineSettings(audioPlayer.settings);
  }, [audioPlayer]);

  const handleFolderSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0 || !audioPlayer) return;
      audioPlayer.loadFiles(Array.from(files));
    },
    [audioPlayer],
  );

  const handlePlayPause = useCallback(() => {
    if (!audioPlayer) return;
    if (isPlaying) {
      audioPlayer.pause();
    } else {
      audioPlayer.play();
    }
  }, [audioPlayer, isPlaying]);

  const handleSkip = useCallback(() => {
    audioPlayer?.skip();
  }, [audioPlayer]);

  const handlePickFolder = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const updateEngine = useCallback(
    (key: keyof AudioEngineSettings, value: number) => {
      const next = { ...engineSettings, [key]: value };
      audioPlayer?.setEngineSettings(next);
      setEngineSettings(audioPlayer?.settings ?? next);
    },
    [audioPlayer, engineSettings],
  );

  return (
    <section className="set-section">
      <div className="set-section-head">
        <h3 className="set-section-title flex items-center gap-1.5">
          <Music2 className="h-3.5 w-3.5 text-white/40" aria-hidden />
          Music
        </h3>
        <span className="set-section-note">
          {enabled ? (isPlaying ? "Playing" : "Ready") : "Off"}
        </span>
      </div>

      <div className="set-card">
        <div className="set-row">
          <div className="set-row-copy">
            <span className="set-row-label">Music player</span>
            <span className="set-row-hint">
              Play from a folder on your device. She can dance to the beat.
            </span>
          </div>
          <Switch checked={enabled} onCheckedChange={onToggle} aria-label="Music player" />
        </div>

        {enabled && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="audio/*"
              className="hidden"
              onChange={handleFolderSelect}
              {...({
                webkitdirectory: "",
                directory: "",
              } as React.InputHTMLAttributes<HTMLInputElement>)}
            />

            <div className="border-t border-white/[0.06] py-3">
              <div className="flex items-center gap-2">
                <button type="button" onClick={handlePickFolder} className="set-btn flex-1">
                  <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                  Choose folder
                </button>
                <button
                  type="button"
                  onClick={handlePlayPause}
                  disabled={!nowPlaying}
                  className="set-btn set-btn--accent"
                  aria-label={isPlaying ? "Pause" : "Play"}
                  title={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? (
                    <Pause className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Play className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {isPlaying ? "Pause" : "Play"}
                </button>
                <button
                  type="button"
                  onClick={handleSkip}
                  disabled={!nowPlaying}
                  className="set-btn px-2.5"
                  aria-label="Skip track"
                  title="Skip track"
                >
                  <SkipForward className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>

              <div className="mt-2.5 flex items-center gap-2 px-1">
                <Volume2 className="h-3 w-3 shrink-0 text-white/25" aria-hidden />
                <p className="min-w-0 flex-1 truncate text-[11px] text-white/45">
                  {nowPlaying || "No folder chosen yet."}
                </p>
                {nowPlaying && (
                  <span className="shrink-0 text-[10px] text-white/25">
                    {isPlaying ? "Now playing" : "Paused"}
                  </span>
                )}
              </div>

              {visualizersEnabled && (
                <div className="mt-3 rounded-xl border border-white/[0.06] bg-[#05070f]/30 px-2 pb-1 pt-2">
                  <MusicVisualizer
                    audioPlayer={audioPlayer}
                    isPlaying={isPlaying}
                    qualityTier={qualityTier}
                  />
                </div>
              )}

              <details className="set-disclosure mt-2">
                <summary>
                  <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                  Audio engine
                </summary>
                <div className="set-disclosure-body space-y-3">
                  <EngineSlider
                    label="Volume"
                    value={engineSettings.masterVolume}
                    max={1.5}
                    onChange={(v) => updateEngine("masterVolume", v)}
                  />
                  <EngineSlider
                    label="Bass"
                    value={engineSettings.bassBoost}
                    onChange={(v) => updateEngine("bassBoost", v)}
                  />
                  <EngineSlider
                    label="Warmth"
                    value={engineSettings.warmth}
                    onChange={(v) => updateEngine("warmth", v)}
                  />
                  <EngineSlider
                    label="Clarity"
                    value={engineSettings.clarity}
                    onChange={(v) => updateEngine("clarity", v)}
                  />
                  <p className="pt-1 text-[10px] font-medium text-white/35">Studio effects</p>
                  <EngineSlider
                    label="Stereo width"
                    value={engineSettings.stereoWidth}
                    onChange={(v) => updateEngine("stereoWidth", v)}
                  />
                  <EngineSlider
                    label="Ambience"
                    value={engineSettings.ambience}
                    onChange={(v) => updateEngine("ambience", v)}
                  />
                </div>
              </details>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function EngineSlider({
  label,
  value,
  max = 1,
  onChange,
}: {
  label: string;
  value: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex items-center justify-between text-[11px] text-white/45">
        <span>{label}</span>
        <span className="tabular-nums text-white/35">{Math.round((value / max) * 100)}%</span>
      </span>
      <input
        type="range"
        className="set-range"
        min={0}
        max={max}
        step={0.01}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
