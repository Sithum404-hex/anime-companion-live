import type { WaifuState, Emotion, AiEmotion } from "../types";
import type { BaseEmotion } from "./ExpressionController";

// ── Typed event contract ──────────────────────────────────
// Every event that crosses controller boundaries is declared here.
// Controllers may only emit / listen to their declared events.

export interface AppEvents {
  // ── Input → rest ──
  "input:interaction": void;
  "render:tick": { dt: number };

  // ── State coordinator → animation, AI ──
  "state:change": { state: WaifuState; emotion: Emotion };

  // ── AI → expression, behavior ──
  "ai:response": { text: string; emotion: AiEmotion; intensity: number };
  "ai:speaking": boolean;

  // ── Animation → state coordinator ──
  "anim:timeout": { from: string };
  "anim:complete": { from: string };
  "anim:inactivity": { from: string };

  // ── Expression → debug / UI ──
  "expression:base": { emotion: BaseEmotion };
  "expression:overlay": { emotion: string; intensity: number; duration: number };
  "expression:decayed": { emotion: string };

  // ── Behavior → animation, expression ──
  "behavior:userMessage": { tiltX: number; tiltY: number };
  "behavior:greeting": Record<string, never>;
  "behavior:silence": Record<string, never>;
  "behavior:aiResponse": { emotion: string; intensity: number };
  "behavior:microAction": { type: string };
}

type Listener<T> = (data: T) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener<unknown>>>();

  on<K extends keyof AppEvents>(event: K, fn: Listener<AppEvents[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(fn as Listener<unknown>);
    return () => this.listeners.get(event)?.delete(fn as Listener<unknown>);
  }

  emit<K extends keyof AppEvents>(event: K, data: AppEvents[K]): void {
    this.listeners.get(event)?.forEach((fn) => fn(data));
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
