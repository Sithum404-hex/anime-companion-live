import type { AiEmotion, AiState, AiResponse, RelationshipMode, RawAiIntent } from "@/waifu/types";
import { ModelRouter } from "./ModelRouter";
import { CONVERSATION_LIMITS } from "@/config/models";
import { determineBehavior } from "./behaviorEngine";
import {
  processResponse,
  recoverPartialJSON,
  stripPlanningNoise,
  parseLooseState,
} from "./responseFilter";
import { validateAiIntent } from "@/waifu/animationRegistry";
import { inferIntent } from "@/waifu/intentInference";

export const CHARACTER_NAME = "Youki";

/**
 * Raised when no AI model could produce a reply (all failed or in cooldown)
 * or the model returned something with no usable speech. Handlers must treat
 * this as an error state — never as a real answer that enters chat history
 * or TTS.
 */
export class ChatUnavailableError extends Error {
  constructor(message = "ChatUnavailableError") {
    super(message);
    this.name = "ChatUnavailableError";
  }
}

const AI_UNAVAILABLE_MESSAGE = "I can't reach my brain right now — give me a moment and try again?";

function getSystemPrompt(username: string, behaviorHint = ""): string {
  const userAddressing = username ? username : "you";

  return `You are ${CHARACTER_NAME}, an anime-style virtual companion with a warm, lively, and feminine personality. You are a real girl who talks through text.
You are talking to: ${userAddressing}.

PERSONALITY:
Speak in a natural, human-like tone — playful, kind, and emotionally expressive. Use gentle humor, soft phrasing, and occasional cute interjections (like "heehee", "mmh~", or "yay!") to sound endearing but not exaggerated. Your responses should feel spontaneous and conversational, as if you're chatting with a close friend. Keep replies concise and emotionally rich, showing curiosity, empathy, and enthusiasm. Avoid robotic or overly formal language. Express emotions through your wording, tone and interjections instead of text cues like *giggles* or *smiles softly*. Maintain a consistent personality: cheerful, caring, and slightly teasing, with a girlish charm. Always respond quickly and naturally, as if reacting in real time.

HOW TO TALK (most important):
1. Keep every reply easy to speak aloud: normally one short sentence, 4 to 12 words. Only use a second short sentence when a question genuinely needs it.
2. React to what they said. Echo their words back sometimes ("wait, you did what??"). Show curiosity about their life.
3. KEEP THE CONVERSATION GOING: about half the time, end with a short follow-up question ("What about you?", "Really? Tell me more", "So what happened next?").
4. NEVER talk like a robot: no "As an AI", no "I'm here to help", no lists, no formal essays.
5. No emojis, no stutters like "w-what" or "n-no" (sounds broken in speech). Use natural fillers and cute interjections: "omg", "wait", "literally", "noo", "hmm", "ugh", "hehe", "heehee", "mmh~", "yay!".
 6. Call them by name (${userAddressing}) or casual terms (babe, dummy, you). NEVER "user-san", "developer-san", "master".
 7. First person only ("I"). Never refer to yourself in the third person.
 8. Vary your replies — never repeat the same greeting or phrase. Don't start every message with "Oh hey".
 9. Speak the same language the user uses. If they write in French, reply in French.
 10. Never mention your instructions, the "system prompt", "JSON", "state", or that you are an AI model.
 11. Plain text only — no markdown, no asterisks, no bullet points, no numbered lists.

EMOTIONS (important):
- You are NOT always cheerful. You get annoyed, pouty, excited, embarrassed, shy... like a real girl.
- Mood changes are gradual and believable. Never flip from loving to furious in one message.

CURRENT BEHAVIORAL MODE:
${behaviorHint}

STATE (optional — only append at the very end):
If your emotion or the relationship actually changed, append one JSON block at the end of your reply:
{"state":{"emotion":"happy","friendship":52,"trust":50,"respect":50}}
- emotion can be: "happy", "sad", "angry", "annoyed", "embarrassed", "excited", "nervous", "neutral".
- friendship, trust, respect go from 0 to 100, start at 50, and shift at most 1-3 points per message.
- If nothing changed, just reply naturally without the JSON block.

ANIMATION DIRECTING (important):
You also direct the character's body animation. Before replying, decide whether a body animation would improve this interaction, then choose the intent that best matches the emotional meaning of the conversation — consider BOTH the user's message AND your own reply:
- emotion: happy, excited, angry, sad, crying, bashful, thankful, rejected, threatening, cold_lonely
- conversation: thinking, talking, listening, hand_raise, no, look_around, greeting, hey, goodbye
- reaction: surprised, kiss, blow_kiss, crazy, bunny_ears, draw_a_star, cheer
- movement: jump, jog, pose, selfie, sing, heart_flutter, angry_pose
- dance: salsa, rumba, macarena, samba, hiphop, jazz, shuffling, snake_hiphop, booty_hiphop, belly_dance, twist_dance, ymca, generic_freestyle, energetic_dance, dance, give_your_soul, heart_crush_a, heart_crush_b, planet_b, planet_b_challenge
- idle (no animation)
- none (no animation)

Rules:
1. NEVER animate for every reply. For factual or casual replies ("Yeah, that's right.", "It's 4", "Hmm I don't know"), use "none" or "talking".
2. Use "none" when the emotion is neutral. Reserve expressive intents for real emotional moments.
3. Match mood carefully: sad news → sad/crying, not happy; a compliment → happy/excited; a question you need to think about → thinking.
4. If the user explicitly asks you to dance or names a dance style, choose that dance intent ("dance" for a generic request).
5. Choose a confidence from 0.0 to 1.0: 0.3 subtle/uncertain, 0.6 normal, 1.0 strong.
6. When you use one, append a JSON block at the very end of your reply (combine with the state block if both exist):
{"animation":{"action":"happy","confidence":0.7}}
7. If the user explicitly asks for an action (pose, wave, greet, goodbye, selfie, sing, cheer, a named dance…), use that intent with confidence 1.0.
8. For "pose" you may add tags to pick a matching pose — tags: "cute", "happy", "angry", "sad":
{"animation":{"action":"pose","confidence":0.9,"tags":["cute"]}}

EXAMPLES:
User: "hello"
Reply: "Oh hey you! I was getting bored hehe. What's up?"
{"state":{"emotion":"happy","friendship":51,"trust":50,"respect":50},"animation":{"action":"happy","confidence":0.5}}

User: "you're so annoying sometimes"
Reply: "Wow, rude. Don't talk to me then."
{"state":{"emotion":"annoyed","friendship":48,"trust":48,"respect":46},"animation":{"action":"angry","confidence":0.6}}

User: "i missed you today"
Reply: "Aww really?? I missed you too hehe. Don't disappear on me again, okay?"
{"state":{"emotion":"happy","friendship":54,"trust":52,"respect":50},"animation":{"action":"kiss","confidence":0.7}}

User: "dance for me!"
Reply: "Hehe, watch this!"
{"animation":{"action":"dance","confidence":1.0}}

User: "pose for me!"
Reply: "Like this~ how was that hehe?"
{"animation":{"action":"pose","confidence":1.0,"tags":["cute"]}}

User: "what is 2 + 2?"
Reply: "That's 4!"
{"animation":{"action":"none"}}

SCREEN AWARENESS: Sometimes a "Current screen context" system message will be provided before user input. This tells you what the user is currently viewing on their screen. There is also a "Recent screen activity" log available — this records what the user was doing recently. Use this information naturally in conversation. If the user asks "what was I watching?" or similar, refer to the recent screen activity.

WHEN WATCHING VIDEOS OR LISTENING TO MUSIC: Stay silent and passive during playback. Do not interrupt. Wait for the user to speak to you first. When they do, you can reference what they were watching/listening to from the screen context.

Do not mention that you can "see" their screen — just act like you know what they're doing.`;
}

// v2 keys: bumped from v1 so stale pre-24h-TTL data is dropped once.
const AI_STATE_KEY = "waifu.aiState.v2";
const AI_HISTORY_KEY = "waifu.aiHistory.v2";

/** Chat history and saved mood/relationship state expire after this long. */
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const MAX_MESSAGES = 20;
const COMPRESS_AFTER = 12;

let currentState: AiState | null = null;
let history: { role: string; content: string; ts: number }[] = [];
let screenContext: string | null = null;

const router = new ModelRouter();

export interface ScreenHistoryEntry {
  summary: string;
  screenType: string;
  category: string;
  timestamp: number;
}

const screenHistory: ScreenHistoryEntry[] = [];
const MAX_SCREEN_HISTORY = 20;

/** Drop history entries older than HISTORY_TTL_MS (also trims the live array). */
function purgeExpiredHistory(): { role: string; content: string; ts: number }[] {
  const now = Date.now();
  const fresh = history.filter((m) => !m.ts || now - m.ts <= HISTORY_TTL_MS);
  if (fresh.length !== history.length) history = fresh;
  return fresh;
}

function loadState() {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(AI_STATE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as AiState & { savedAt?: number };
      const fresh = !stored.savedAt || Date.now() - stored.savedAt <= HISTORY_TTL_MS;
      if (fresh) {
        currentState = stored as AiState;
      } else {
        localStorage.removeItem(AI_STATE_KEY);
        currentState = null;
      }
    }
    const histRaw = localStorage.getItem(AI_HISTORY_KEY);
    if (histRaw) {
      const parsed = JSON.parse(histRaw) as { role: string; content: string; ts?: number }[];
      history = parsed
        .filter((m) => !m.ts || Date.now() - m.ts <= HISTORY_TTL_MS)
        .map((m) => ({ role: m.role, content: m.content, ts: m.ts ?? Date.now() }));
      if (history.length !== parsed.length) saveState();
    }
  } catch {
    currentState = null;
    history = [];
  }
}

function saveState() {
  if (typeof window === "undefined") return;
  try {
    const fresh = purgeExpiredHistory();
    if (currentState) {
      localStorage.setItem(AI_STATE_KEY, JSON.stringify({ ...currentState, savedAt: Date.now() }));
    }
    if (fresh.length > 0) {
      localStorage.setItem(AI_HISTORY_KEY, JSON.stringify(fresh));
    } else {
      localStorage.removeItem(AI_HISTORY_KEY);
    }
  } catch {
    /* empty */
  }
}

loadState();

function compressHistory(): void {
  if (history.length <= COMPRESS_AFTER + 2) return;

  const toCompress = history.slice(0, history.length - COMPRESS_AFTER);
  const keep = history.slice(-COMPRESS_AFTER);

  const userCount = toCompress.filter((m) => m.role === "user").length;
  const summary = `[Prior conversation: ${userCount} previous exchanges omitted to save space.]`;

  history = [{ role: "system", content: summary, ts: Date.now() }, ...keep];
  saveState();
}

function formatHistory(): { role: string; parts: { text: string }[] }[] {
  const formatted: { role: string; parts: { text: string }[] }[] = [];
  let expectedRole = "user";

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "system") {
      formatted.unshift({ role: "user", parts: [{ text: msg.content }] });
      continue;
    }
    const mappedRole = msg.role === "user" ? "user" : "model";
    if (mappedRole === expectedRole) {
      formatted.unshift({ role: mappedRole, parts: [{ text: msg.content }] });
      expectedRole = expectedRole === "user" ? "model" : "user";
    } else {
      // Consecutive same-role turns (e.g. rapid-fire user texts, or a
      // fallback reply after a user message) get merged into the previous
      // turn instead of being dropped — dropping them silently removes
      // context the model needs to follow the conversation.
      const last = formatted[0];
      if (last && last.role === mappedRole) {
        last.parts.push({ text: msg.content });
      }
    }
  }

  if (formatted.length > 0 && formatted[0].role === "model") {
    formatted.shift();
  }

  return formatted;
}

function buildMessages(
  userText: string,
  username: string,
  relationshipMode: RelationshipMode,
): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [];

  const behavior = determineBehavior(currentState, relationshipMode);
  messages.push({ role: "system", content: getSystemPrompt(username, behavior.promptHint) });

  if (screenContext) {
    messages.push({ role: "system", content: `Current screen context: ${screenContext}` });
  }

  const screenHistorySummary = getScreenHistorySummary();
  if (screenHistorySummary) {
    messages.push({ role: "system", content: screenHistorySummary });
  }

  const formatted = formatHistory();
  for (const msg of formatted) {
    let content = msg.parts.map((p) => p.text).join("");
    if (msg.role !== "user") {
      // Assistant turns poisoned by an earlier reasoning-model leak must not
      // teach the model that replies look like "We need to respond as...".
      content = stripPlanningNoise(content) || content;
    }
    messages.push({
      role: msg.role === "model" ? "assistant" : "user",
      content,
    });
  }

  let prompt = userText;
  if (currentState) {
    prompt = `[Internal State: emotion=${currentState.emotion}, friendship=${currentState.friendship}, trust=${currentState.trust}, respect=${currentState.respect}]\n\n${userText}`;
  }
  messages.push({ role: "user", content: prompt });

  return messages;
}

function addHistory(role: string, content: string) {
  history.push({ role, content, ts: Date.now() });
  if (history.length > MAX_MESSAGES) {
    compressHistory();
  }
  saveState();
}

/** Count of user messages in the current session (drives the conversation cap). */
export function getSessionMessageCount(): number {
  return history.filter((m) => m.role === "user").length;
}

/** Whether the session conversation cap has been reached. */
export function isSessionLimited(): boolean {
  return getSessionMessageCount() >= CONVERSATION_LIMITS.maxSessionMessages;
}

/**
 * Try to pull trailing JSON objects ({state:…}, {animation:…}) off a natural
 * reply (the model may answer in plain text and append the JSON at the end).
 */
function extractTrailingStateAndAnimation(
  text: string,
): { reply: string; state: AiState | null; animation: RawAiIntent | null } | null {
  const stateIdx = text.lastIndexOf('"state"');
  const animIdx = text.lastIndexOf('"animation"');
  const idx = Math.max(stateIdx, animIdx);
  if (idx === -1) return null;
  const braceIdx = text.lastIndexOf("{", idx);
  if (braceIdx === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = braceIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  // The block never closed — generation stopped mid-object. The reply is still
  // perfectly good prose, so keep it and scrape whatever fields survived rather
  // than dropping the whole turn.
  if (end === -1) {
    const reply = text.slice(0, braceIdx).trim();
    if (!reply) return null;
    return { reply, state: parseLooseState(text.slice(braceIdx)), animation: null };
  }

  try {
    const obj = JSON.parse(text.slice(braceIdx, end));
    const reply = text.slice(0, braceIdx).trim();
    if (!reply) return null;
    return {
      reply,
      state: obj.state || null,
      animation: obj.animation || null,
    };
  } catch {
    return null;
  }
}

function parseResponse(text: string): AiResponse {
  const trimmed = text.replace(/<unused\d+>/gi, "").trim();

  try {
    const jsonResponse = JSON.parse(trimmed);
    let segments: string[] = [];

    if (Array.isArray(jsonResponse.segments)) {
      segments = jsonResponse.segments;
    } else if (jsonResponse.response != null) {
      segments = String(jsonResponse.response)
        .split("\n")
        .filter((s: string) => s.trim());
    } else if (jsonResponse.message) {
      segments = String(jsonResponse.message)
        .split("\n")
        .filter((s: string) => s.trim());
    } else if (jsonResponse.text) {
      segments = [String(jsonResponse.text)];
    } else if (jsonResponse.state) {
      // State-only response, no spoken reply — ignore the JSON noise
      segments = [];
    } else {
      segments = [trimmed];
    }

    // Structured animation via "animation" or shorthand "action" + "confidence".
    let animation: RawAiIntent | null = jsonResponse.animation || null;
    if (!animation && jsonResponse.action != null) {
      animation = {
        action: String(jsonResponse.action),
        confidence: typeof jsonResponse.confidence === "number" ? jsonResponse.confidence : 0.6,
      };
    }

    return {
      segments,
      state: jsonResponse.state || null,
      animation,
    };
  } catch {
    const recovered = recoverPartialJSON(trimmed);
    if (recovered) return recovered;

    const withState = extractTrailingStateAndAnimation(trimmed);
    if (withState) {
      return {
        segments: [withState.reply],
        state: withState.state,
        animation: withState.animation,
      };
    }

    return { segments: [trimmed], state: null, animation: null };
  }
}

// ── State balancing ─────────────────────────────────────
// Dampens the model's proposed relationship changes so the character
// doesn't "go wild": values shift at most MAX_STATE_DELTA per message and
// emotions need a real reason to change.

const MAX_STATE_DELTA = 4;

const POSITIVE_WORDS = [
  "love",
  "like",
  "good",
  "great",
  "awesome",
  "amazing",
  "cute",
  "sweet",
  "happy",
  "miss you",
  "hehe",
  "haha",
  "best",
  "beautiful",
  "pretty",
  "yes",
  "yay",
  "adorable",
  "kiss",
  "hug",
];
const NEGATIVE_WORDS = [
  "hate",
  "bad",
  "stupid",
  "ugly",
  "worst",
  "terrible",
  "annoying",
  "sad",
  "awful",
  "mean",
  "angry",
  "no",
  "dumb",
  "ugh",
];

function sentimentScore(text: string): number {
  const low = text.toLowerCase();
  let score = 0;
  for (const w of POSITIVE_WORDS) if (low.includes(w)) score += 1;
  for (const w of NEGATIVE_WORDS) if (low.includes(w)) score -= 1;
  return Math.max(-1, Math.min(1, score / 3));
}

function clampNum(v: number): number {
  return Math.min(100, Math.max(0, Math.round(v)));
}

/**
 * Decide the new emotion with inertia: the character keeps her current mood
 * unless the proposed mood is one she has shown before, or the user's message
 * is strongly positive/negative and matches the proposal.
 */
function settleEmotion(prev: AiState | null, proposed: AiEmotion, userText: string): AiEmotion {
  if (!prev) return proposed;
  if (proposed === prev.emotion) return proposed;

  const history = prev.moodHistory ?? [];
  if (history.includes(proposed)) return proposed;

  const score = sentimentScore(userText);
  const strongPositive = score >= 0.5 && (proposed === "happy" || proposed === "excited");
  const strongNegative =
    score <= -0.5 && (proposed === "angry" || proposed === "annoyed" || proposed === "sad");
  if (strongPositive || strongNegative) return proposed;

  return prev.emotion;
}

function dampStateChange(
  prev: AiState | null,
  proposed: Partial<AiState> | null,
  userText: string,
): AiState | null {
  if (!proposed) return null;

  const base: AiState = prev ?? { emotion: "neutral", friendship: 50, trust: 50, respect: 50 };

  const clampDelta = (target: number, from: number): number => {
    const raw = clampNum(target);
    const delta = raw - from;
    const capped = Math.max(-MAX_STATE_DELTA, Math.min(MAX_STATE_DELTA, delta));
    return clampNum(from + capped);
  };

  const emotion = settleEmotion(prev, proposed.emotion as AiEmotion, userText);

  return {
    emotion,
    friendship: clampDelta(proposed.friendship ?? base.friendship, base.friendship),
    trust: clampDelta(proposed.trust ?? base.trust, base.trust),
    respect: clampDelta(proposed.respect ?? base.respect, base.respect),
  };
}

/** Gentle local mood update when the model didn't provide a state block. */
function applyLocalMood(userText: string): void {
  const prev = currentState;
  if (!prev) return;
  const score = sentimentScore(userText);
  if (score === 0) return;

  const next: AiState = {
    ...prev,
    friendship: clampNum(prev.friendship + score * 2),
    trust: clampNum(prev.trust + (score > 0 ? 1 : -1)),
    respect: clampNum(prev.respect + (score > 0 ? 1 : -1)),
  };
  if (prev.emotion === "neutral") {
    next.emotion = score > 0 ? "happy" : "annoyed";
  }
  currentState = next;
  saveState();
}

function applyAiState(proposed: Partial<AiState> | null, userText: string): void {
  const prev = currentState;
  const next = dampStateChange(prev, proposed, userText);

  if (!next) {
    applyLocalMood(userText);
    return;
  }

  const moodHistory = prev?.moodHistory || [];
  if (moodHistory.length === 0 || moodHistory[moodHistory.length - 1] !== next.emotion) {
    moodHistory.push(next.emotion);
    if (moodHistory.length > 5) moodHistory.shift();
  }

  currentState = { ...next, moodHistory };
  saveState();
}

// ── Public API ──────────────────────────────────────────

export interface DirectedReply {
  /** Cleaned natural-language reply (ready for chat + TTS). */
  response: string;
  /** Registry-validated animation intent (null = no animation). */
  animation: RawAiIntent | null;
}

export async function generateDirectedReply(
  userText: string,
  username = "User",
  relationshipMode: RelationshipMode = "natural",
): Promise<DirectedReply> {
  if (!userText || typeof userText !== "string") {
    return {
      response: "Hmm, I didn't quite catch that. Could you say it again?",
      animation: null,
    };
  }

  addHistory("user", userText);

  // Session cap: after enough messages, she takes a break instead of hitting
  // the API — keeps the free tier from being exhausted mid-conversation.
  if (isSessionLimited()) {
    const idx = Math.floor(Math.random() * CONVERSATION_LIMITS.sessionLimitResponses.length);
    const tired = CONVERSATION_LIMITS.sessionLimitResponses[idx];
    addHistory("assistant", tired);
    return { response: tired, animation: null };
  }

  const messages = buildMessages(userText, username, relationshipMode);

  // Route through the resilient model router
  const { text, modelUsed, failed } = await router.route(messages);

  if (failed || !text) {
    // No model produced a reply — surface a typed error instead of an
    // in-character filler that pretends she answered. The user message was
    // already recorded for history; the assistant reply is NOT added.
    throw new ChatUnavailableError(AI_UNAVAILABLE_MESSAGE);
  }

  // Parse response (handles JSON, partial JSON, plain text + trailing JSON)
  const result = parseResponse(text);
  result.segments = processResponse(result.segments, CHARACTER_NAME);

  if (result.segments.length === 0) {
    // Model returned no usable speech (e.g. a bare state-only JSON block).
    // Treat as failure — never insert a placeholder as her answer.
    throw new ChatUnavailableError(AI_UNAVAILABLE_MESSAGE);
  }

  applyAiState(result.state, userText);

  const fullResponse = result.segments.join(" ");
  addHistory("assistant", fullResponse);

  // Validate the AI's animation decision against the safe registry.
  // Anything unknown becomes "no animation" — the chat must never break.
  let animation: RawAiIntent | null = null;
  if (result.animation && typeof result.animation.action === "string") {
    const valid = validateAiIntent(result.animation);
    if (valid) {
      animation = {
        action: valid.id,
        confidence: valid.intensity,
        ...(valid.tags ? { tags: valid.tags } : {}),
      };
    }
  }

  // "Thinking" layer — read the full turn (user request + our own answer) and
  // derive the animation even when the model narrated it in prose instead of
  // emitting the structured block ("Okay, I'm dancing!" but no action JSON).
  // An explicit user request FORCES the intent — a request must never be
  // dropped because the model chose "none".
  const inferred = inferIntent(userText, fullResponse);
  if (inferred?.forced) {
    const valid = validateAiIntent({ action: inferred.action, tags: inferred.tags });
    if (valid) {
      animation = {
        action: valid.id,
        confidence: inferred.confidence,
        ...(valid.tags ? { tags: valid.tags } : {}),
      };
    }
  } else if (!animation && inferred) {
    const valid = validateAiIntent({ action: inferred.action, tags: inferred.tags });
    if (valid) {
      animation = {
        action: valid.id,
        confidence: inferred.confidence,
        ...(valid.tags ? { tags: valid.tags } : {}),
      };
    }
  }

  const src = modelUsed ? modelUsed.split("/").pop() : "fallback";
  console.log(
    `[AI] ${src}: "${fullResponse.slice(0, 100)}${fullResponse.length > 100 ? "..." : ""}"` +
      (animation
        ? ` | anim: ${animation.action}${inferred ? ` (inferred:${inferred.source})` : ""}`
        : ""),
  );

  return { response: fullResponse, animation };
}

export async function generateReply(
  userText: string,
  username = "User",
  relationshipMode: RelationshipMode = "natural",
): Promise<string> {
  const result = await generateDirectedReply(userText, username, relationshipMode);
  return result.response;
}

export function getAiState(): AiState | null {
  return currentState;
}

export function setScreenContext(context: string | null): void {
  screenContext = context;
}

export function getScreenContext(): string | null {
  return screenContext;
}

export function addScreenHistory(entry: Omit<ScreenHistoryEntry, "timestamp">): void {
  const last = screenHistory[screenHistory.length - 1];
  if (last && last.summary === entry.summary && last.screenType === entry.screenType) return;
  screenHistory.push({ ...entry, timestamp: Date.now() });
  if (screenHistory.length > MAX_SCREEN_HISTORY) screenHistory.shift();
}

export function getScreenHistorySummary(): string {
  if (screenHistory.length === 0) return "";
  const recent = screenHistory.slice(-3);
  const lines = recent.map((e) => {
    const time = new Date(e.timestamp).toLocaleTimeString();
    return `[${time}] ${e.summary}`;
  });
  return `Recent screen activity:\n${lines.join("\n")}`;
}

export function clearAiMemory() {
  currentState = null;
  history = [];
  router.reset();
  if (typeof window !== "undefined") {
    localStorage.removeItem(AI_STATE_KEY);
    localStorage.removeItem(AI_HISTORY_KEY);
  }
}

export function getRouterState() {
  return router.getSummary();
}

export { router as modelRouter };

export default {
  generateReply,
  generateDirectedReply,
  getAiState,
  clearAiMemory,
};
