# Improvement Implementation Prompts

Each item below is a self-contained prompt: what is wrong, what to do, and how
to implement it. Items are ordered by (value × safety)/risk. Conventions: run
`npx tsc --noEmit`, `npm run lint`, and `npm run build` after each item.

---

## P0 — Repo hygiene (do first, everything else builds on this)

### P0.1 Untangle the git index

**Problem:** the staging area still contains ~280 files (+50k lines) of root
scratch scripts, duplicated asset folders (`vrm animations/`, `vrm models/`)
and a dead `chat/anime-waifu-chat/` backend that the working tree has already
deleted/moved to `scripts/dev/`. The Live-mode feature is entirely untracked.

**What to do:** make the index match the working tree, then commit the real
Live-mode feature separately from housekeeping.

**How:**

1. `git add -A` (stages the mass deletions + `scripts/dev/`).
2. Verify `.env.local` is NOT staged (it is covered by `*.local` in
   `.gitignore`; never commit it — it holds real API keys).
3. Commit 1: housekeeping — "Remove scratch files and duplicate asset copies
   from repo root".
4. Commit 2: "Add Gemini Live mode (liveClient/liveMode/LiveControl/liveToken)".

**Verify:** `git status` shows only expected untracked files; no
`smoke*.cjs`/`tpose-*.cjs` anywhere under version control; `.env.local`
absent from `git ls-files`.

---

### P0.2 Pick one package manager

**Problem:** both `bun.lockb` (+`bunfig.toml`) and `package-lock.json` exist.

**What to do:** standardize on npm (all scripts run through npm), delete
`bun.lockb` and `bunfig.toml`, commit the removal.

**Verify:** `npm ci` still installs; no `bun.lockb`/`bunfig.toml` in the tree.

---

### P0.3 Format the tree (fixes the 2,594 lint errors)

**Problem:** `npm run lint` fails with ~2,594 prettier errors (mixed LF/CRLF
line endings + unformatted scratch scripts) in `scripts/dev/*` and 14 `src/`
files. Zero real rule violations.

**How:** run `npm run format`, then `npm run lint`. For the 3 remaining real
warnings (`react-hooks/exhaustive-deps` in `src/routes/index.tsx:340`,
`:574`, `src/waifu/WaifuStage.tsx:281`), decide per case: add the missing
dep if behavior should track it, otherwise add a targeted
`// eslint-disable-next-line react-hooks/exhaustive-deps` with a comment
explaining why.

**Verify:** `npm run lint` → 0 errors; `npx tsc --noEmit` clean.

---

## P1 — Robustness fixes (highest value, low risk)

### P1.1 Recover from WebGL context loss

**Problem:** no `webglcontextlost`/`webglcontextrestored` handling; a GPU
reset (driver crash, too many tabs) leaves a black canvas until reload.

**How** (`src/waifu/renderer.ts`, in the constructor after the canvas is set
up, cleaned up in `dispose()`):

```ts
const onLost = (e: Event) => {
  e.preventDefault(); // required — tells the browser we will restore
  this.contextLost = true; // new private flag; loop() early-outs when set
};
const onRestored = () => {
  this.contextLost = false;
  this.clock.getDelta(); // swallow the multi-second delta spike
  this.setQuality(this.quality); // re-apply tone mapping/shadows/size
  this.resize();
};
this.renderer.domElement.addEventListener("webglcontextlost", onLost);
this.renderer.domElement.addEventListener("webglcontextrestored", onRestored);
```

In `loop()`, right after the visibility check:
`if (this.contextLost) { this.rafId = requestAnimationFrame(this.loop); return; }`
(Continue scheduling rAF so the loop survives.) Remove both listeners and
null the callback refs in `dispose()`.

**Verify:** `npx tsc --noEmit`; `npm run build`; in Chrome DevTools →
Application → GPU → "Lose WebGL context", the canvas recovers instead of
ging black.

---

### P1.2 Frame-rate-independent physics (fixed timestep)

**Problem:** `SecondaryPhysicsManager.update()` integrates Verlet springs with
variable `dt` (phone at 60 Hz vs. 120 Hz gets different spring response).

**How** (`src/waifu/physics/SecondaryPhysicsManager.ts`): keep an accumulator
and step the bone-level subsystems at a fixed 120 Hz; run idle motion on the
render dt.

```ts
private physicsAcc = 0;
private readonly PHYSICS_STEP = 1 / 120;

// inside update()
this.physicsAcc = Math.min(this.physicsAcc + dt, 0.05); // cap = spiral guard
let steps = 0;
while (this.physicsAcc >= this.PHYSICS_STEP && steps < 8) {
  this.hair.update(this.PHYSICS_STEP, animState);
  this.cloth.update(this.PHYSICS_STEP, animState);
  this.tail.update(this.PHYSICS_STEP, animState);
  this.accessories.update(this.PHYSICS_STEP, animState);
  this.physicsAcc -= this.PHYSICS_STEP;
  steps++;
}
this.idle.update(dt, isIdle, isSpeaking); // procedural pose stays render-dt
```

The beat-impulse block keeps using `performance.now()`, so keep it outside the
loop. Optional tier scaling (low→1/60) can follow via `performance.ts`.

**Verify:** hair/cloth still settles without jitter; behavior identical at
~60 Hz and when Chrome throttles to 30 fps; `tsc`/`lint`/`build` clean.

---

### P1.3 Unify on Pointer Events

**Problem:** `renderer.ts:169` mixes `mousedown` + `touchstart` (passive), so
pen input is unsupported and iOS can fire ghost clicks.

**How** (`renderer.ts`): replace the two listeners with one
`pointerdown` handler on `interactionDom`:

```ts
const onPointerDown = (e: PointerEvent) => {
  handlePointerDown(e.clientX, e.clientY, e.pointerType === "touch");
};
this.interactionDom.addEventListener("pointerdown", onPointerDown);
```

`touch-action: none` is already set on `interactionDom`, and OrbitControls
already speaks pointer events, so no other changes are needed. Remove the old
`mousedown`/`touchstart` registrations (store the handler reference so
`dispose()` can remove it; or leave removal to `interactionDom.remove()` —
the div is discarded, so listeners on it need no explicit teardown).

**Verify:** mouse click still pokes; touch tap still pokes and vibrates; no
double-fire on touch (exactly one `onPokeHit` per tap).

---

## P2 — Feel/quality (per IMPROVEMENTS.md)

### P2.1 Body-zone reactions (normal modes only)

Map ray-hit bone/Y to reactions in `WaifuCharacterController`: head pat
(y > ~1.45, head chain) → lean-in + happy expression; face front-hit → blush +
step back; arm hit → wave emote. Use the existing `onPokeHit(point)` — this
eeds the hit **bone name**, so extend the raycast to report
`hits[0].object.name` up to a bone. Never fires during `"dance"` (the gate at
`WaifuCharacterController.ts:152` stays).

### P2.2 Grab & drag secondary motion

While pointer is held on hair/skirt/tail, project the pointer ray onto a
camera-facing plane through the grab point and apply a spring force per
physics bone (`force = clamp((target - pos) * k)`). Release → Verlet
snap-back. Reuse `SecondaryPhysicsManager.poke(at)`'s chain routing. Normal
mode only.

### P2.3 Body colliders for hair/skirts

Only a head sphere exists today. Add capsule colliders built from humanoid
bones (spine hips→neck r≈0.09; each upper arm shoulder→elbow r≈0.05; hip
spheres r≈0.08), updated per frame from bone matrices. Reuse
`PhysicsBone.collideSphere`; add `collideCapsule` (point-segment distance).

### P2.4 Choreography-aware beat kicks

Replace the random-direction beat impulse with hip-velocity-derived inertia:
sample the hips bone world velocity between frames, inject the opposite
direction into hair/cloth/tail. Keep a small random jitter as an additive
term. Beat kicks still apply during dance (that is their purpose).

### P2.5 Skirt centrifugal flare on spins

Measure hips yaw-rate (delta of atan2 of the hip forward vector); on fast yaw,
push cloth chain tips outward horizontally. Makes skirts flare on twirls.

### P2.6 Per-tier physics budgets + one config file

| Tier | Substeps | Iters | Colliders  |
| ---- | -------- | ----- | ---------- |
| low  | 60 Hz ×1 | 1     | head only  |
| med  | 90 Hz ×2 | 2     | head+spine |
| high | 120 Hz×3 | 3     | all        |

Expose `physicsHz`/`physicsIters` in `performance.ts` `QualitySettings` and
merge `physicsConfig.ts` with the hardcoded numbers in `HairPhysics`/
`ClothPhysics` into a single `PHYSICS_CONFIG`.

### P2.7 Dynamic resolution scaling (replace discrete tier pops) — ✅ SHIPPED

> Shipped as `src/waifu/dynamicResolution.ts` + `Renderer.applyRenderScale()`.
> EMA control law, 0.5–tier ceiling, dead band 13–20 ms, 400 ms cooldown,
> 0.03 down / 0.015 up. Tiers keep shadows/AA/budgets. Covered by
> `scripts/test-dynamic-resolution.ts`. See IMPROVEMENTS.md §3.2.

Per frame: `ema = ema*0.95 + frameMs*0.05`; drop `renderScale` by 0.02 when
EMA > 20 ms, raise by 0.01 when EMA < 13 ms (asymmetric = no ping-pong).
Keep tiers for AA/shadows/tone-mapping only.

### P2.8 True battery-saver / max-perf mode

One `maxPerfMode` setting forcing: 30 fps RAF cap, `renderScale` 0.55,
pixelRatio 1, shadows off, low-tier physics, webcam/face-tracker paused,
visualizers at CSS-only. Persisted in `types.ts` `Settings`.

---

## P3 — Visualizers (§4 of IMPROVEMENTS.md)

### P3.1 Mini spectrum in MusicPlayer card

48-bar 2D canvas in `MusicPlayer.tsx`, drawn from
`audioPlayer.getByteFrequencyData()`. ~0 cost, immediate polish.

### P3.2 Beat pulse rings + CSS glow

Pool of 3 flat `RingGeometry` meshes spawning on detected beats (expanded
with `beatStrength`); drive a radial-gradient div's opacity/scale from
smoothed bass (`style.transform` only — compositor cost).

### P3.3 Spectrum ring around Yuki

One `InstancedMesh(BoxGeometry)` ring (r≈1.1 m) at foot level, 64–96 bars,
one draw call; scaleY from FFT bins, emissive color lerp by band energy.

### P3.4 Bloom (high tier only)

`EffectComposer + UnrealBloomPass` gated to `quality.tier === "high"` and the
visualizer toggle; `bloom.strength = base + beatImpulse * k`.

### P3.5 Settings + perf gate

`visualizersEnabled` / `visualizerStyle` in `Settings`; low tier → CSS glow +
mini UI canvas only; everything already pauses on tab hide.

---

## P4 — Build weight & polish

### P4.1 Compress the VRM/MediaPipe weight

`waifu.vrm` is 18 MB and MediaPipe ships ~21 MB of WASM (simd + nosimd).
Run `gltf-transform optimize` (KTX2 + meshopt + prune) on `waifu.vrm`, and
lazy-load the MediaPipe task (`@mediapipe/tasks-vision` is already dynamic-
imported by `faceTracker` — confirm the wasm only fetches on first camera use).

### P4.2 Bundle splitting

The main chunk is 1.17 MB. Split heavy, rarely-used chunks (face tracker,
screen vision, live client) via dynamic import so the wallpaper paints sooner.

### P4.3 Shadow-catcher floor audit

`renderer.ts` clears to a transparent canvas over CSS — verify a
`ShadowMaterial` floor disc exists; if not, disable shadow maps (they are
purely wasted GPU today) or add the disc.

### P4.4 Cosmetic state nuance

`CharacterBehaviorEngine.onTtsStarted()` cannot enter SPEAKING while
`currentAction` holds the skeleton (she finishes an emotion one-shot in
`Idle` instead of `Talking`). Decide: queue the talking state to run after
the one-shot, or accept Idle — then document the choice.
