import * as THREE from "three";
import type { QualityTier } from "../performance";
import type { BeatPulse } from "../DanceDirector";

const CFG = {
  poolSize: 500,
  maxBufferVerts: 1500,
  lifeMs: 1200,
  initialSpeed: 0.9,
  gravity: 1.6,
  drag: 1.4,
  fadePower: 1.4,
  minSize: 0.02,
  maxSize: 0.1,
  color: 0xff9ad5,
  baseCount: 64,
  strengthScale: 4,
  mediumReduction: 0.55,
  minSpawnIntervalMs: 50,
  spawnHeight: 0.15,
} as const;

interface ParticleSlot {
  active: boolean;
  ageMs: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  strength: number;
}

/**
 * Beat-reactive sparkle burst. Purely additive to the scene: it reads the
 * dance director's beat clock and draws points — it never writes animation,
 * physics or dance state.
 *
 * The pool is a fixed set of 500 reusable slots. Active particles are packed
 * into the front of the attribute buffers each frame and the draw range is set
 * to the active count, so nothing here ever shrinks the pool itself.
 */
export class ParticleBurst {
  readonly object = new THREE.Group();
  readonly points: THREE.Points;

  private geometry: THREE.BufferGeometry;
  private material: THREE.PointsMaterial;
  private slots: ParticleSlot[] = [];
  private anchor = new THREE.Vector3();
  private _enabled = true;
  private poolLimit: number = CFG.poolSize;
  private lastBeatAt = -1;
  private lastSpawnAt = -Infinity;
  private beat: BeatPulse;

  constructor(opts: { scene: THREE.Object3D; beat: BeatPulse }) {
    this.beat = opts.beat;
    this.object.name = "particle-burst";
    opts.scene.add(this.object);

    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.PointsMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: false,
      size: CFG.maxSize,
      toneMapped: false,
    });

    const n = CFG.maxBufferVerts;
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setDrawRange(0, 0);

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.object.add(this.points);

    for (let i = 0; i < CFG.poolSize; i++) {
      this.slots.push({
        active: false,
        ageMs: 0,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        strength: 0,
      });
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) this.clear();
  }

  setQuality(tier: QualityTier): void {
    switch (tier) {
      case "low":
        this.poolLimit = 0;
        break;
      case "medium":
        this.poolLimit = Math.floor(CFG.poolSize * CFG.mediumReduction);
        break;
      case "high":
        this.poolLimit = CFG.poolSize;
        break;
    }
    for (let i = this.poolLimit; i < CFG.poolSize; i++) {
      const slot = this.slots[i];
      if (slot) this.release(slot);
    }
  }

  /** Anchor point (hip height) the burst radiates from. */
  setAnchor(x: number, y: number, z: number): void {
    this.anchor.set(x, y, z);
  }

  clear(): void {
    for (const slot of this.slots) this.release(slot);
    this.geometry.setDrawRange(0, 0);
  }

  update(dt: number, nowMs: number): void {
    if (!this._enabled) return;
    const stepMs = Math.max(0, dt) * 1000;

    // ── Beat trigger ──
    const pulse = this.beat;
    if (pulse.at > 0 && pulse.at !== this.lastBeatAt) {
      this.lastBeatAt = pulse.at;
      this.spawnParticles(this.spawnCount(pulse.strength), nowMs);
    }

    // ── Integrate + pack active particles into the buffer front ──
    const positions = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = this.geometry.getAttribute("color") as THREE.BufferAttribute;
    const posArr = positions.array as Float32Array;
    const colArr = colors.array as Float32Array;

    const r = ((CFG.color >> 16) & 0xff) / 255;
    const g = ((CFG.color >> 8) & 0xff) / 255;
    const b = (CFG.color & 0xff) / 255;

    let count = 0;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.ageMs += stepMs;
      const t = slot.ageMs / CFG.lifeMs;
      if (t >= 1) {
        this.release(slot);
        continue;
      }

      const sec = stepMs / 1000;
      // Gravity pulls the sparkles down, drag bleeds off their speed.
      slot.vy -= CFG.gravity * sec;
      const damping = Math.max(0, 1 - CFG.drag * sec);
      slot.vx *= damping;
      slot.vy *= damping;
      slot.vz *= damping;
      slot.x += slot.vx * sec;
      slot.y += slot.vy * sec;
      slot.z += slot.vz * sec;

      if (count >= CFG.maxBufferVerts) break;

      const fade = Math.pow(1 - t, CFG.fadePower) * slot.strength;
      const i3 = count * 3;
      posArr[i3 + 0] = this.anchor.x + slot.x;
      posArr[i3 + 1] = this.anchor.y + slot.y;
      posArr[i3 + 2] = this.anchor.z + slot.z;
      colArr[i3 + 0] = r * fade;
      colArr[i3 + 1] = g * fade;
      colArr[i3 + 2] = b * fade;
      count++;
    }

    this.geometry.setDrawRange(0, count);
    if (count > 0) {
      positions.needsUpdate = true;
      colors.needsUpdate = true;
    }
  }

  /** Particle count for a given beat strength (0..1). */
  spawnCount(strength: number): number {
    const s = Math.min(Math.max(strength, 0), 1);
    const capped = Math.min(CFG.poolSize, this.poolLimit);
    return Math.max(0, Math.min(capped, Math.floor(CFG.baseCount + s * CFG.strengthScale)));
  }

  /**
   * Ignite `count` sparkles at the anchor, radiating in a hemisphere.
   * Returns how many slots actually lit up (the pool may already be busy).
   */
  spawnParticles(count: number, nowMs: number): number {
    if (!this._enabled) return 0;
    if (nowMs - this.lastSpawnAt < CFG.minSpawnIntervalMs) return 0;
    this.lastSpawnAt = nowMs;

    let spawned = 0;
    const limit = Math.min(this.poolLimit, this.slots.length);
    for (let i = 0; i < limit && spawned < count; i++) {
      const slot = this.slots[i];
      if (!slot || slot.active) continue;

      const theta = Math.random() * Math.PI * 0.85;
      const phi = Math.random() * Math.PI * 2;
      const speed = CFG.initialSpeed * (0.5 + Math.random() * 0.5);

      slot.active = true;
      slot.ageMs = 0;
      slot.x = 0;
      slot.y = CFG.spawnHeight;
      slot.z = 0;
      slot.vx = Math.sin(theta) * Math.cos(phi) * speed;
      slot.vy = Math.cos(theta) * speed + 0.35;
      slot.vz = Math.sin(theta) * Math.sin(phi) * speed;
      slot.strength = 1;
      spawned++;
    }
    return spawned;
  }

  release(slot: ParticleSlot): void {
    slot.active = false;
    slot.ageMs = 0;
  }

  dispose(): void {
    this.clear();
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.slots.length = 0;
  }
}
