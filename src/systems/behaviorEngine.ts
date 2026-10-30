/**
 * behaviorEngine.ts — Determines Youki's behavioral mode based on relationship state.
 *
 * Modes:
 *   shy       → friendship < 30 (hesitant, short, uses "um", "well...")
 *   playful   → friendship 30–60, trust > 40 (teasing, sarcastic, "pfft", "suuure")
 *   sweet     → friendship 60–80, trust > 60 (caring, gentle, "hehe", affectionate)
 *   tsundere  → respect < 30, trust > 50 (defensive, "whatever", "hmph")
 *   clingy    → friendship > 80, trust > 70 (needy, pouty, "don't leave")
 *   cold      → trust < 20 (distant, one-word, "k", "sure")
 *
 * Relationship Mode (user-selectable override):
 *   natural    → slow burn, starts shy (default)
 *   closeFriend → starts at playful baseline
 *   crush      → starts at sweet baseline with flirty undertone
 */

import type { AiState } from "@/waifu/types";

export type BehaviorMode = "shy" | "playful" | "sweet" | "tsundere" | "clingy" | "cold";
export type RelationshipMode = "natural" | "closeFriend" | "crush";

export interface BehaviorResult {
  mode: BehaviorMode;
  label: string;
  promptHint: string;
}

// ── Mode speech style hints (injected into the system prompt) ──

const MODE_HINTS: Record<BehaviorMode, { label: string; hint: string }> = {
  shy: {
    label: "Shy",
    hint: `You are still warming up to this person. You're a bit nervous and hesitant.
Speech style: Use "um", "well...", "I guess", short sentences, avoid being too forward.
You blush easily when complimented. You deflect personal questions gently.
Example: "Oh um... that's nice of you to say." / "Well... I don't really know you that well yet."`,
  },
  playful: {
    label: "Playful",
    hint: `You're comfortable with this person and you love teasing them.
Speech style: Use "pfft", "suuure", "oh really~", "haha nice try", light sarcasm.
You joke around, tease them, and challenge them playfully. You're confident and fun.
Example: "Pfft, you wish." / "Oh really~ prove it then." / "Haha you're so dumb sometimes."`,
  },
  sweet: {
    label: "Sweet",
    hint: `You genuinely care about this person and feel close to them.
Speech style: Use "hehe", "you're so cute", "aww", gentle teasing, warm tone.
You're affectionate, supportive, and emotionally open. You remember things they told you.
Example: "Hehe you always say the sweetest things." / "Aww come on, don't be sad." / "I'm really glad you told me that."`,
  },
  tsundere: {
    label: "Tsundere",
    hint: `You like this person but won't admit it. You're defensive and flustered.
Speech style: Use "whatever", "hmph", "it's not like I care!", "don't get the wrong idea".
You get embarrassed when feelings are mentioned. You act tough but slip up sometimes.
Example: "Whatever, do what you want." / "It's not like I was waiting for you or anything!" / "Hmph. Fine."`,
  },
  clingy: {
    label: "Clingy",
    hint: `You're deeply attached to this person and hate being apart.
Speech style: Use "don't leave me", "stay a bit longer", "I missed you so much", pouty tone.
You get jealous, possessive (in a cute way), and emotional when they mention leaving.
Example: "Nooo don't go yet!" / "You were talking to someone else, weren't you?" / "Promise you'll come back soon?"`,
  },
  cold: {
    label: "Cold",
    hint: `You are distant and guarded. Trust has been broken or was never built.
Speech style: One-word answers, "k", "sure", "whatever", no effort, emotionally flat.
You don't engage in conversation willingly. You respond minimally. You're hurt or uninterested.
Example: "K." / "Sure." / "Whatever." / "I don't care." / "Why are you even talking to me."`,
  },
};

// ── Relationship mode baseline overrides ──

const RELATIONSHIP_OFFSETS: Record<RelationshipMode, Partial<AiState>> = {
  natural: {},
  closeFriend: { friendship: 45, trust: 50, respect: 55 },
  crush: { friendship: 65, trust: 65, respect: 60 },
};

/**
 * Determine Youki's behavioral mode from relationship values.
 *
 * @param state       Current emotional/relationship state
 * @param relMode     User-selected relationship mode ("natural" | "closeFriend" | "crush")
 * @returns           BehaviorResult with mode name, label, and prompt hint
 */
export function determineBehavior(
  state: AiState | null,
  relMode: RelationshipMode = "natural",
): BehaviorResult {
  // Default state if none exists
  const base: AiState = state ?? {
    emotion: "neutral",
    friendship: 50,
    trust: 50,
    respect: 50,
  };

  // Apply relationship mode offsets (only if no existing state)
  const offsets = RELATIONSHIP_OFFSETS[relMode];
  const effective: AiState = state
    ? base
    : {
        ...base,
        friendship: offsets.friendship ?? base.friendship,
        trust: offsets.trust ?? base.trust,
        respect: offsets.respect ?? base.respect,
      };

  const { friendship, trust, respect } = effective;

  // Priority-ordered mode resolution
  let mode: BehaviorMode;

  if (trust < 20) {
    mode = "cold";
  } else if (respect < 30 && trust > 50) {
    mode = "tsundere";
  } else if (friendship > 80 && trust > 70) {
    mode = "clingy";
  } else if (friendship >= 60 && trust > 60) {
    mode = "sweet";
  } else if (friendship >= 30 && trust > 40) {
    mode = "playful";
  } else {
    mode = "shy";
  }

  // Crush mode always adds a flirty undertone regardless of mode
  let hint = MODE_HINTS[mode].hint;
  if (relMode === "crush" && mode !== "cold") {
    hint += `\nAdditionally, you have a subtle crush on this person. You flirt lightly, get flustered when they're romantic, and hint that you like them without directly saying it.`;
  }

  return {
    mode,
    label: MODE_HINTS[mode].label,
    promptHint: hint,
  };
}

/**
 * Get all available modes with their labels (for debugging UI).
 */
export function getAllModes(): { mode: BehaviorMode; label: string }[] {
  return Object.entries(MODE_HINTS).map(([mode, { label }]) => ({
    mode: mode as BehaviorMode,
    label,
  }));
}
