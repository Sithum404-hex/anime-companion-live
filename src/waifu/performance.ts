export type QualityTier = "low" | "medium" | "high";

export interface QualitySettings {
  tier: QualityTier;
  pixelRatio: number;
  animationSkip: number;
  lipSyncSkip: number;
  expressionSkip: number;
  proceduralIdle: boolean;
  renderScale: number;
  fftSize: number;
  motionDetectRes: number;
  /** Fixed physics step rate: 60 low / 90 medium / 120 high. */
  physicsHz: number;
  /** Constraint iterations per physics substep. */
  physicsIterations: number;
  /** Flutter/wave overlay forces (off on low). */
  physicsFlutter: boolean;
  /** Active collider set: head only / head+spine / full. */
  physicsColliders: "head" | "headSpine" | "full";
}

export function detectQualityTier(): QualityTier {
  // SSR / server functions have no navigator or window — this runs at module
  // scope via DEFAULT_SETTINGS, so it must never throw off the client.
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "medium";
  }
  let score = 0;
  if (navigator.hardwareConcurrency) {
    if (navigator.hardwareConcurrency >= 8) score += 2;
    else if (navigator.hardwareConcurrency >= 4) score += 1;
  }
  const dpr = window.devicePixelRatio || 1;
  if (dpr >= 2) score += 2;
  else if (dpr >= 1.5) score += 1;
  if ("deviceMemory" in navigator) {
    const mem = (navigator as Navigator & { deviceMemory: number }).deviceMemory;
    if (mem >= 4) score += 2;
    else if (mem >= 2) score += 1;
  }
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile) score -= 1;
  if (score <= 1) return "low";
  if (score <= 3) return "medium";
  return "high";
}

export function getQualitySettings(tier: QualityTier): QualitySettings {
  switch (tier) {
    case "low":
      return {
        tier: "low",
        pixelRatio: 0.75,
        animationSkip: 3,
        lipSyncSkip: 3,
        expressionSkip: 2,
        proceduralIdle: false,
        renderScale: 0.6,
        fftSize: 128,
        motionDetectRes: 80,
        physicsHz: 60,
        physicsIterations: 1,
        physicsFlutter: false,
        physicsColliders: "head",
      };
    case "medium":
      return {
        tier: "medium",
        pixelRatio: 1.0,
        animationSkip: 1,
        lipSyncSkip: 2,
        expressionSkip: 1,
        proceduralIdle: true,
        renderScale: 0.8,
        fftSize: 256,
        motionDetectRes: 120,
        physicsHz: 90,
        physicsIterations: 2,
        physicsFlutter: true,
        physicsColliders: "headSpine",
      };
    case "high":
      return {
        tier: "high",
        pixelRatio: typeof window !== "undefined" ? Math.min(window.devicePixelRatio, 1.25) : 1,
        animationSkip: 0,
        lipSyncSkip: 0,
        expressionSkip: 0,
        proceduralIdle: true,
        renderScale: 1.0,
        fftSize: 256,
        motionDetectRes: 100,
        physicsHz: 80,
        physicsIterations: 2,
        physicsFlutter: true,
        physicsColliders: "full",
      };
  }
}

/** User-selectable frame-rate ceiling. */
export type FpsCap = "30" | "60" | "uncapped";

/** Minimum frame interval in ms for each cap; 0 means "no ceiling". */
export const FPS_CAP_MS: Record<FpsCap, number> = {
  "30": 1000 / 30,
  "60": 1000 / 60,
  uncapped: 0,
};

/**
 * Resolve the effective frame ceiling in milliseconds (0 = uncapped).
 *
 * Max Performance takes priority over the cap selector, and it does so here
 * rather than at the call site: the cap is a request about how much work the
 * machine should do, while Max Performance is a promise that smoothness wins.
 * A promise outranks a request, so enabling it releases the ceiling entirely.
 * Resolving it in one place keeps that ordering from depending on which code
 * path happens to read the setting.
 */
export function resolveFpsCapMs(cap: FpsCap, maxPerf: boolean): number {
  if (maxPerf) return FPS_CAP_MS.uncapped;
  // Unknown values (older or hand-edited localStorage) fall back to uncapped,
  // which is the pre-existing behaviour and can never be a surprise slowdown.
  return FPS_CAP_MS[cap] ?? FPS_CAP_MS.uncapped;
}

const listeners = new Set<() => void>();

export function onPageVisible(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function onPageHidden(fn: () => void) {
  const handler = () => {
    if (document.hidden) fn();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

export function createVisibilityPause() {
  // Seed from the live value: a page mounted into an already-hidden tab would
  // otherwise report itself as visible until the first visibilitychange fired.
  let paused = document.hidden;
  const handleVisibility = () => {
    paused = document.hidden;
  };
  document.addEventListener("visibilitychange", handleVisibility);
  return {
    get paused() {
      return paused;
    },
    dispose: () => document.removeEventListener("visibilitychange", handleVisibility),
  };
}
