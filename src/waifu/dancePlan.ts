/**
 * Per-song choreography plan.
 *
 * Once the analyzer is confident about the song's BPM/energy, the director
 * builds a rough 10-entry arc describing which "role" each section of the
 * song should play and at what energy. The plan is approximate on purpose —
 * the section tracker maps live energy onto INTRO/VERSE/BUILD/CHORUS/BREAK/
 * OUTRO and the director advances the plan index as sections change.
 *
 * Family keys resolved by the director against the dance database:
 *   main   – the dominant style of the song (hip hop / latin / belly / other)
 *   soft   – calmer complement for mid-song drops (rumba, twist, general)
 *   gentle – opening/closing wind-down moves (dancing, slow belly)
 */

import type { SongSection } from "./songSection";

export type PlanRole = "intro" | "verse" | "build" | "chorus" | "break" | "outro";
export type FamilyKey = "main" | "soft" | "gentle";

export interface PlanEntry {
  section: SongSection;
  role: PlanRole;
  familyKey: FamilyKey;
  targetEnergy: number;
}

export interface DancePlan {
  /** Dominant style driving the "main" entries ("" when tempo is unknown). */
  mainStyle: string;
  entries: PlanEntry[];
  seed: number;
}

const ARC: ReadonlyArray<{
  section: SongSection;
  role: PlanRole;
  familyKey: FamilyKey;
  targetEnergy: number;
}> = [
  { section: "INTRO", role: "intro", familyKey: "gentle", targetEnergy: 0.35 },
  { section: "VERSE", role: "verse", familyKey: "main", targetEnergy: 0.55 },
  { section: "BUILD", role: "build", familyKey: "main", targetEnergy: 0.7 },
  { section: "CHORUS", role: "chorus", familyKey: "main", targetEnergy: 0.85 },
  { section: "VERSE", role: "verse", familyKey: "main", targetEnergy: 0.55 },
  { section: "BUILD", role: "build", familyKey: "main", targetEnergy: 0.72 },
  { section: "CHORUS", role: "chorus", familyKey: "main", targetEnergy: 0.9 },
  { section: "BREAK", role: "break", familyKey: "soft", targetEnergy: 0.45 },
  { section: "CHORUS", role: "chorus", familyKey: "main", targetEnergy: 0.95 },
  { section: "OUTRO", role: "outro", familyKey: "gentle", targetEnergy: 0.3 },
];

/** Dominant style for a song profile. */
export function dominantStyleFor(bpm: number, confidence: number, energy: number): string {
  if (confidence < 0.4) return "";
  if (bpm >= 118 || energy >= 0.7) return "hiphop";
  if (bpm >= 88 && energy >= 0.35) return "latin";
  return "other";
}

/** Deterministic 0..1 jitter from a seed + salt (keeps per-song variation stable). */
function jitter(seed: number, salt: number): number {
  let x = (seed * 2654435761) ^ (salt * 40503);
  x = (x ^ (x >>> 16)) * 2246822519;
  x = x ^ (x >>> 13);
  return ((x >>> 0) % 1000) / 1000;
}

export function buildDancePlan(opts: {
  bpm: number;
  confidence: number;
  energy: number;
  seed: number;
}): DancePlan {
  const mainStyle = dominantStyleFor(opts.bpm, opts.confidence, opts.energy);
  const seed = opts.seed >>> 0;

  const entries = ARC.map((e) => ({ ...e }));

  // Seeded variation so two songs with the same profile still differ:
  //   - jitter target energy a little,
  //   - sometimes swap one entry to the soft family (varying the middle),
  //   - sometimes drop the second verse for a shorter build into the peak.
  for (const entry of entries) {
    entry.targetEnergy = Math.min(
      1,
      Math.max(0.2, entry.targetEnergy + (jitter(seed, 7) - 0.5) * 0.08),
    );
  }
  if (jitter(seed, 11) < 0.35) {
    const idx = 4 + Math.floor(jitter(seed, 13) * 2);
    entries[idx].familyKey = "soft";
  }
  if (jitter(seed, 17) < 0.3) {
    entries.splice(4, 1);
  }

  return { mainStyle, entries, seed };
}
