import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import type { Settings, ModelManifest } from "@/waifu/types";

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (s: Settings) => void;
}

const BACKGROUNDS = [
  { id: "/backgrounds/bg1.jpg", label: "Cozy Room" },
  { id: "/backgrounds/bg2.jpg", label: "Neon Night" },
  { id: "color:#0b0b14", label: "Pure Dark" },
  { id: "color:#fcfbf8", label: "Soft Cream" },
];

export function SettingsPanel({ open, onClose, settings, onChange }: Props) {
  const [manifest, setManifest] = useState<ModelManifest | null>(null);

  useEffect(() => {
    fetch("/models/manifest.json")
      .then((r) => r.json())
      .then(setManifest)
      .catch(() => setManifest({ models: [{ id: "waifu", label: "Waifu", file: "/models/waifu.vrm" }] }));
  }, []);

  const update = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto border-l border-border bg-card/95 backdrop-blur-xl p-6 text-card-foreground shadow-2xl"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 240 }}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close settings">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <section className="space-y-2 mb-6 rounded-lg border border-border/50 bg-muted/40 p-3">
              <Label className="text-sm font-medium">AI Engine</Label>
              <p className="text-xs text-muted-foreground">
                Powered by Lovable AI — no setup needed. Just start chatting and she'll reply with voice and animations 💕
              </p>
            </section>

            <section className="space-y-3 mb-6">
              <Label>Character</Label>
              <div className="grid grid-cols-2 gap-2">
                {manifest?.models.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => update("modelId", m.id)}
                    className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                      settings.modelId === m.id
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-primary/50"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Add more <code>.vrm</code> files to <code>/public/models/</code> and list them in <code>manifest.json</code>.
              </p>
            </section>

            <section className="space-y-3 mb-6">
              <Label>Background</Label>
              <div className="grid grid-cols-2 gap-2">
                {BACKGROUNDS.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => update("background", b.id)}
                    className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                      settings.background === b.id
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-primary/50"
                    }`}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="space-y-4 mb-6">
              <ToggleRow label="Voice (TTS)" v={settings.voiceEnabled} on={(v) => update("voiceEnabled", v)} />
              <ToggleRow label="Microphone (sound reactions)" v={settings.micEnabled} on={(v) => update("micEnabled", v)} />
              <ToggleRow label="Webcam (motion reactions)" v={settings.webcamEnabled} on={(v) => update("webcamEnabled", v)} />
            </section>

            <section className="space-y-5">
              <SliderRow label="Sound sensitivity" v={settings.soundSensitivity} on={(v) => update("soundSensitivity", v)} />
              <SliderRow label="Motion sensitivity" v={settings.motionSensitivity} on={(v) => update("motionSensitivity", v)} />
              <SliderRow label="Voice pitch" v={settings.pitch / 2} on={(v) => update("pitch", v * 2)} display={settings.pitch.toFixed(2)} />
              <SliderRow label="Voice rate" v={settings.rate / 2} on={(v) => update("rate", v * 2)} display={settings.rate.toFixed(2)} />
              <SliderRow label="Volume" v={settings.volume} on={(v) => update("volume", v)} />
            </section>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function ToggleRow({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="cursor-pointer">{label}</Label>
      <Switch checked={v} onCheckedChange={on} />
    </div>
  );
}

function SliderRow({
  label,
  v,
  on,
  display,
}: {
  label: string;
  v: number;
  on: (v: number) => void;
  display?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">{display ?? v.toFixed(2)}</span>
      </div>
      <Slider min={0} max={1} step={0.01} value={[v]} onValueChange={([n]) => on(n)} />
    </div>
  );
}
