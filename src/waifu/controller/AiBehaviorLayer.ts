import * as THREE from "three";
import type { ExpressionController } from "./ExpressionController";
import type { AnimationStateMachine, AnimState } from "./AnimationStateMachine";
import type { IdleManager } from "./IdleManager";
import type { EventBus } from "./EventBus";

// ── Emotion → animation mapping (matches AiEmotion names from AI system) ──

const EMOTION_ANIM_MAP: Record<string, AnimState> = {
  happy: "happy",
  sad: "sad",
  angry: "gesture",
  annoyed: "gesture",
  excited: "gesture",
  nervous: "thinking",
  embarrassed: "happy",
  surprised: "surprised",
};

// ── Micro-action definitions ──────────────────────────────

interface MicroActionDef {
  type: string;
  execute: () => void;
  duration: number;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ── AI Behavior Layer ────────────────────────────────────

export class AiBehaviorLayer {
  // Look override — controller reads this each frame
  lookOverride: { x: number; y: number } | null = null;

  // Micro-action scheduling
  private actionTimer = 0;
  private nextActionTime = rand(10, 20);
  private currentAction: { def: MicroActionDef; remaining: number } | null = null;

  // Look-hold state (for user-message head tilt, etc.)
  private lookHold: { x: number; y: number; remaining: number } | null = null;

  // Cooldown to avoid flooding
  private greetingCooldown = 0;
  private thinkingCooldown = 0;

  constructor(
    private expression: ExpressionController,
    private stateMachine: AnimationStateMachine,
    private idle: IdleManager,
    private events: EventBus,
  ) {}

  // ── Public event methods (called by controller or external code) ──

  /** User sends a message → subtle head tilt + attentive look */
  onUserMessage(): void {
    const tiltX = rand(-0.2, 0.2);
    const tiltY = rand(-0.1, 0.05);
    this.lookHold = { x: tiltX, y: tiltY, remaining: 1.8 };
    this.events.emit("behavior:userMessage", { tiltX, tiltY });
  }

  /** Greeting (e.g., user says "hello") → smile + happy animation */
  onGreeting(): void {
    if (this.greetingCooldown > 0) return;
    this.greetingCooldown = 5;

    this.expression.queueEmotion({ emotion: "happy", intensity: 0.6, duration: 3 });
    // Brief look shift toward user
    this.lookHold = { x: 0.12, y: -0.08, remaining: 2.5 };
    this.events.emit("behavior:greeting", {});
  }

  /** Silence / thinking pause → thinking animation + curious expression */
  onSilence(): void {
    if (this.thinkingCooldown > 0) return;
    this.thinkingCooldown = 8;

    this.expression.queueEmotion({ emotion: "nervous", intensity: 0.35, duration: 3.5 });
    this.lookHold = { x: 0, y: 0.12, remaining: 3 };
    this.events.emit("behavior:silence", {});
  }

  /** AI response received with emotion → overlay + animation + look shift */
  onAIResponse(emotion: string, intensity: number): void {
    // Queue the expression overlay
    const overlayEmotions = [
      "happy",
      "sad",
      "angry",
      "annoyed",
      "embarrassed",
      "excited",
      "nervous",
      "surprised",
      "blush",
    ];
    if (overlayEmotions.includes(emotion)) {
      this.expression.queueEmotion({ emotion, intensity, duration: 2.5 });
    }

    // Brief look shift
    this.lookHold = { x: rand(-0.15, -0.05), y: rand(0, 0.08), remaining: 1.2 };
    this.events.emit("behavior:aiResponse", { emotion, intensity });
  }

  // ── Internal ────────────────────────────────────────────

  private executeMicroAction(): void {
    const lookActions: MicroActionDef[] = [
      {
        type: "lookLeft",
        duration: 2.5,
        execute: () => {
          this.lookHold = { x: -0.5, y: 0, remaining: 2.5 };
        },
      },
      {
        type: "lookRight",
        duration: 2.5,
        execute: () => {
          this.lookHold = { x: 0.5, y: 0, remaining: 2.5 };
        },
      },
      {
        type: "lookUp",
        duration: 1.8,
        execute: () => {
          this.lookHold = { x: 0, y: -0.3, remaining: 1.8 };
        },
      },
      {
        type: "lookDown",
        duration: 1.8,
        execute: () => {
          this.lookHold = { x: 0, y: 0.3, remaining: 1.8 };
        },
      },
    ];
    const expressionActions: MicroActionDef[] = [
      {
        type: "microSmile",
        duration: 1.5,
        execute: () => {
          this.expression.queueEmotion({ emotion: "happy", intensity: 0.15, duration: 1.5 });
        },
      },
      {
        type: "microBrowFurrow",
        duration: 2,
        execute: () => {
          this.expression.queueEmotion({ emotion: "nervous", intensity: 0.1, duration: 2 });
        },
      },
    ];
    const headActions: MicroActionDef[] = [
      {
        type: "headTiltLeft",
        duration: 3,
        execute: () => {
          this.lookHold = { x: -0.25, y: -0.12, remaining: 3 };
        },
      },
      {
        type: "headTiltRight",
        duration: 3,
        execute: () => {
          this.lookHold = { x: 0.25, y: -0.12, remaining: 3 };
        },
      },
    ];
    const otherActions: MicroActionDef[] = [
      {
        type: "blush",
        duration: 2,
        execute: () => {
          this.expression.queueEmotion({ emotion: "blush", intensity: 0.2, duration: 2 });
        },
      },
    ];

    // ── 18+ micro-actions ──────────────────────────────
    const flirtyActions: MicroActionDef[] = [
      {
        type: "wink",
        duration: 1.5,
        execute: () => {
          this.expression.forceWink("right");
          this.expression.queueEmotion({ emotion: "happy", intensity: 0.15, duration: 1.5 });
        },
      },
      {
        type: "blowKiss",
        duration: 2.5,
        execute: () => {
          this.expression.queueEmotion({ emotion: "kiss", intensity: 0.5, duration: 2 });
          this.stateMachine.requestState("happy");
        },
      },
      {
        type: "lipBite",
        duration: 2,
        execute: () => {
          this.expression.queueEmotion({ emotion: "kiss", intensity: 0.3, duration: 1.5 });
          this.lookHold = { x: 0, y: 0.15, remaining: 2 };
        },
      },
      {
        type: "hipSway",
        duration: 2,
        execute: () => {
          this.stateMachine.requestState("happy");
        },
      },
      {
        type: "fingerBeckon",
        duration: 2.5,
        execute: () => {
          this.stateMachine.requestState("gesture");
          this.expression.queueEmotion({ emotion: "kiss", intensity: 0.3, duration: 2 });
        },
      },
    ];
    const affectionateActions: MicroActionDef[] = [
      {
        type: "hugReach",
        duration: 2.5,
        execute: () => {
          this.expression.queueEmotion({ emotion: "heart", intensity: 0.5, duration: 2.5 });
          this.stateMachine.requestState("happy");
        },
      },
      {
        type: "leanIn",
        duration: 2,
        execute: () => {
          this.expression.queueEmotion({ emotion: "happy", intensity: 0.25, duration: 2 });
          this.lookHold = { x: 0, y: -0.18, remaining: 2 };
        },
      },
      {
        type: "blushHeavy",
        duration: 3,
        execute: () => {
          this.expression.queueEmotion({ emotion: "blush", intensity: 0.6, duration: 3 });
          this.expression.queueEmotion({ emotion: "happy", intensity: 0.2, duration: 3 });
        },
      },
      {
        type: "heartEyes",
        duration: 2.5,
        execute: () => {
          this.expression.queueEmotion({ emotion: "heart", intensity: 0.6, duration: 2.5 });
        },
      },
      {
        type: "nuzzle",
        duration: 2.5,
        execute: () => {
          this.lookHold = { x: rand(0.1, 0.2), y: -0.18, remaining: 2.5 };
          this.expression.queueEmotion({ emotion: "happy", intensity: 0.3, duration: 2 });
          this.expression.queueEmotion({ emotion: "blush", intensity: 0.3, duration: 2 });
        },
      },
    ];
    const seductiveActions: MicroActionDef[] = [
      {
        type: "slowStretch",
        duration: 3,
        execute: () => {
          this.stateMachine.requestState("thinking");
          this.lookHold = { x: 0, y: -0.1, remaining: 2.5 };
        },
      },
      {
        type: "hairFlip",
        duration: 2,
        execute: () => {
          this.lookHold = { x: rand(-0.25, -0.15), y: -0.25, remaining: 2 };
          this.expression.queueEmotion({ emotion: "happy", intensity: 0.15, duration: 2 });
        },
      },
      {
        type: "bedroomEyes",
        duration: 3,
        execute: () => {
          this.expression.queueEmotion({ emotion: "bedroom", intensity: 0.5, duration: 3 });
          this.lookHold = { x: rand(-0.1, 0.1), y: rand(0.05, 0.12), remaining: 3 };
        },
      },
      {
        type: "shoulderExpose",
        duration: 2.5,
        execute: () => {
          this.lookHold = { x: 0.3, y: 0, remaining: 2.5 };
          this.expression.queueEmotion({ emotion: "bedroom", intensity: 0.35, duration: 2.5 });
        },
      },
    ];
    const shyActions: MicroActionDef[] = [
      {
        type: "coverFace",
        duration: 2,
        execute: () => {
          this.lookHold = { x: 0, y: 0.2, remaining: 2 };
          this.expression.queueEmotion({ emotion: "shy", intensity: 0.5, duration: 2 });
        },
      },
      {
        type: "lookAway",
        duration: 2.5,
        execute: () => {
          this.lookHold = { x: rand(-0.6, -0.4), y: 0.05, remaining: 2.5 };
          this.expression.queueEmotion({ emotion: "shy", intensity: 0.35, duration: 2.5 });
        },
      },
      {
        type: "footShuffle",
        duration: 2,
        execute: () => {
          this.stateMachine.requestState("thinking");
          this.expression.queueEmotion({ emotion: "shy", intensity: 0.25, duration: 2 });
        },
      },
      {
        type: "peekFingers",
        duration: 2.5,
        execute: () => {
          this.lookHold = { x: 0, y: 0.12, remaining: 2.5 };
          this.expression.queueEmotion({ emotion: "shy", intensity: 0.4, duration: 2.5 });
        },
      },
    ];

    const pool: MicroActionDef[] = [
      ...lookActions,
      ...expressionActions,
      ...headActions,
      ...otherActions,
      ...flirtyActions,
      ...affectionateActions,
      ...seductiveActions,
      ...shyActions,
    ];

    const action = pick(pool);
    this.currentAction = { def: action, remaining: action.duration };
    action.execute();
    this.events.emit("behavior:microAction", { type: action.type });
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.033);

    // ── Cooldowns ──────────────────────────────────────
    if (this.greetingCooldown > 0) this.greetingCooldown -= dt;
    if (this.thinkingCooldown > 0) this.thinkingCooldown -= dt;

    // ── Micro-action timer ─────────────────────────────
    // Body micro-actions are selected by CharacterBehaviorEngine. This legacy
    // layer now only supplies safe expression and gaze overlays, so it cannot
    // compete for the AnimationStateMachine.

    // ── Current action expiry ──────────────────────────
    if (this.currentAction) {
      this.currentAction.remaining -= dt;
      if (this.currentAction.remaining <= 0) {
        this.currentAction = null;
      }
    }

    // ── Look hold expiry ───────────────────────────────
    if (this.lookHold) {
      this.lookHold.remaining -= dt;
      if (this.lookHold.remaining <= 0) {
        this.lookHold = null;
      }
    }

    // ── Expose look override for controller ────────────
    this.lookOverride = this.lookHold ? { x: this.lookHold.x, y: this.lookHold.y } : null;
  }

  dispose(): void {
    this.currentAction = null;
    this.lookHold = null;
    this.lookOverride = null;
  }
}
