/**
 * HUD design tokens.
 *
 * The character is the hero and she is fully lit; every console surface is
 * built from the `.glass` layer in `styles.css` so it sits above the scene
 * instead of tinting it. The single expressive element in the whole UI is the
 * ACCENT — and it is not a brand color: it is tinted from whatever she is
 * feeling right now. Her mood is the only thing in this app worth coloring,
 * so the console borrows it and nothing else does.
 */

import type { AiEmotion } from "./types";

/**
 * Mood → accent. Warm hues for good moods, cool for low, ember for hot.
 * Chosen to stay legible as a thin rim, a small dot and a bubble fill on a
 * dark layer, so each value is a mid-tone rather than a saturated fill.
 */
const EMOTION_ACCENT: Record<string, string> = {
  happy: "#F2C14E",
  excited: "#FB8C3C",
  bashful: "#F08CA0",
  embarrassed: "#F08CA0",
  angry: "#E4573D",
  annoyed: "#D97A46",
  sad: "#7C8BD4",
  nervous: "#6FC3D6",
  neutral: "#9AA6BF",
};

export const DEFAULT_ACCENT = EMOTION_ACCENT.neutral;

/** Accent hex for an emotion (falls back to neutral for unknown tags). */
export function accentForEmotion(emotion: string | null | undefined): string {
  if (!emotion) return DEFAULT_ACCENT;
  return EMOTION_ACCENT[emotion.toLowerCase()] ?? DEFAULT_ACCENT;
}

/** Root CSS custom properties for the console. */
export function hudVars(accent: string): React.CSSProperties {
  return {
    ["--hud-accent" as string]: accent,
  } as React.CSSProperties;
}

/**
 * Console surfaces. All three share the `.glass` layer from `styles.css`;
 * these are just the density/radius pairings each role needs.
 */
export const GLASS_PANEL = "glass";
export const GLASS_CHIP = "glass--chip";
export const GLASS_WELL = "glass--well";

/** Interaction affordances. */
export const GLASS_PRESS = "glass-press";
export const GLASS_FOCUS = "glass-ring";

export const HUD_DIM = "text-white/45";
export const HUD_TEXT = "text-white/90";
