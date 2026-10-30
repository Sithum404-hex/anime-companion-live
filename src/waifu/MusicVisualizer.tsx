import { useCallback, useEffect, useRef } from "react";
import type { AudioPlayerManager } from "@/systems/audioPlayer";
import { createVisibilityPause } from "@/waifu/performance";
import type { QualityTier } from "@/waifu/types";

/**
 * Visualizer v1 — mini spectrum + reactive glow for the music player.
 *
 * Architecture rules honoured here:
 * - Data comes ONLY from the existing audio pipeline: `AudioPlayerManager`
 *   hands over the exact frequency buffer `AudioAnalyzer` already read at
 *   ~25 Hz (no second AudioContext, no extra FFT reads). Smoothness comes
 *   from interpolating that 25 Hz snapshot at display rate.
 * - Bass for the glow reuses the manager's existing smoothed `bass` getter.
 * - One rAF loop for BOTH the canvas and the glow; it stops itself when
 *   nothing plays and everything has decayed, and it never schedules work
 *   while the tab is hidden (reuses the app's `createVisibilityPause`).
 * - Zero per-frame React state: all animation state lives in refs; DOM
 *   writes are canvas pixels + compositor-only `transform`/`opacity`.
 * - No 3D effects here. Per the roadmap, future 3D visualizers must gate on
 *   `qualityTier === "high"`; milestone 1 stays 2D canvas + CSS on all tiers
 *   (the glow IS the low-tier visualizer), with a DPR cap as the tier perk.
 */

const BAR_COUNT = 48;
/** Lowest bin mapped to a bar (bins 0-1 are DC/rumble, visually dead). */
const MIN_BIN = 2;
/** Music energy is negligible above ~72% of the bin range — don't map it. */
const MAX_BIN_SHARE = 0.72;
/** Seconds between accent-colour re-reads (the accent follows her mood). */
const ACCENT_POLL_S = 1;

interface Props {
  audioPlayer: AudioPlayerManager | null;
  isPlaying: boolean;
  qualityTier?: QualityTier;
}

/** Log-spaced [start, end) analyser-bin ranges, one per bar. */
function buildBands(binCount: number): Float64Array {
  const bands = new Float64Array(BAR_COUNT * 2);
  const minBin = Math.min(MIN_BIN, binCount - 1);
  const maxBin = Math.max(minBin + 1, Math.floor(binCount * MAX_BIN_SHARE));
  const ratio = maxBin / minBin;
  for (let i = 0; i < BAR_COUNT; i++) {
    const start = Math.floor(minBin * Math.pow(ratio, i / BAR_COUNT));
    const end = Math.max(start + 1, Math.floor(minBin * Math.pow(ratio, (i + 1) / BAR_COUNT)));
    bands[i * 2] = start;
    bands[i * 2 + 1] = Math.min(end, binCount);
  }
  return bands;
}

/** "#rrggbb" → "r, g, b" triplet, or null when the value isn't a hex colour. */
function hexToRgbTriple(hex: string): string | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return `${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}`;
}

export function MusicVisualizer({ audioPlayer, isPlaying, qualityTier = "medium" }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);

  // ── Animation state (refs — never React state) ──────────────────────────
  const playerRef = useRef<AudioPlayerManager | null>(audioPlayer);
  const playingRef = useRef(isPlaying);
  const visRef = useRef<ReturnType<typeof createVisibilityPause> | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);

  const barsRef = useRef(new Float32Array(BAR_COUNT));
  const peaksRef = useRef(new Float32Array(BAR_COUNT));
  const bandsRef = useRef<Float64Array | null>(null);
  const scratchRef = useRef(new Uint8Array(0));

  const glowValueRef = useRef(0);
  const glowOpacityRef = useRef(-1);
  const glowScaleRef = useRef(-1);

  const accentRef = useRef("rgb(154, 166, 191)");
  const accentRawRef = useRef("");
  const accentPollRef = useRef(0);
  const gradientRef = useRef<CanvasGradient | null>(null);

  /** Re-read `--hud-accent` occasionally; rebuild the gradient when it moves. */
  const refreshAccent = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const raw = getComputedStyle(canvas).getPropertyValue("--hud-accent").trim();
    if (!raw || raw === accentRawRef.current) return;
    const triple = hexToRgbTriple(raw) ?? (raw.includes("rgb") ? raw : null);
    if (!triple) return;
    accentRawRef.current = raw;
    accentRef.current = `rgb(${triple})`;
    gradientRef.current = null;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    if (W === 0 || H === 0) return;

    if (!gradientRef.current) {
      const g = ctx.createLinearGradient(0, H, 0, 0);
      g.addColorStop(0, accentRef.current.replace("rgb(", "rgba(").replace(")", ", 0.95)"));
      g.addColorStop(0.75, accentRef.current.replace("rgb(", "rgba(").replace(")", ", 0.55)"));
      g.addColorStop(1, accentRef.current.replace("rgb(", "rgba(").replace(")", ", 0.28)"));
      gradientRef.current = g;
    }

    ctx.clearRect(0, 0, W, H);

    const dpr = Math.max(1, H / Math.max(1, canvas.clientHeight || H));
    const gap = Math.max(1, Math.round(2 * dpr));
    const pad = gap;
    const barW = (W - pad * 2 - gap * (BAR_COUNT - 1)) / BAR_COUNT;
    const usable = H - gap * 2;

    const bars = barsRef.current;
    const peaks = peaksRef.current;

    ctx.fillStyle = gradientRef.current;
    for (let i = 0; i < BAR_COUNT; i++) {
      const h = Math.max(2 * dpr, bars[i] * usable);
      const x = pad + i * (barW + gap);
      const y = H - gap - h;
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(x, y, barW, h, Math.min(2 * dpr, barW / 2));
        ctx.fill();
      } else {
        ctx.fillRect(x, y, barW, h);
      }
    }

    // Falling peak caps, one style switch for all of them.
    ctx.fillStyle = accentRef.current.replace("rgb(", "rgba(").replace(")", ", 0.45)");
    for (let i = 0; i < BAR_COUNT; i++) {
      const x = pad + i * (barW + gap);
      const y = H - gap - peaks[i] * usable - 3 * dpr;
      ctx.fillRect(x, y, barW, Math.max(1, dpr));
    }
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    lastTsRef.current = 0;
    rafRef.current = requestAnimationFrame(frame);

    function frame(ts: number) {
      rafRef.current = null;
      const vis = visRef.current;
      if (!vis || vis.paused) return; // hidden tab — no work; restarts on visible

      const player = playerRef.current;
      const dt = lastTsRef.current ? Math.min((ts - lastTsRef.current) / 1000, 0.05) : 0.016;
      lastTsRef.current = ts;

      // Ensure the scratch buffer matches the analyser's bin count.
      const binCount = player ? player.spectrumBinCount : 0;
      if (binCount && scratchRef.current.length !== binCount) {
        scratchRef.current = new Uint8Array(binCount);
        bandsRef.current = null;
      }
      if (!bandsRef.current && binCount) bandsRef.current = buildBands(binCount);

      const playing = playingRef.current && !!player;
      const spectrumOk = playing && player ? player.getSpectrum(scratchRef.current) : false;
      const bands = spectrumOk ? bandsRef.current : null;

      // Bar targets from the 25 Hz snapshot, interpolated here for smoothness.
      const bars = barsRef.current;
      const peaks = peaksRef.current;
      const kUp = 1 - Math.exp(-dt * 30);
      const kDown = 1 - Math.exp(-dt * 9);
      for (let i = 0; i < BAR_COUNT; i++) {
        let target = 0;
        if (bands) {
          const s = bands[i * 2];
          const e = bands[i * 2 + 1];
          let max = 0;
          for (let b = s; b < e; b++) {
            const v = scratchRef.current[b];
            if (v > max) max = v;
          }
          // High-frequency tilt so the log-mapped tail doesn't look flat.
          target = Math.min(1, (max / 255) * (0.6 + 0.8 * (i / (BAR_COUNT - 1))));
        }
        bars[i] += (target - bars[i]) * (target > bars[i] ? kUp : kDown);
        peaks[i] = Math.max(bars[i], peaks[i] - dt * 0.5);
      }

      // Reactive glow — smoothed bass from the existing manager getter.
      const gTarget = playing && player ? player.bass : 0;
      const glowValue = glowValueRef.current;
      const nextGlow = glowValue + (gTarget - glowValue) * (1 - Math.exp(-dt * 5));
      glowValueRef.current = nextGlow;

      const glow = glowRef.current;
      if (glow) {
        const opacity = 0.1 + 0.42 * nextGlow;
        if (Math.abs(opacity - glowOpacityRef.current) > 0.004) {
          glowOpacityRef.current = opacity;
          glow.style.opacity = opacity.toFixed(3);
        }
        const sx = 1 + 0.07 * nextGlow;
        const sy = 1 + 0.09 * nextGlow;
        if (Math.abs(sx - glowScaleRef.current) > 0.002) {
          glowScaleRef.current = sx;
          glow.style.transform = `scale3d(${sx.toFixed(4)}, ${sy.toFixed(4)}, 1)`;
        }
      }

      // Accent follows her mood — poll it cheaply, rebuild gradient on change.
      accentPollRef.current += dt;
      if (accentPollRef.current >= ACCENT_POLL_S) {
        accentPollRef.current = 0;
        refreshAccent();
      }

      draw();

      // Fully idle (nothing playing, everything decayed) → stop scheduling.
      if (!spectrumOk && nextGlow < 0.004) {
        let settled = true;
        for (let i = 0; i < BAR_COUNT; i++) {
          if (bars[i] > 0.002 || peaks[i] > 0.002) {
            settled = false;
            break;
          }
        }
        if (settled) {
          lastTsRef.current = 0;
          return;
        }
      }
      rafRef.current = requestAnimationFrame(frame);
    }
  }, [draw, refreshAccent]);

  // Loop lifecycle: start on mount-if-playing, restart when visible again.
  useEffect(() => {
    const vis = createVisibilityPause();
    visRef.current = vis;
    const onVisibility = () => {
      if (!document.hidden && playingRef.current) startLoop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (playingRef.current) startLoop();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      vis.dispose();
      visRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [startLoop]);

  useEffect(() => {
    playingRef.current = isPlaying;
    if (isPlaying) startLoop();
  }, [isPlaying, startLoop]);

  useEffect(() => {
    playerRef.current = audioPlayer;
    if (audioPlayer && playingRef.current) startLoop();
  }, [audioPlayer, startLoop]);

  // Canvas sizing — ResizeObserver only; never inside the frame loop.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const dprCap = qualityTier === "low" ? 1 : 2;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const size = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (!w || !h) return;
      const W = Math.round(w * dpr);
      const H = Math.round(h * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        gradientRef.current = null;
      }
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [qualityTier]);

  return (
    <div className="relative">
      {/* Reactive background glow — compositor-only transform/opacity writes. */}
      <div
        ref={glowRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 rounded-2xl opacity-0 will-change-[transform,opacity]"
        style={{
          background:
            "radial-gradient(85% 90% at 50% 55%, color-mix(in oklab, var(--hud-accent) 38%, transparent), transparent 72%)",
          filter: "blur(18px)",
          transform: "scale3d(1, 1, 1)",
        }}
      />
      <div ref={wrapRef} className="h-14 w-full" aria-hidden>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      </div>
    </div>
  );
}
