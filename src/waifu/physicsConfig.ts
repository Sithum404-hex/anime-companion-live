import * as THREE from "three";

/** Bust scale multiplier applied to chest/upperChest bones. */
export const BUST_SCALE = 1.2;

/**
 * Unified spring bone physics configuration — the single source of truth
 * for every tunable in the secondary-motion stack:
 *   - global.*    fixed-step rate, gravity, beat-kick and poke amplitudes
 *   - bone.*      PhysicsBone/PhysicsBoneChain defaults and solver scales
 *   - hair/tail/cloth/accessories/ears/bust — per-system tuning for BOTH
 *     the native VRM spring bones (stiffness/dragForce/gravityPower/...)
 *     and the custom Verlet chains (iterations, colliders, wave/flutter,
 *     bone tuning tables, poke radii/strengths).
 *
 * Changing a value here must affect the corresponding subsystem — the
 * subsystem files read from this object, they do not keep local copies.
 */
export const PHYSICS_CONFIG = {
  global: {
    /** Fixed Verlet integration rate (Hz). */
    physicsHz: 120,
    /** Max substeps per frame (spiral-of-death guard). */
    maxSteps: 8,
    /** Accumulator cap in seconds. */
    accumulatorCap: 0.05,
    /** Per-subsystem dt clamp (~33 ms). */
    dtClamp: 0.033,
    /** World gravity magnitude (m/s²), applied downward. */
    gravity: 9.81,
    /**
     * Hip-motion inertia — the PRIMARY dance driver. The hips' world motion
     * (translation + yaw, see HipMotionTracker) pushes hair/tail/cloth/
     * accessories the opposite way, so the strands lag the choreography
     * instead of reacting to a random impulse. Force units are m/s², the same
     * band as gravity (~4.9 effective), so these numbers are directly
     * comparable to the beat kick below.
     */
    hipInertia: {
      /** EMA time constant for velocity/acceleration (seconds). */
      smoothSec: 0.045,
      /** Sample dt clamp — a stalled tab must not read as one huge velocity. */
      maxSampleDt: 0.05,
      /** Accepted hip speed (m/s) and acceleration (m/s²) bands. */
      maxSpeed: 6,
      maxAccel: 45,
      /** Accepted hip yaw rate (rad/s) and yaw acceleration (rad/s²) bands. */
      maxYawRate: 12,
      maxYawAccel: 60,
      /** Opposed linear inertia: -(accel * accelGain + vel * velGain). */
      accelGain: 0.42,
      velGain: 0.05,
      /**
       * Tangential lag — strands fighting a spin/twist (-α × r). Kept a
       * fraction of gravity so a fast twist reads as follow-through, not a yank.
       */
      yawAccelGain: 0.25,
      /**
       * Centrifugal fling — strands moving outward during a spin (ω² × r).
       * At a 3 rad/s spin this is ~1 m/s² of outward pull: visible next to
       * gravity without lifting the hair off her shoulders.
       */
      centrifugalGain: 0.12,
      /** Hard per-bone force clamp (m/s²). */
      maxForce: 22,
      /** Response per chain family: hair flies, cloth is heavier, tail damped. */
      familyGain: { hair: 1, cloth: 0.6, tail: 0.45, accessories: 0.55 },
      /** Per-state response — dance is the loud case, idle keeps only a trace. */
      state: {
        dance: 1,
        happy: 0.6,
        surprised: 0.6,
        gesture: 0.55,
        talking: 0.4,
        listening: 0.3,
        thinking: 0.25,
        fallback: 0.2,
      },
    },
    beat: {
      /** Minimum ms between beat impulses. */
      debounceMs: 180,
      /**
       * The kick is a clean upward bounce now; `randomShare` is the only
       * randomised part left and it is deliberately small — the hip motion
       * above is what makes her strands respond to the choreography.
       */
      randomShare: 0.22,
      baseAmp: 0.9,
      intensityAmp: 2.6,
      energyBase: 0.35,
      energyBassShare: 0.65,
      upwardBase: 0.6,
      upwardIntensity: 0.8,
    },
    poke: {
      burstX: 4,
      burstYBase: 2.5,
      burstYSpan: 3.5,
      burstZ: 2.5,
    },
  },
  bone: {
    stiffness: 0.3,
    damping: 0.15,
    gravityInfluence: 1.0,
    airResistance: 0.02,
    chainIterations: 3,
    collisionPush: 0.8,
    /** Gravity applied as gravityInfluence * gravityScale. */
    gravityScale: 0.5,
    /** Spring acceleration scale (restTarget pull * stiffness * springScale). */
    springScale: 8,
  },
  hair: {
    // Native VRM spring bones
    stiffness: 0.6,
    dragForce: 0.4,
    gravityPower: 0.2,
    gravityDir: new THREE.Vector3(0, -1, 0),
    hitRadius: 0.02,
    // Custom Verlet hair
    iterations: 3,
    inertiaFactor: 0.15,
    velocityClamp: 5,
    headCollisionRadius: 0.12,
    headCollisionPush: 0.6,
    headCenterOffsetY: 0.03,
    swayAmpBase: 0.003,
    swayAmpMotion: 0.012,
    flutterAmpBase: 0.002,
    flutterAmpMotion: 0.008,
    tipForceBase: 0.3,
    tipForceSpan: 0.7,
    impulseTipBase: 0.3,
    impulseTipSpan: 0.7,
    pokeRadius: 0.45,
    pokeStrength: 6,
    sideForce: 0.002,
    stateIntensity: {
      dance: 1.0,
      happy: 0.65,
      surprised: 0.65,
      gesture: 0.65,
      talking: 0.35,
      listening: 0.25,
      thinking: 0.15,
      fallback: 0.1,
    },
    boneTuning: {
      root: { stiffness: 0.45, damping: 0.2, gravityInfluence: 0.4, airResistance: 0.01 },
      tip: { stiffness: 0.15, damping: 0.12, gravityInfluence: 1.0, airResistance: 0.03 },
      mid: {
        stiffnessBase: 0.35,
        stiffnessSpan: 0.25,
        dampingBase: 0.18,
        dampingSpan: 0.08,
        gravityBase: 0.5,
        gravitySpan: 0.5,
        airBase: 0.015,
        airSpan: 0.02,
      },
    },
  },
  tail: {
    stiffness: 0.8,
    dragForce: 0.5,
    gravityPower: 0.25,
    gravityDir: new THREE.Vector3(0, -1, 0),
    hitRadius: 0.03,
    iterations: 3,
    inertiaFactor: 0.25,
    angularSwayScale: 0.3,
    angularVelLerp: 5,
    velocityClamp: 3,
    wagHappySpeedBase: 6,
    wagHappySpeedMotion: 4,
    wagIdleSpeedBase: 2,
    wagIdleSpeedMotion: 1.5,
    wagHappyAmpBase: 0.08,
    wagHappyAmpMotion: 0.12,
    wagIdleAmpBase: 0.02,
    wagIdleAmpMotion: 0.04,
    wagZScale: 0.5,
    wagStiffnessDecay: 0.3,
    wagMinStiffness: 0.08,
    idleSwayAmp: 0.003,
    idleSwaySineAmp: 0.002,
    idleSwayZAmp: 0.003,
    followThroughScale: 0.02,
    flutterYAmp: 0.001,
    tipForceBase: 0.1,
    tipForceSpan: 0.9,
    impulseTipBase: 0.4,
    impulseTipSpan: 0.9,
    pokeRadius: 0.45,
    pokeStrength: 5,
    stateIntensity: {
      dance: 1.0,
      happy: 0.9,
      surprised: 0.9,
      gesture: 0.5,
      talking: 0.3,
      listening: 0.15,
      fallback: 0.08,
    },
    boneTuning: {
      stiffnessBase: 0.5,
      stiffnessSpan: 0.35,
      dampingBase: 0.2,
      dampingSpan: 0.08,
      gravityBase: 0.3,
      gravitySpan: 0.6,
      airBase: 0.01,
      airSpan: 0.04,
    },
  },
  ears: {
    stiffness: 0.5,
    dragForce: 0.4,
    gravityPower: 0.15,
    gravityDir: new THREE.Vector3(0, -1, 0),
    hitRadius: 0.015,
  },
  bust: {
    stiffness: 0.4,
    dragForce: 0.6,
    gravityPower: 0.2,
    gravityDir: new THREE.Vector3(0, -1, 0),
    hitRadius: 0.04,
  },
  cloth: {
    iterations: 2,
    inertiaFactor: 0.2,
    velocityClamp: 4,
    hipCollisionRadius: 0.15,
    legCollisionRadius: 0.06,
    hipCollisionPush: 0.7,
    legCollisionPush: 0.5,
    legOffsetX: 0.06,
    legOffsetY: 0.2,
    chestVelLerp: 0.3,
    hipSwayAmpBase: 0.004,
    hipSwayAmpMotion: 0.015,
    windXAmpBase: 0.002,
    windXAmpMotion: 0.008,
    windZAmpBase: 0.001,
    windZAmpMotion: 0.006,
    flutterYAmpBase: 0.001,
    flutterYAmpMotion: 0.004,
    flutterYScale: 0.5,
    tipForceBase: 0.2,
    tipForceSpan: 0.8,
    impulseTipBase: 0.3,
    impulseTipSpan: 0.7,
    pokeRadius: 0.55,
    pokeStrength: 4.5,
    sideForce: 0.001,
    stateIntensity: {
      dance: 1.0,
      happy: 0.6,
      surprised: 0.6,
      gesture: 0.6,
      talking: 0.3,
      fallback: 0.12,
    },
    skirt: {
      root: { stiffness: 0.5, damping: 0.25, gravityInfluence: 0.8, airResistance: 0.02 },
      tip: { stiffness: 0.2, damping: 0.18, gravityInfluence: 1.2, airResistance: 0.04 },
      mid: {
        stiffnessBase: 0.4,
        stiffnessSpan: 0.25,
        dampingBase: 0.22,
        dampingSpan: 0.06,
        gravityBase: 0.9,
        gravitySpan: 0.3,
        airBase: 0.025,
        airSpan: 0.02,
      },
    },
    sleeve: {
      root: { stiffness: 0.6, damping: 0.22, gravityInfluence: 0.5, airResistance: 0.015 },
      mid: {
        stiffnessBase: 0.5,
        stiffnessSpan: 0.3,
        dampingBase: 0.2,
        dampingSpan: 0.08,
        gravityBase: 0.6,
        gravitySpan: 0.4,
        airBase: 0.02,
        airSpan: 0.025,
      },
    },
    /**
     * Spin-aware skirt flare (PROMPT 14).
     *
     * The hip inertia above already flings every chain outward with ω²r, but at
     * skirt radii (~0.1–0.2 m) that term lands around 0.1 m/s² — invisible next
     * to gravity (≈4.9 effective). This block adds a **skirt-only** outward
     * push whose own envelope builds while the hips actually spin and decays
     * back to zero the moment the spin stops, so the hems flare during a twirl
     * and settle afterwards — never staying inflated.
     *
     * Force units are m/s², the same band as gravity, so these numbers are
     * directly comparable to the beat kick and the hip inertia.
     */
    spinFlare: {
      /** Hip yaw rate (rad/s) below which this is off — a slow turn is not a spin. */
      minYawRate: 1.2,
      /**
       * Hip yaw rate (rad/s) at which the flare reaches full strength. The
       * shipped dance clips rotate the hips at ~2.5–4.2 rad/s (p75–p95 of
       * |yaw|), so full strength sits inside that band: the fast/spinning/
       * high-energy clips flare fully, a gentle sway does not.
       */
      fullYawRate: 3.5,
      /** Outward force (m/s²) at full strength, before tip/radius weighting. */
      strength: 6,
      /** Hard per-bone force clamp (m/s²) — bounds the flare however fast she spins. */
      maxStrength: 10,
      /**
       * Envelope time constants (seconds): the flare keeps up with the spin
       * quickly and lets go slowly, which is what reads as fabric settling
       * instead of a snap back to the legs.
       */
      attackSec: 0.1,
      decaySec: 0.4,
      /** Radius (m) that counts as a normal hem; force scales with r / this. */
      radiusRef: 0.12,
      /** Clamp band for that radius ratio — a far panel pulls harder, but bounded. */
      radiusRatioMin: 0.35,
      radiusRatioMax: 1.4,
      /** Tip weighting along a panel (roots barely move, hems flare most). */
      tipBase: 0.35,
      tipSpan: 0.65,
      /**
       * Per-tier scale — LOW keeps the flare off entirely (physics budget rule),
       * MEDIUM shades it down, HIGH is full strength.
       */
      tierScale: { low: 0, medium: 0.55, high: 1 },
    },
  },
  accessories: {
    iterations: 2,
    inertiaFactor: 0.15,
    velocityClamp: 3,
    headVelLerp: 0.6,
    chestVelLerp: 0.4,
    earTwitchFreqBase: 4,
    earTwitchFreqMotion: 2,
    earTwitchAmpBase: 0.003,
    earTwitchAmpMotion: 0.01,
    earTwitchZScale: 0.4,
    earIsEarStiffness: 0.6,
    earIsEarGravity: 0.4,
    earTipBase: 0.3,
    earTipSpan: 0.7,
    accSwayAmpBase: 0.002,
    accSwayAmpMotion: 0.01,
    accTipBase: 0.2,
    accTipSpan: 0.8,
    impulseTipBase: 0.4,
    impulseTipSpan: 0.8,
    pokeRadius: 0.35,
    pokeStrength: 5,
    sideForce: 0.001,
    stateIntensity: {
      dance: 1.0,
      happy: 0.7,
      surprised: 0.7,
      gesture: 0.7,
      talking: 0.3,
      fallback: 0.1,
    },
    ear: {
      root: { stiffness: 0.7, damping: 0.18, gravityInfluence: 0.3, airResistance: 0.01 },
      tip: { stiffness: 0.3, damping: 0.12, gravityInfluence: 0.5, airResistance: 0.02 },
      mid: { stiffness: 0.5, damping: 0.15, gravityInfluence: 0.4, airResistance: 0.015 },
    },
    accessory: {
      root: { stiffness: 0.55, damping: 0.25, gravityInfluence: 0.6, airResistance: 0.03 },
      mid: { stiffness: 0.3, damping: 0.2, gravityInfluence: 0.8, airResistance: 0.04 },
    },
  },
  idle: {
    blinkDuration: 0.1,
    blinkOpenDuration: 0.08,
    headDriftLerp: 1.5,
    headMicroRate: 0.5,
  },
  /** Body collider geometry (world-space capsules/spheres built per frame from humanoid bones). */
  colliders: {
    headRadius: 0.12,
    headOffsetY: 0.03,
    spineRadius: 0.09,
    armRadius: 0.05,
    hipRadius: 0.08,
  },
  /**
   * Zone-aware touch reactions. Every expressive reaction is debounced by
   * `cooldownMs`, so mashing one spot cannot machine-gun overlays or gestures.
   * Distances are in metres against humanoid bone anchors — deliberately
   * name-agnostic, because bone/mesh naming varies between VRM exporters.
   */
  touch: {
    /** Max distance from a humanoid bone for a hit to count as body contact. */
    probeRadius: 0.24,
    /** Per-group radius scale; the torso is tighter than the head. */
    radiusScale: { head: 1, hands: 1, body: 0.7 },
    /** Surface normal must point this much at the camera for a hit to be the face. */
    faceNormalDot: 0.35,
    /** Max additive head lean toward a touch (radians). */
    leanRad: 0.14,
    /** Max additive lean-back for a face recoil (radians). */
    recoilRad: 0.07,
    /** Rise / hold / release times for the lean and recoil envelopes (seconds). */
    leanInSec: 0.12,
    leanHoldSec: 0.35,
    leanOutSec: 0.55,
    /** Closed-eye hold after a head pat (seconds). */
    eyesClosedSec: 0.55,
    /** Impulse strength multiplier when hair/skirt/tail is touched directly. */
    hairStrengthScale: 1.6,
    /** Debounce window per zone (ms). Hands are longest — a wave is the biggest ask. */
    cooldownMs: { head: 1600, face: 2600, hands: 4000, hair: 350, body: 2200 },
    /** Minimum gap between any two expressive reactions, whatever the zone (ms). */
    globalCooldownMs: 450,
  },
  /**
   * Pointer-drag of secondary chains (normal modes only). While the pointer
   * is held down over hair / skirt / tail / accessory chains, nearby Verlet
   * points feel a clamped spring force toward the pointer's projected world
   * target. The force is applied per fixed substep (frame-rate independent);
   * on release nothing is applied and the chains' own spring restoration
   * provides the natural spring-back. The per-bone clamp plus the target
   * displacement clamp guarantee a tug, never a teleport.
   */
  drag: {
    /** Falloff radius around the grab point (metres) — only nearby strands feel the pull. */
    radius: 0.3,
    /** Spring constant toward the pointer target (force units, applied per substep). */
    strength: 16,
    /** Hard per-bone force clamp — bounds the pull no matter how far the pointer jumps. */
    maxForce: 24,
    /** Max distance the projected pointer target may wander from the grab point (metres). */
    maxDisplacement: 0.4,
  },
  /** Clamp ranges applied when tuning NATIVE VRM spring-bone joints. */
  nativeClamps: {
    hair: { stiffness: [0.18, 1.15], dragForce: [0.16, 0.38], gravityMin: 0.014 },
    tail: { stiffness: [0.24, 0.78], dragForce: [0.18, 0.42], gravityMin: 0.035 },
    ears: { stiffness: [0.8, 1.5], dragForce: [0.08, 0.22], gravityMin: 0.006, dragOffset: 0.08 },
    bust: { stiffness: [0.24, 0.78], dragForce: [0.24, 0.72], gravityMin: 0.012 },
  },
} as const;

export type PhysicsPart = keyof typeof PHYSICS_CONFIG;

/** Collision set tier for Verlet subsystems. "headSpine" = head + hips/spine. */
export type ColliderSet = "head" | "headSpine" | "full";

/** Per-substep tuning budget, normally driven by the active QualityTier. */
export interface PhysicsBudget {
  /** Fixed Verlet step rate in Hz (60 low / 90 medium / 120 high). */
  hz: number;
  /** Constraint iterations per substep (1 low / 2 medium / 3 high). */
  iterations: number;
  /** Flutter/wave overlay forces enabled (disabled on low). */
  flutter: boolean;
  /** Which collider set is active. */
  colliders: ColliderSet;
}

/** Look up a state-intensity table entry, falling back to its `fallback` key. */
export function stateMotion(table: Record<string, number>, animState: string): number {
  const v = (table as Record<string, number>)[animState];
  return typeof v === "number" ? v : table.fallback;
}
