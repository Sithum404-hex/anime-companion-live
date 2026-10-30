import * as THREE from "three";
import type { QualityTier } from "../performance";
import type { BeatPulse } from "../DanceDirector";
import type { QualitySettings } from "../performance";

/**
 * FloorRingPool — beat pulse rings on the floor around her feet.
 *
 * A tiny **object pool**: three ring meshes are built once, and every beat
 * re-arms one of them. Nothing is created on a beat — no mesh, no geometry, no
 * material, no vector — so a 150 BPM track costs three draw calls and some
 * arithmetic, and the GC never sees the music.
 *
 * One pulse per detected beat, born under her current position and left there,
 * so she trails rings if she travels. Each pulse expands outward and fades out
 * over its life; its reach and brightness are scaled by the beat's strength, so
 * a soft beat is a small dim ripple and a hard kick is a wide bright one.
 *
 * **Anticipation.** The beat clock exposes the director's *predicted* next beat
 * (`nextAt`) and whether that prediction is trustworthy (`reliable`). When it
 * is, the ring fires a fraction of a beat early so the visual lands ON the beat
 * instead of after the analyser has confirmed it; the detected beat that
 * follows never spawns a second ring (a minimum gap plus the consumed
 * prediction stamp), so anticipation shifts the timing without ever doubling it.
 *
 * The dance itself is untouchable from here: this reads a beat clock and three
 * numbers of state, writes only to its own meshes, and is never consulted by
 * the animation state machine.
 */

/**
 * Tuning for the whole effect. Everything here is in the same units the runtime
 * uses: milliseconds, metres, 0..1 strengths.
 */
const RING_CONFIG = {
  /** Rings in the pool. Three covers the life below up to ~230 BPM. */
  poolSize: 3,
  /**
   * LOW tier keeps a single ring. The pool is deliberately SIMPLIFIED rather
   * than switched off: one reused quad is cheaper than the trail it replaces,
   * and a beat you can hear with nothing on screen reads as broken. (The
   * spectrum ring in §4.1, which is ~80 instances, is the one that drops out on
   * LOW entirely.)
   */
  lowTierPoolSize: 1,
  /** Life of one pulse in ms — how long it expands before it is done. */
  lifeMs: 780,
  /** Radius a pulse is born at / dies at, in metres (scaled by strength). */
  startRadius: 0.2,
  endRadius: 0.72,
  /** Peak opacity at spawn, before the strength scale. */
  baseOpacity: 0.55,
  /** Strength scale band: a 0-strength beat still moves, a full one is loud. */
  minScale: 0.55,
  /** Height above y=0 — clears the floor plane, and the per-ring stack below. */
  floorY: 0.012,
  /**
   * Per-ring height offset so two live rings never sit exactly coplanar (which
   * makes the additive blend flicker as the depth test picks a winner).
   */
  ringYStep: 0.0012,
  /** Radius fraction of the ring band (0..1 of the outer radius). */
  bandInner: 0.72,
  /** Geometry segments — a floor circle only ever needs enough to look round. */
  segments: 64,
  /** Pink, matching the scene's rim light; additive so it reads as a glow. */
  color: 0xff9ad5,
  /** Earliest a pulse may fire ahead of a predicted beat (ms). */
  anticipationMs: 110,
  /**
   * A detected beat this soon after the prediction we fired for is the SAME
   * musical event, confirmed late (the analyser holds a beat for ~100 ms), not
   * a second one — so it must not spawn a second ring. Anchoring this to the
   * predicted beat instead of to the previous spawn means the swallow holds
   * however late the confirmation lands, and a beat we predicted but the
   * analyser never confirmed does not swallow the next real one.
   */
  anticipationConfirmMs: 280,
  /** Backstop rate limit: never spawn twice inside this window (ms). */
  minSpawnGapMs: 150,
  /** Fade curve: 1 = linear, >1 = holds bright then falls away. */
  fadePower: 1.35,
} as const;

/** One pooled ring: its Three.js objects plus the state that animates them. */
interface PooledRing {
  readonly mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  readonly material: THREE.MeshBasicMaterial;
  /** True while this ring is mid-pulse (and therefore on screen). */
  active: boolean;
  /** Age of the pulse in ms. */
  ageMs: number;
  /** Radius the pulse was born at and the radius it reaches at its end. */
  radiusFrom: number;
  radiusTo: number;
  /** Opacity at spawn, before the age fade. */
  peakOpacity: number;
}

export class FloorRingPool {
  /** Parent added to the scene — everything this effect owns lives under it. */
  readonly object: THREE.Group;

  private readonly rings: PooledRing[] = [];
  private readonly beat: BeatPulse;
  /** How many rings may be live at once (the tier budget). */
  private poolLimit: number = RING_CONFIG.poolSize;
  private _enabled = true;
  /** Spawn point (XZ) — her position when a pulse is born. */
  private anchorX = 0;
  private anchorZ = 0;
  /** Beat bookkeeping — rising edges, anticipation claims and rate limiting. */
  private lastSeenBeatAt = 0;
  /** The predicted beat a pulse was already fired for (0 = none). */
  private anticipatedAt = 0;
  private lastSpawnAt = Number.NEGATIVE_INFINITY;

  constructor(opts: { scene: THREE.Object3D; beat: BeatPulse }) {
    this.beat = opts.beat;
    this.object = new THREE.Group();
    this.object.name = "floor-ring-pool";
    // Additive, depth-tested, not depth-writing: the rings glow over the stage
    // and are still occluded by her body instead of floating through it.
    const geometry = new THREE.RingGeometry(RING_CONFIG.bandInner, 1, RING_CONFIG.segments, 1);
    for (let i = 0; i < RING_CONFIG.poolSize; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: RING_CONFIG.color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      // A unit ring rotated flat onto the floor; the pulse scale becomes metres.
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = RING_CONFIG.floorY + i * RING_CONFIG.ringYStep;
      mesh.visible = false;
      mesh.frustumCulled = false; // it is always under her; culling it costs more than it saves
      this.object.add(mesh);
      this.rings.push({
        mesh,
        material,
        active: false,
        ageMs: 0,
        radiusFrom: RING_CONFIG.startRadius,
        radiusTo: RING_CONFIG.endRadius,
        peakOpacity: RING_CONFIG.baseOpacity,
      });
    }
    opts.scene.add(this.object);
  }

  /** Whether the effect may fire at all (the user's visualizer setting). */
  get enabled(): boolean {
    return this._enabled;
  }

  /** How many pulses are on screen right now. */
  get activeCount(): number {
    let n = 0;
    for (const ring of this.rings) {
      if (ring.active) n++;
    }
    return n;
  }

  /** Rings this tier is allowed to keep live. */
  get limit(): number {
    return this.poolLimit;
  }

  /**
   * Master switch (the `visualizersEnabled` setting). Turning it off mid-beat
   * clears the floor immediately rather than leaving a pulse to fade, so the
   * setting reads as instant.
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) this.clear();
  }

  /**
   * Apply the active quality tier: LOW keeps a single ring, everything else
   * gets the full pool. Shrinking the pool releases the extra rings on the spot.
   */
  setQuality(tier: QualityTier): void {
    this.poolLimit = tier === "low" ? RING_CONFIG.lowTierPoolSize : RING_CONFIG.poolSize;
    for (let i = this.poolLimit; i < this.rings.length; i++) {
      this.release(this.rings[i]);
    }
  }

  /** Where the next pulse is born (her hips, XZ — the rings stay where they land). */
  setAnchor(x: number, z: number): void {
    this.anchorX = x;
    this.anchorZ = z;
  }

  /** Hide every pulse immediately (dance stopped, disabled, disposed). */
  reset(): void {
    this.clear();
    // Keep tracking the music from where it is now: a reset must not make the
    // next frame re-fire the beat that already passed.
    this.lastSeenBeatAt = this.beat.at;
    this.anticipatedAt = 0;
    this.lastSpawnAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * One frame. Reads the beat clock once, spawns at most one pulse, then ages
   * every live pulse. Allocation-free: the only objects in play were built in
   * the constructor.
   *
   * @param dt Frame delta in seconds (already clamped by the render loop).
   * @param nowMs `performance.now()` — the same clock the beat stamps use.
   */
  update(dt: number, nowMs: number): void {
    const pulse = this.beat;

    // Beat bookkeeping runs even while switched off, so turning the effect back
    // on resumes on the NEXT beat instead of retro-firing the one that landed
    // while it was off.
    const newBeat = pulse.at !== this.lastSeenBeatAt;
    if (newBeat) this.lastSeenBeatAt = pulse.at;

    if (this._enabled) {
      // 1. Anticipation — fire just ahead of the predicted beat, once per
      //    prediction. `lead > 0` also rejects a stale prediction left over
      //    from music that already stopped.
      let anticipated = false;
      if (pulse.reliable && pulse.nextAt !== this.anticipatedAt) {
        const lead = pulse.nextAt - nowMs;
        if (lead > 0 && lead <= RING_CONFIG.anticipationMs) {
          this.anticipatedAt = pulse.nextAt;
          anticipated = this.spawn(pulse.strength, nowMs);
        }
      }

      // 2. The confirmed beat. The rising edge is the beat timestamp itself, so
      //    repeat frames of one beat can never spawn twice. The beat that
      //    confirms a prediction we already fired for is swallowed — unless the
      //    anticipation never made it onto the floor (rate limited), in which
      //    case this is the only chance that beat gets.
      if (newBeat && pulse.at > 0 && !(anticipated || this.confirmsPrediction(pulse.at))) {
        this.spawn(pulse.strength, nowMs);
      }
    }

    // 3. Age the live pulses: expand outward, fade out, retire at the end.
    const stepMs = dt * 1000;
    for (const ring of this.rings) {
      if (!ring.active) continue;
      ring.ageMs += stepMs;
      const t = ring.ageMs / RING_CONFIG.lifeMs;
      if (t >= 1) {
        this.release(ring);
        continue;
      }
      // Ease-out expansion (fast off the beat, settling as it dies) with a
      // stronger fade curve so the ring thins away instead of popping out.
      const eased = 1 - (1 - t) * (1 - t);
      ring.mesh.scale.setScalar(ring.radiusFrom + (ring.radiusTo - ring.radiusFrom) * eased);
      ring.material.opacity = ring.peakOpacity * Math.pow(1 - t, RING_CONFIG.fadePower);
    }
  }

  /**
   * True when this detected beat is the confirmation of the prediction a pulse
   * was already fired for — the same musical event, not a second one.
   */
  private confirmsPrediction(beatAt: number): boolean {
    // `anticipatedAt === 0` means "no prediction claimed" — never a stamp at
    // t=0, which would otherwise swallow the first beats of a fresh page.
    if (this.anticipatedAt <= 0) return false;
    const since = beatAt - this.anticipatedAt;
    return since >= 0 && since <= RING_CONFIG.anticipationConfirmMs;
  }

  /**
   * Arm one pulse. Skips if the last one is still fresh (rate limit), and
   * recycles the oldest ring when the pool is exhausted — the visual becomes a
   * shorter trail rather than an unbounded one.
   *
   * @returns true when a ring actually went live (false = rate limited).
   */
  private spawn(strength: number, nowMs: number): boolean {
    if (nowMs - this.lastSpawnAt < RING_CONFIG.minSpawnGapMs) return false;

    let ring: PooledRing | undefined;
    for (let i = 0; i < this.poolLimit; i++) {
      const candidate = this.rings[i];
      if (!candidate.active) {
        ring = candidate;
        break;
      }
    }
    if (!ring) {
      // Every ring is live: steal the oldest one.
      ring = this.rings[0];
      for (let i = 1; i < this.poolLimit; i++) {
        if (this.rings[i].ageMs > ring.ageMs) ring = this.rings[i];
      }
    }

    const s = Math.min(Math.max(strength, 0), 1);
    const scale = RING_CONFIG.minScale + (1 - RING_CONFIG.minScale) * s;
    this.lastSpawnAt = nowMs;
    ring.active = true;
    ring.ageMs = 0;
    ring.radiusFrom = RING_CONFIG.startRadius;
    ring.radiusTo = RING_CONFIG.endRadius * scale;
    ring.peakOpacity = RING_CONFIG.baseOpacity * scale;
    ring.mesh.position.x = this.anchorX;
    ring.mesh.position.z = this.anchorZ;
    ring.mesh.scale.setScalar(ring.radiusFrom);
    ring.material.opacity = ring.peakOpacity;
    ring.mesh.visible = true;
    return true;
  }

  /** Retire one pulse: off screen, and never left holding a stale opacity. */
  private release(ring: PooledRing): void {
    ring.active = false;
    ring.ageMs = 0;
    ring.material.opacity = 0;
    ring.mesh.visible = false;
  }

  private clear(): void {
    for (const ring of this.rings) this.release(ring);
  }

  /** Remove the effect from the scene and free its GPU resources. */
  dispose(): void {
    this.clear();
    this.object.removeFromParent();
    // All three meshes share one geometry, so disposing the first is enough.
    this.rings[0]?.mesh.geometry.dispose();
    for (const ring of this.rings) ring.material.dispose();
    this.rings.length = 0;
  }
}
