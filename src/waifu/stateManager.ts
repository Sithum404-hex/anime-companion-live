import type { WaifuState, Emotion } from "./types";

type Listener = (s: WaifuState, e: Emotion) => void;

export class StateManager {
  state: WaifuState = "IDLE";
  emotion: Emotion = "calm";
  private listeners: Listener[] = [];
  private lockedUntil = 0;

  on(fn: Listener) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  setState(s: WaifuState, holdMs = 0) {
    if (performance.now() < this.lockedUntil && s !== this.state) return;
    if (s === this.state) return;
    this.state = s;
    this.lockedUntil = performance.now() + holdMs;
    this.emit();
  }

  setEmotion(e: Emotion) {
    if (e === this.emotion) return;
    this.emotion = e;
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l(this.state, this.emotion);
  }
}
