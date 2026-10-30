import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "@tanstack/react-router";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Check,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  Pencil,
  Trash2,
  User,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth";
import { loadModelManifest, loadWardrobeManifest } from "@/lib/manifests";
import { DivorcePaper } from "@/waifu/DivorcePaper";
import type { Settings, ModelManifest, WardrobeManifest } from "@/waifu/types";
import type { AudioPlayerManager } from "@/systems/audioPlayer";
import { MusicPlayer } from "@/waifu/MusicPlayer";
import { formatKeyCode } from "@/waifu/voiceInput";
import { isHapticsSupported } from "@/waifu/haptics";
import type { RelationshipMode } from "@/waifu/types";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (s: Settings) => void;
  screenVisionSharing?: boolean;
  onStopSharing?: () => void;
  audioPlayer?: AudioPlayerManager | null;
  isMusicPlaying?: boolean;
  nowPlaying?: string;
}

const BACKGROUNDS = [
  { id: "/backgrounds/bg1.jpg", label: "Cozy room" },
  { id: "/backgrounds/bg2.jpg", label: "Neon night" },
  { id: "color:#0b0b14", label: "Pure dark" },
  { id: "color:#fcfbf8", label: "Soft cream" },
];

const RELATIONSHIP_COPY: Record<RelationshipMode, string> = {
  natural: "Warm, but she takes her time opening up.",
  closeFriend: "Familiar and playful. She is comfortable teasing you.",
  crush: "Openly affectionate, and a little bold about it.",
};

type TabId = "companion" | "voice" | "screen" | "system";

const TABS: { id: TabId; label: string }[] = [
  { id: "companion", label: "Companion" },
  { id: "voice", label: "Voice" },
  { id: "screen", label: "Screen" },
  { id: "system", label: "System" },
];

export function SettingsPanel({
  open,
  onClose,
  settings,
  onChange,
  screenVisionSharing,
  onStopSharing,
  audioPlayer,
  isMusicPlaying,
  nowPlaying,
}: Props) {
  const [manifest, setManifest] = useState<ModelManifest | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("companion");
  // Capability is only knowable in the browser, so it is resolved after mount
  // instead of during render (this component also renders during SSR).
  const [hapticsAvailable, setHapticsAvailable] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    setHapticsAvailable(isHapticsSupported());
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadModelManifest().then((data) => {
      if (!cancelled) setManifest(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Each tab starts at the top instead of inheriting the previous scroll offset.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  const update = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    onChange({ ...settings, [k]: v });

  const handleTabKey = (e: React.KeyboardEvent) => {
    const index = TABS.findIndex((t) => t.id === activeTab);
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    const id = TABS[next].id;
    setActiveTab(id);
    requestAnimationFrame(() => tabRefs.current[id]?.focus());
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[#04060f]/60 backdrop-blur-[6px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-200" />
      <DialogPrimitive.Content
        className={cn(
          "glass glass--deep glass-ui fixed right-0 top-0 z-50 flex h-[100dvh] w-full max-w-[30rem] flex-col overflow-hidden text-white outline-none",
          "rounded-none border-0 shadow-2xl sm:rounded-l-[1.75rem]",
          "data-[state=open]:animate-in data-[state=open]:slide-in-from-right",
          "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right",
          "duration-300",
        )}
      >
        <DialogPrimitive.Description className="sr-only">
          Adjust how Youki looks, speaks, sees your screen, and performs on this device.
        </DialogPrimitive.Description>

        <header className="shrink-0 border-b border-white/[0.07] px-5 pb-3.5 pt-5 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogPrimitive.Title asChild>
                <h2 className="voice-display text-[1.4rem] leading-tight text-white">Settings</h2>
              </DialogPrimitive.Title>
              <p className="mt-1 text-[11px] text-white/45">Changes save as you make them.</p>
            </div>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="Close settings"
                className="set-icon-btn focus-ring shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </DialogPrimitive.Close>
          </div>

          <div
            role="tablist"
            aria-label="Settings sections"
            className="set-tablist mt-4"
            onKeyDown={handleTabKey}
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[tab.id] = el;
                }}
                id={`settings-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                className="set-tab focus-ring"
              >
                {tab.label}
              </button>
            ))}
          </div>
        </header>

        <div
          ref={bodyRef}
          className="scroll-slim flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 sm:px-6"
        >
          <div
            key={activeTab}
            id={`settings-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`settings-tab-${activeTab}`}
            className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
          >
            {activeTab === "companion" && (
              <CompanionTab
                manifest={manifest}
                settings={settings}
                onChange={onChange}
                update={update}
              />
            )}

            {activeTab === "voice" && (
              <VoiceTab settings={settings} update={update} hapticsAvailable={hapticsAvailable} />
            )}

            {activeTab === "screen" && (
              <ScreenTab
                settings={settings}
                update={update}
                screenVisionSharing={screenVisionSharing}
                onStopSharing={onStopSharing}
                audioPlayer={audioPlayer}
                isMusicPlaying={isMusicPlaying}
                nowPlaying={nowPlaying}
              />
            )}

            {activeTab === "system" && (
              <SystemTab settings={settings} update={update} onClose={onClose} />
            )}
          </div>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}

// ── Companion ──────────────────────────────────────────────────────────────

function CompanionTab({
  manifest,
  settings,
  onChange,
  update,
}: {
  manifest: ModelManifest | null;
  settings: Settings;
  onChange: (s: Settings) => void;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
}) {
  return (
    <>
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">Character</h3>
          <span className="set-section-note">
            {manifest?.models.length
              ? `${manifest.models.length} ${manifest.models.length === 1 ? "model" : "models"}`
              : ""}
          </span>
        </div>
        <div className="set-card">
          {manifest?.models.length ? (
            manifest.models.map((model) => {
              const selected = settings.modelId === model.id;
              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => update("modelId", model.id)}
                  aria-pressed={selected}
                  data-selected={selected}
                  className="choice-card my-2 flex w-full items-center gap-3 px-3 py-2.5 text-left"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.05] text-white/55">
                    <User className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-white/88">
                      {model.label}
                    </span>
                    <span className="block truncate text-[10px] text-white/45">
                      {selected ? "Her current form" : "Tap to switch"}
                    </span>
                  </span>
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0 transition-opacity",
                      selected ? "text-[var(--hud-accent)] opacity-100" : "opacity-0",
                    )}
                    aria-hidden
                  />
                </button>
              );
            })
          ) : (
            <p className="opt-note py-3 leading-relaxed">
              No character files were found. Add a <code>.vrm</code> file under{" "}
              <code>public/models/</code> and register it in <code>manifest.json</code>.
            </p>
          )}
        </div>
      </section>

      <WardrobeSection settings={settings} onChange={onChange} />

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">Room</h3>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {BACKGROUNDS.map((background) => {
            const selected = settings.background === background.id;
            const isColor = background.id.startsWith("color:");
            return (
              <button
                key={background.id}
                type="button"
                onClick={() => update("background", background.id)}
                aria-pressed={selected}
                data-selected={selected}
                className="choice-card overflow-hidden text-left"
              >
                <span
                  className="relative block aspect-[16/9] w-full"
                  style={
                    isColor
                      ? { backgroundColor: background.id.slice("color:".length) }
                      : {
                          backgroundImage: `url(${background.id})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }
                  }
                >
                  <span className="absolute inset-0 bg-gradient-to-t from-black/35 to-transparent" />
                  {selected && (
                    <span className="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-[var(--hud-accent)] text-[#0b0e19]">
                      <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
                    </span>
                  )}
                </span>
                <span className="block px-2.5 py-1.5 text-[11px] font-medium text-white/70">
                  {background.label}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">Relationship</h3>
        </div>
        <div className="set-card py-3">
          <ChoiceGroup
            label="Relationship mode"
            value={settings.relationshipMode}
            onChange={(value) => update("relationshipMode", value)}
            options={[
              { value: "natural", label: "Natural" },
              { value: "closeFriend", label: "Close friend" },
              { value: "crush", label: "Crush" },
            ]}
          />
          <p className="opt-note mt-2.5">{RELATIONSHIP_COPY[settings.relationshipMode]}</p>
        </div>
      </section>
    </>
  );
}

function WardrobeSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  // undefined means loading; null means the manifest could not be used.
  const [wardrobe, setWardrobe] = useState<WardrobeManifest | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    loadWardrobeManifest().then((data) => {
      if (!cancelled) setWardrobe(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (wardrobe === undefined) {
    return (
      <section className="set-section" aria-busy="true" aria-label="Loading wardrobe">
        <div className="set-section-head">
          <h3 className="set-section-title">Wardrobe</h3>
        </div>
        <div className="set-card py-2">
          <div className="my-1 h-[4.2rem] animate-pulse rounded-xl bg-white/[0.05]" />
        </div>
      </section>
    );
  }

  if (!wardrobe || wardrobe.outfits.length === 0) {
    return (
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">Wardrobe</h3>
        </div>
        <div className="set-card">
          <p className="opt-note py-3">No outfits are available for this character yet.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="set-section">
      <div className="set-section-head">
        <h3 className="set-section-title">Wardrobe</h3>
        <span className="set-section-note">
          {wardrobe.outfits.length} {wardrobe.outfits.length === 1 ? "outfit" : "outfits"}
        </span>
      </div>
      <div className="set-card space-y-2 py-2">
        {wardrobe.outfits.map((outfit) => {
          const selected = settings.outfitId === outfit.id;
          return (
            <button
              key={outfit.id}
              type="button"
              onClick={() => onChange({ ...settings, outfitId: outfit.id })}
              aria-pressed={selected}
              data-selected={selected}
              className="choice-card flex w-full items-center gap-3 p-2 text-left"
            >
              <span className="relative block h-[3.4rem] w-[2.7rem] shrink-0 overflow-hidden rounded-lg bg-white/[0.04]">
                {outfit.preview ? (
                  <img
                    src={outfit.preview}
                    alt=""
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[hsl(var(--sakura)/0.18)] via-[hsl(var(--twilight)/0.14)] to-[hsl(var(--sky)/0.12)]">
                    <ImageIcon className="h-4 w-4 text-white/30" aria-hidden />
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-white/86">{outfit.label}</span>
                <span className="block text-[10px] text-white/32">
                  {selected ? "Wearing now" : "Wear this"}
                </span>
              </span>
              {selected && (
                <Check className="h-4 w-4 shrink-0 text-[var(--hud-accent)]" aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ── Voice ─────────────────────────────────────────────────────────────────

function VoiceTab({
  settings,
  update,
  hapticsAvailable,
}: {
  settings: Settings;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  hapticsAvailable: boolean;
}) {
  return (
    <>
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">Her voice</h3>
        </div>
        <div className="set-card">
          <ToggleRow
            label="Voice replies"
            hint="She speaks replies aloud with lip-sync."
            v={settings.voiceEnabled}
            on={(v) => update("voiceEnabled", v)}
          />
          <ToggleRow
            label="Push-to-talk"
            hint="Hold the shortcut to speak. The mic is closed when you let go."
            v={settings.pushToTalkEnabled}
            on={(v) => update("pushToTalkEnabled", v)}
          />
          {settings.pushToTalkEnabled && (
            <PushToTalkKeyRow
              keyCode={settings.pushToTalkKey}
              onChange={(code) => update("pushToTalkKey", code)}
            />
          )}
        </div>
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">Senses</h3>
        </div>
        <div className="set-card">
          <ToggleRow
            label="Microphone"
            hint="She reacts to music and the sounds around you."
            v={settings.micEnabled}
            on={(v) => update("micEnabled", v)}
          />
          <ToggleRow
            label="Webcam"
            hint="She follows your face with her eyes while she talks."
            v={settings.webcamEnabled}
            on={(v) => update("webcamEnabled", v)}
          />
          <ToggleRow
            label="Haptics on touch"
            hint={
              hapticsAvailable
                ? "A short tick when you touch her, and a pulse on the beat."
                : "This browser has no vibration support, so this does nothing here."
            }
            v={settings.hapticsEnabled}
            on={(v) => update("hapticsEnabled", v)}
          />
        </div>
      </section>
    </>
  );
}

// ── Screen & music ────────────────────────────────────────────────────────

function ScreenTab({
  settings,
  update,
  screenVisionSharing,
  onStopSharing,
  audioPlayer,
  isMusicPlaying,
  nowPlaying,
}: {
  settings: Settings;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  screenVisionSharing?: boolean;
  onStopSharing?: () => void;
  audioPlayer?: AudioPlayerManager | null;
  isMusicPlaying?: boolean;
  nowPlaying?: string;
}) {
  return (
    <>
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">Screen vision</h3>
          <span className="set-section-note">{screenVisionSharing ? "Sharing" : "Off"}</span>
        </div>
        <div className="set-card">
          <div className="set-row">
            <div className="set-row-copy">
              <span className="set-row-label flex items-center gap-1.5">
                {settings.screenVisionEnabled ? (
                  <Eye className="h-3.5 w-3.5 text-[var(--hud-accent)]" aria-hidden />
                ) : (
                  <EyeOff className="h-3.5 w-3.5 text-white/35" aria-hidden />
                )}
                Share my screen
              </span>
              <span className="set-row-hint">
                She reads the window you pick and comments on what you're doing.
              </span>
            </div>
            <Switch
              checked={settings.screenVisionEnabled}
              onCheckedChange={(v) => update("screenVisionEnabled", v)}
              aria-label="Share my screen"
            />
          </div>

          {settings.screenVisionEnabled && (
            <>
              <ToggleRow
                label="Analyze automatically"
                hint="She checks in at the interval below."
                v={settings.autoAnalyzeScreen}
                on={(v) => update("autoAnalyzeScreen", v)}
              />
              {settings.autoAnalyzeScreen && (
                <div className="set-row set-row--stack border-t border-white/[0.06]">
                  <div className="flex w-full items-center justify-between gap-3">
                    <span className="set-row-label">Check every</span>
                    <span className="tabular-nums text-[11px] text-white/45">
                      {settings.screenAnalysisInterval}s
                    </span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={120}
                    step={5}
                    value={settings.screenAnalysisInterval}
                    aria-label="Screen analysis interval"
                    onChange={(e) => update("screenAnalysisInterval", Number(e.target.value))}
                    className="set-range"
                  />
                  <div className="flex w-full justify-between text-[10px] text-white/25">
                    <span>5 seconds</span>
                    <span>2 minutes</span>
                  </div>
                </div>
              )}
              <ToggleRow
                label="Dance to what's playing"
                hint="When she sees music or a video, she can start dancing."
                v={settings.screenVisionDanceEnabled}
                on={(v) => update("screenVisionDanceEnabled", v)}
              />
              {screenVisionSharing && onStopSharing && (
                <div className="set-row border-t border-white/[0.06]">
                  <span className="set-row-hint">Your screen is being shared right now.</span>
                  <button
                    type="button"
                    onClick={onStopSharing}
                    className="set-btn set-btn--danger focus-ring"
                  >
                    <EyeOff className="h-3.5 w-3.5" aria-hidden />
                    Stop sharing
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <MusicPlayer
        enabled={settings.musicPlayerEnabled}
        onToggle={(v) => update("musicPlayerEnabled", v)}
        audioPlayer={audioPlayer ?? null}
        isPlaying={isMusicPlaying}
        nowPlaying={nowPlaying}
        visualizersEnabled={settings.visualizersEnabled}
        qualityTier={settings.qualityTier}
      />

      {settings.musicPlayerEnabled && (
        <section className="set-section">
          <div className="set-section-head">
            <h3 className="set-section-title">Music reactions</h3>
          </div>
          <div className="set-card">
            <ToggleRow
              label="Visualizer"
              hint="Spectrum and glow in the dock, plus beat rings on the floor."
              v={settings.visualizersEnabled}
              on={(v) => update("visualizersEnabled", v)}
            />
            {settings.visualizersEnabled && (
              <div className="set-row set-row--stack border-t border-white/[0.06]">
                <span className="set-row-label">Visualizer style</span>
                <ChoiceGroup
                  label="Visualizer style"
                  value={settings.visualizerStyle}
                  onChange={(value) => update("visualizerStyle", value)}
                  options={[
                    { value: "default", label: "Default" },
                    { value: "subtle", label: "Subtle" },
                    { value: "energetic", label: "Energetic" },
                  ]}
                />
              </div>
            )}
            <ToggleRow
              label="Dance sync"
              hint="She picks moves that fit the tempo and energy."
              v={settings.danceSyncEnabled}
              on={(v) => update("danceSyncEnabled", v)}
            />
            <ToggleRow
              label="Follow camera"
              hint="The camera frames her more actively while she dances."
              v={settings.danceCameraEnabled}
              on={(v) => update("danceCameraEnabled", v)}
            />
            {settings.danceSyncEnabled && (
              <div className="set-row set-row--stack border-t border-white/[0.06]">
                <span className="set-row-label">Dance intensity</span>
                <ChoiceGroup
                  label="Dance intensity"
                  value={settings.danceIntensity}
                  onChange={(value) => update("danceIntensity", value)}
                  options={[
                    { value: "low", label: "Low" },
                    { value: "normal", label: "Normal" },
                    { value: "high", label: "High" },
                    { value: "auto", label: "Auto" },
                  ]}
                  cols="grid-cols-4"
                />
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}

// ── System ────────────────────────────────────────────────────────────────

function SystemTab({
  settings,
  update,
  onClose,
}: {
  settings: Settings;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  onClose: () => void;
}) {
  return (
    <>
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">Graphics</h3>
        </div>
        <div className="set-card py-3">
          <div className="space-y-1.5">
            <span className="set-row-label">Quality</span>
            <ChoiceGroup
              label="Render quality"
              value={settings.qualityTier}
              onChange={(value) => update("qualityTier", value)}
              options={[
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
            />
          </div>
          <div className="mt-3.5 space-y-1.5">
            <span className="set-row-label">Frame rate</span>
            <ChoiceGroup
              label="Frame rate cap"
              value={settings.fpsCap}
              onChange={(value) => update("fpsCap", value)}
              options={[
                { value: "30", label: "30 fps" },
                { value: "60", label: "60 fps" },
                { value: "uncapped", label: "Uncapped" },
              ]}
            />
            <p className="opt-note">
              A cap saves power. Automatic resolution scaling holds steady while a cap is on.
            </p>
          </div>
        </div>
      </section>

      <section className="set-section">
        <div className="set-card">
          <ToggleRow
            label="Max performance"
            hint="Ignore the frame cap when smoothness matters more than battery."
            v={settings.maxPerfMode}
            on={(v) => update("maxPerfMode", v)}
          />
        </div>
      </section>

      <AccountSection onClose={onClose} />

      <p className="opt-note pb-2 text-center">Everything here saves automatically.</p>
    </>
  );
}

function AccountSection({ onClose }: { onClose: () => void }) {
  const { user, mode, profile, updateProfile } = useAuth();
  const navigate = useNavigate();
  const isAuthed = mode === "authenticated";

  const [editing, setEditing] = useState(false);
  const [editUsername, setEditUsername] = useState("");
  const [editAvatar, setEditAvatar] = useState("");
  const [saving, setSaving] = useState(false);
  const [divorceOpen, setDivorceOpen] = useState(false);

  const startEditing = () => {
    setEditUsername(profile.username);
    setEditAvatar(profile.avatar_url);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
  };

  const saveProfile = async () => {
    if (editUsername && !/^[a-zA-Z\s]+$/.test(editUsername)) {
      toast.error("That name won't work", {
        description: "She can only pronounce letters. Please remove numbers and symbols.",
      });
      return;
    }

    setSaving(true);
    await updateProfile({ username: editUsername, avatar_url: editAvatar });
    setSaving(false);
    setEditing(false);
  };

  const handleSignContract = () => {
    onClose();
    navigate({ to: "/auth" });
  };

  return (
    <section className="set-section">
      <div className="set-section-head">
        <h3 className="set-section-title">Account</h3>
        <span className="set-section-note">{isAuthed ? "Signed" : "Guest"}</span>
      </div>

      {isAuthed && user ? (
        <div className="set-card">
          <div className="flex items-center gap-3 py-3">
            <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full border border-white/10 bg-white/[0.05]">
              {profile.avatar_url ? (
                <img
                  src={profile.avatar_url}
                  alt=""
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-white/55">
                  {(profile.username || user.email?.[0] || "?").toUpperCase()}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-white/88">
                {profile.username || user.email?.split("@")[0] || "Partner"}
              </p>
              <p className="truncate text-[11px] text-white/45">{user.email}</p>
            </div>
            <button
              type="button"
              onClick={startEditing}
              className="set-icon-btn focus-ring shrink-0"
              aria-label="Edit profile"
              title="Edit profile"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>

          <AnimatePresence initial={false}>
            {editing && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="space-y-3 border-t border-white/[0.06] py-3">
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] text-white/45">Display name</span>
                    <input
                      className="set-input"
                      value={editUsername}
                      onChange={(e) => setEditUsername(e.target.value)}
                      placeholder="Your name"
                      autoComplete="nickname"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] text-white/45">Avatar URL</span>
                    <input
                      className="set-input"
                      value={editAvatar}
                      onChange={(e) => setEditAvatar(e.target.value)}
                      placeholder="https://example.com/avatar.jpg"
                      inputMode="url"
                    />
                  </label>
                  <div className="flex gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={cancelEditing}
                      className="set-btn focus-ring flex-1"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveProfile}
                      disabled={saving}
                      className="set-btn set-btn--accent focus-ring flex-1"
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="set-row border-t border-white/[0.06]">
            <div className="set-row-copy">
              <span className="set-row-label">End the contract</span>
              <span className="set-row-hint">Deletes your shared memories permanently.</span>
            </div>
            <button
              type="button"
              onClick={() => setDivorceOpen(true)}
              className="set-btn set-btn--danger focus-ring"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Divorce
            </button>
          </div>
        </div>
      ) : (
        <div className="set-card">
          <div className="set-row">
            <div className="set-row-copy">
              <span className="set-row-label">You're visiting as a guest</span>
              <span className="set-row-hint">Sign the contract to keep your memories.</span>
            </div>
            <button
              type="button"
              onClick={handleSignContract}
              className="set-btn set-btn--accent focus-ring shrink-0"
            >
              <FileText className="h-3.5 w-3.5" aria-hidden />
              Sign contract
            </button>
          </div>
        </div>
      )}

      <DivorcePaper open={divorceOpen} onClose={() => setDivorceOpen(false)} />
    </section>
  );
}

// ── Shared controls ───────────────────────────────────────────────────────

function ToggleRow({
  label,
  v,
  on,
  hint,
}: {
  label: string;
  v: boolean;
  on: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="set-row">
      <div className="set-row-copy">
        <span className="set-row-label">{label}</span>
        {hint && <span className="set-row-hint">{hint}</span>}
      </div>
      <Switch checked={v} onCheckedChange={on} aria-label={label} />
    </div>
  );
}

function ChoiceGroup<T extends string>({
  value,
  options,
  onChange,
  label,
  cols = "grid-cols-3",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  cols?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("choice-grid", cols)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          data-selected={value === option.value}
          className="choice focus-ring"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function PushToTalkKeyRow({
  keyCode,
  onChange,
}: {
  keyCode: string;
  onChange: (code: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setCapturing(false);
        return;
      }
      if (e.code === "Tab" || e.code.startsWith("F")) return;
      onChange(e.code);
      setCapturing(false);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, onChange]);

  return (
    <div className="set-row border-t border-white/[0.06]">
      <div className="set-row-copy">
        <span className="set-row-label">Shortcut</span>
        <span className="set-row-hint">Press and hold this key to talk.</span>
      </div>
      <button
        type="button"
        onClick={() => setCapturing(true)}
        className={cn(
          "set-btn focus-ring min-w-[6.5rem] font-mono text-[11px]",
          capturing && "set-btn--accent",
        )}
      >
        {capturing ? "Press a key…" : formatKeyCode(keyCode)}
      </button>
    </div>
  );
}
