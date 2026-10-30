# Technical Audit: 3D World Mode & Dynamic Dance Camera

**Target Application:** TanStack Start / React 19 / Three.js / `@pixiv/three-vrm` AI Anime Waifu Live Wallpaper  
**Audit Date:** 2026-10-17  
**Status:** Audit Complete — No application files modified

---

## 1. Executive Summary

This audit inspects the current Three.js rendering pipeline, VRM animation system, background handling, and settings architecture in preparation for:

1. **3D World Mode (ON/OFF toggle):** When OFF, keeps the current transparent WebGL canvas with 2D DOM background image. When ON, displays a real-time 3D environment with a stylized floor, environment lighting, and real-time shadow casting.
2. **Dynamic Dance Camera:** Smoothly transitions from user OrbitControls to a rhythmic, movement-following cinematic camera during dance animations, adding subtle beat-synced motion and micro-shake, then smoothly returning to the default camera orbit upon completion.

All findings below were verified directly from the codebase.

---

## 2. Core Systems Audit

### 2.1 Scene Creation, Renderer, Camera, and Rendering Loop

- **Primary File:** [`src/waifu/renderer.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/renderer.ts)
  - **Class:** `Renderer` (lines 17–736)
  - **Scene:** `this.scene = new THREE.Scene()` (line 166).
  - **Camera:** `this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50)` (line 167). Initial position `(0, 1.35, 2.6)`, looking at `(0, 1.3, 0)`.
  - **WebGLRenderer:**
    - Instantiated with `{ alpha: true, antialias: this.quality.tier !== "low", premultipliedAlpha: false, powerPreference: "high-performance" }` (lines 171–176).
    - `this.renderer.setClearColor(0x000000, 0)` (line 178) sets full alpha transparency, allowing the 2D HTML background to display behind the 3D character.
    - Tone mapping exposure: `ACESFilmicToneMapping` (High), `ReinhardToneMapping` (Medium), `NoToneMapping` (Low) (lines 194–202, 507–515).
    - Shadow mapping: `this.renderer.shadowMap.enabled = true`, `type = THREE.PCFShadowMap` on High/Medium tiers; disabled on Low tier (lines 204–210, 517–531).
  - **Post-Processing:**
    - `EffectComposer` chain: `RenderPass(scene, camera)` → `UnrealBloomPass` (High tier only) → `OutputPass()` (lines 183–193, 467–487).
  - **Camera Orbit Controls:**
    - `this.controls = new OrbitControls(this.camera, this.interactionDom)` (lines 230–243).
    - Configured with damping factor `0.08`, polar limits `[0.2, 1.4]`, distance limits `[0.8, 5.0]`, target copied from `chestTarget = new THREE.Vector3(0, 1.3, 0)`.
    - Auto-rotation: enabled after idle delay (8–10s) via `autoRotateTimer`, but disabled during dance via `setAutoRotateEnabled(allowed)` (lines 451–457).
  - **Render Loop:**
    - Driven by `requestAnimationFrame(this.loop)` (lines 616–701).
    - Integrates visibility pausing (`createVisibilityPause`), user FPS cap (`resolveFpsCapMs`), Dynamic Resolution Scaling (`DynamicResolutionScaler`), Adaptive Quality tier evaluations (`AdaptiveQualityGovernor`), target focus lerping, `controls.update()`, invocation of registered updaters (`for (const fn of this.updaters) fn(dt)`), and finally `composer.render()`.
  - **Lighting Setup (Existing):**
    - Ambient Light: `new THREE.AmbientLight(0x404060, 0.15)` (line 398).
    - Hemisphere Light: `new THREE.HemisphereLight(0xffffff, 0x444466, 0.7)` (line 401).
    - Key Directional Light: `new THREE.DirectionalLight(0xffffff, 1.2)` at `(1.5, 3, 2)` (lines 404–422). `castShadow = true` on High/Medium tiers with shadow map size 1024 / 512.
    - Rim Directional Light: `new THREE.DirectionalLight(0xffaadd, 1.2)` at `(-1.5, 1.8, -1.5)` (line 423).
    - Fill Directional Light: `new THREE.DirectionalLight(0x88ccff, 0.3)` at `(-1, 0.5, 1.5)` (line 427).

- **Wrapper Controller:** [`src/waifu/controller/RenderingController.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/controller/RenderingController.ts)
  - **Class:** `RenderingController` (lines 11–189).
  - Encapsulates `Renderer` and acts as the single boundary between Three.js and the rest of the application.
  - Connects render loop to event bus: `this.renderer.addUpdate((dt) => this.bus.emit("render:tick", { dt }))`.
  - Exposes read-only access to `scene` and `camera`, methods for `setCameraTarget()`, `setQuality()`, `setFpsCap()`, `setMaxPerfMode()`, and pointer/gesture delegates.

- **Stage Component:** [`src/waifu/WaifuStage.tsx`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/WaifuStage.tsx)
  - Manages stage DOM container (`<div ref={containerRef} className="absolute inset-0">`).
  - Instantiates `EventBus` and `RenderingController` inside `useEffect([modelUrl])` (lines 108–133).
  - Adds the VRM scene to the renderer and calculates initial camera target based on model bounding box center: `targetY = center.y + size.y * 0.18; rendering.setCameraTarget(0, targetY - 0.08, 0)` (lines 141–149).

---

### 2.2 VRM Model Loading and Updates

- **Loading & Sanitization:** [`src/waifu/vrmLoader.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/vrmLoader.ts)
  - **Function:** `loadVRM(url: string): Promise<VRM>` (lines 6–64).
  - Uses `GLTFLoader` with `DRACOLoader` and `@pixiv/three-vrm`'s `VRMLoaderPlugin`.
  - Sanitizes vertices and skeleton: `VRMUtils.removeUnnecessaryVertices(gltf.scene)`, `VRMUtils.combineSkeletons(gltf.scene)`.
  - Sets `obj.frustumCulled = true` on all meshes.
  - Adjusts VRM 0.x models to facing +Z using `VRMUtils.rotateVRM0(vrm)`.
  - **Shadow Finding:** Note that `loadVRM` currently does **not** enable `castShadow` or `receiveShadow` on any of the VRM skinned meshes.

- **Update Loop Execution:** [`src/waifu/WaifuCharacterController.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/WaifuCharacterController.ts)
  - Registers with renderer loop: `this.rendering.addUpdate((dt) => this.update(dt))` (line 216).
  - **Update Pipeline:** `update(dt: number)` (lines 487–581) strictly orders updates every tick:
    1. `this.animation.update(dt, waifuState)` (Animation mixer, ASM tick, expression, idle, lip-sync).
    2. `this.behaviorEngine.update(dt)` (AI Animation Director returns and cooldowns).
    3. `this.physics.update(...)` (Secondary physics: hair, cloth, tail, accessories).
    4. Beat visualizers: `floorRings.update()` and `particleBurst.update()` reading `this.hipsNode` world position.
    5. Camera auto-rotate gate: `this.rendering.setAutoRotateEnabled(this.animation.stateMachine.currentAnimState !== "dance")` (line 521).
    6. `this.touchReactions.update(dt)` (Torso/head additive rotations).
    7. Gaze & look-at target positioning (`this.lookAtTarget`).
    8. **`this.vrm.update(dt)`** (line 580): Applies all normalized bone transforms, morph targets, and spring bones to the raw skeleton.
    9. **Dance Camera Update (Target Hook):** Must execute immediately after `this.vrm.update(dt)` so `hipsNode.getWorldPosition()` reflects current frame transforms without 1-frame tracking latency.

---

### 2.3 Animation Playback & State Detection (Idle, Poses, Emotes, Dances)

- **Animation Loader:** [`src/waifu/vrmAnimationLoader.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/vrmAnimationLoader.ts)
  - Loads `.vrma` files with `VRMAnimationLoaderPlugin` and converts them to `THREE.AnimationClip` using `createVRMAnimationClip`.
  - **Dance Root Motion Sanitization:** `sanitizeRootMotion(clip, vrm)` (lines 159–216):
    - Lateral travel (X/Z) on hips is damped to 15% (`ROOT_TRAVEL_DAMP = 0.15`), keeping the character centered while preserving natural weight shifts and vertical bob.
    - Hips yaw is unrolled and recentered so her dominant heading faces the camera (+Z).
    - Sanitized clips are cached with `#rootlocked` suffix.

- **State Machine:** [`src/waifu/controller/AnimationStateMachine.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/controller/AnimationStateMachine.ts)
  - **States:** `idle`, `talking`, `listening`, `happy`, `sad`, `thinking`, `gesture`, `surprised`, `dance`, `pose`.
  - **Idle:** Persistent base layer `idleAction` running continuously in `THREE.LoopRepeat`. Faded back in with `restoreIdleAnimation()` (lines 482–493) when one-shots or dances end.
  - **Looping States:** `talking`, `listening`, `thinking` run looping clips.
  - **One-Shots:** `happy`, `sad`, `gesture`, `surprised`, `pose` play with `LoopOnce` and `clampWhenFinished = true`.
  - **Dances:**
    - Initiated via `playDance()` or `playAiDance(url, durationMs)`. Sets `this.danceRequested = true`, `animState = "dance"`.
    - Next dance clip is pre-loaded asynchronously at weight 0 (`preloadNextDance()`) to prevent T-pose gaps on transitions.
    - Cycles to next dance when `director.shouldTransition()` is true (or after timeout) using a 0.2s crossfade and a random start phase offset.

- **Animation Start and End Detection:**
  - **Dance Start:** Synchronously enters `animState = "dance"`, triggers `director?.onDanceStarted(nextMeta)`.
  - **One-Shot End:** Checked per-frame in `tick(dt)` (lines 946–963):
    ```ts
    if (ONESHOT_STATES.has(this.animState)) {
      const clipRunning = this.currentAction?.isRunning() ?? false;
      if (this.currentAction && !clipRunning) {
        this.events.emit("anim:complete", { from: this.animState });
        this.requestState(fallback, true);
      }
    }
    ```
  - **Mixer Finished Event:** `this.mixer.addEventListener("finished", this._onFinished)` (lines 153–160) acts as an event-driven backstop for clips that finish unexpectedly.
  - **Dance End:**
    - Music stopping or user manual exit calls `stopDance()`, which resets `this.danceRequested = false`, executes `transitionToIdle()`, fades out dance action, and restores idle.
    - Locked AI dance: `tick(dt)` checks `performance.now() >= this.aiDanceUntil` (line 911), then invokes `this.onAiDanceEnded?.()`.
  - **External Dance Gate:**
    - Checked in `WaifuCharacterController` via `this.animation.stateMachine.currentAnimState === "dance"`.
    - Managed in `CharacterBehaviorEngine` (`src/waifu/CharacterBehaviorEngine.ts`) via states `"DANCING"`, `"PRE_DANCE"`, `"POST_DANCE"`.

- **Dance Director:** [`src/waifu/DanceDirector.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/DanceDirector.ts)
  - Real-time audio analyzer for musical dance matching (BPM, energy tier 0–4, spectral flux, musical phrase boundaries).
  - Exposes `this.beatPulse: BeatPulse`:
    ```ts
    export interface BeatPulse {
      readonly at: number; // performance.now() timestamp of beat
      readonly strength: number; // 0..1 intensity of beat
      readonly nextAt: number; // predicted timestamp of upcoming beat
      readonly reliable: boolean; // whether tempo tracking is confident
    }
    ```
  - This provides the timing source for dynamic camera shake and rhythmic bob.

---

### 2.4 Current Background System and Low-End Mode

- **Background Implementation:**
  - Defined in [`src/waifu/types.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/types.ts) (`background: string`, default `"/backgrounds/bg2.jpg"`).
  - Handled in [`src/routes/index.tsx`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/routes/index.tsx) (lines 924–939):
    ```tsx
    const bgStyle = useMemo(() => {
      if (settings.background.startsWith("color:")) {
        return { backgroundColor: settings.background.slice("color:".length) };
      }
      return {
        backgroundImage: `url(${settings.background})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      };
    }, [settings.background]);
    ```
  - Applied as inline CSS on the outer DOM container `<div className="glass-ui relative min-h-screen ...">` (line 958).
  - Three.js canvas in `Renderer` has `alpha: true` and `clearColor(0x000000, 0)`, placing the 3D character directly on top of the 2D background image.
  - **Currently, there is no 3D floor or environment mesh in Three.js.** The only existing floor element is the beat-reactive ring pool ([`src/waifu/visualizer/FloorRingPool.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/visualizer/FloorRingPool.ts)), which renders at `floorY = 0.012` (12mm above `y = 0`).

- **Low-End Mode & Quality Scaling:**
  - Configured in [`src/waifu/performance.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/performance.ts) (`QualityTier = "low" | "medium" | "high"`):
    - Hardware-based initial detection via `detectQualityTier()`.
    - Low Tier Parameters: `renderScale: 0.6`, `pixelRatio: 0.75`, `physicsHz: 60`, `physicsIterations: 1`, `physicsFlutter: false`, `physicsColliders: "head"`.
    - Renderer Adaptations on Low Tier:
      - Disables shadow mapping entirely (`renderer.shadowMap.enabled = false`, `keyLight.castShadow = false`).
      - Sets tone mapping to `NoToneMapping`.
      - Disables antialiasing at context initialization.
      - Removes `UnrealBloomPass` from post-processing composer.
    - Dynamic Resolution Scaling ([`src/waifu/dynamicResolution.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/dynamicResolution.ts)): Dynamically adjusts render buffer dimensions during frame drops without resizing the CSS canvas.
    - Adaptive Quality Governor ([`src/waifu/adaptiveQuality.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/adaptiveQuality.ts)): Automatically steps tiers down/up with hysteresis if average FPS degrades.

---

### 2.5 UI Settings and Saved Preferences

- **Settings Interface:** [`src/waifu/types.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/types.ts)
  - `Settings` interface (lines 57–106).
  - `DEFAULT_SETTINGS` object (lines 108–164).
- **Storage Bridge:** [`src/lib/storageBridge.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/lib/storageBridge.ts)
  - Key: `waifu.settings.v1` in `localStorage`.
  - `storageBridge.loadSettings()` loads from local storage (or Supabase for authenticated users) merged with `DEFAULT_SETTINGS`.
  - `storageBridge.saveSettings(settings)` serializes the full settings JSON to `localStorage` (or Supabase).
- **UI Controls:** [`src/waifu/SettingsPanel.tsx`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/SettingsPanel.tsx)
  - Settings flyout drawer rendered in `src/routes/index.tsx`.
  - Contains toggles for quality tiers, visualizers, dance sync, relationship mode, background selection, etc.

---

### 2.6 Existing Controllers to Extend (Avoid Duplicating)

| Component                        | File Path                                                                                                                                                                                            | Existing Responsibilities                                                                                              | Recommended Extension                                                                                                                                              |
| :------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Renderer`**                   | [`src/waifu/renderer.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/renderer.ts)                                                                                                       | Manages `scene`, `camera`, `controls` (`OrbitControls`), key light, shadow map, resize observer, render loop.          | Add 3D environment container/floor toggle, switch `setClearColor` between transparent and opaque 3D background, support external camera position/target overrides. |
| **`RenderingController`**        | [`src/waifu/controller/RenderingController.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/controller/RenderingController.ts)                                                           | Façade between `Renderer` and `WaifuCharacterController`.                                                              | Expose `set3DWorldMode(enabled: boolean)` and methods to bridge dynamic dance camera state.                                                                        |
| **`WaifuCharacterController`**   | [`src/waifu/WaifuCharacterController.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/WaifuCharacterController.ts)                                                                       | Coordinates all domain systems: animation, dance director, physics, visualizers, hips bone position (`this.hipsNode`). | Instantiate and update the `DanceCameraController`, feeding it `dt`, `isDancing`, `hipsNode`, and `danceDirector.beatPulse`.                                       |
| **`DanceDirector`**              | [`src/waifu/DanceDirector.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/DanceDirector.ts)                                                                                             | Musical dance selection, beat tracking, tempo, and energy calculations.                                                | Consume `beatPulse` and `energy` directly for camera bob and shake modulation; do not build a separate audio beat detector.                                        |
| **`Settings` / `SettingsPanel`** | [`src/waifu/types.ts`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/types.ts), [`src/waifu/SettingsPanel.tsx`](file:///c:/Users/Welcome/Desktop/anime%20wifu/src/waifu/SettingsPanel.tsx) | App settings definition and UI panel.                                                                                  | Add `world3DEnabled: boolean` to `Settings` and add a clean UI Switch in `SettingsPanel.tsx`.                                                                      |

---

## 3. Architecture Blueprint for Intended Features

```
                                  +-----------------------+
                                  |   src/routes/index    |
                                  |  (Settings / bgStyle) |
                                  +-----------+-----------+
                                              |
                                      +-------v-------+
                                      |  WaifuStage   |
                                      +-------+-------+
                                              |
                        +---------------------+---------------------+
                        |                                           |
            +-----------v-----------+                   +-----------v-----------+
            |  RenderingController  |                   |  WaifuCharController  |
            +-----------+-----------+                   +-----------+-----------+
                        |                                           |
            +-----------v-----------+                               |
            |       Renderer        |                               |
            | - OrbitControls       |                               |
            | - 3D Environment (New)|                               |
            |   * Floor Mesh (PBR)  |                               |
            |   * Ground Shadows    |                               |
            |   * Sky/Room Backdrop |                               |
            +-----------+-----------+                               |
                        ^                                           |
                        |      smooth position/target override      |
                        +-------------------------------------------+
                                            |
                               +------------v------------+
                               |   DanceCameraController |
                               |          (New)          |
                               | - Smooth tracking       |
                               | - Subtle orbital drift  |
                               | - Beat-sync bob & shake |
                               | - Return interpolation  |
                               +-------------------------+
```

### 3.1 3D World Mode (ON / OFF)

- **When 3D World Mode is OFF:**
  - WebGL renderer background is transparent: `renderer.setClearColor(0x000000, 0)`.
  - 3D environment meshes (floor, room backdrop, stage pillars/lights) have `visible = false`.
  - Outer HTML container displays standard 2D image `settings.background` (`/backgrounds/bg2.jpg`, etc.).
  - Existing visualizer rings continue to render at `y = 0.012`.
- **When 3D World Mode is ON:**
  - 3D environment meshes are set to `visible = true`.
  - 3D floor is positioned at `y = 0` (immediately beneath the beat rings at `y = 0.012`), with `receiveShadow = true`.
  - VRM model meshes are traversed and set to `castShadow = true` (while keeping `receiveShadow = false`).
  - Three.js background is set via `scene.background = new THREE.Color(...)` (or an environment sky/gradient dome), which cleanly occludes the transparent WebGL clear color and the underlying DOM background without causing React component re-renders or DOM repaints in `index.tsx`.
  - When switched OFF, setting `scene.background = null` and restoring `renderer.setClearColor(0x000000, 0)` immediately reveals the 2D CSS background again.
  - Low-end mode compatibility: On `tier === "low"`, shadows remain disabled (`shadowMap.enabled = false`), and floor materials use simplified unlit or standard shading to preserve 60 FPS.

### 3.2 Dynamic Dance Camera

- **Dedicated Controller:** Implement a modular `DanceCameraController` in `src/waifu/camera/` (or `src/waifu/controller/`).
- **State Machine Coordination:**
  - Reads `this.animation.stateMachine.currentAnimState === "dance"` or listens to state changes.
  - **Entry Phase:** When dance begins, disengages OrbitControls (`controls.enabled = false`), records current camera position and target, and initiates a smooth cinematic framing blend (1.0s–1.5s cubic ease-out).
  - **Active Dance Phase:**
    - Smoothly tracks the character's hips/chest position (`hipsNode.getWorldPosition()` or damped chest position) with camera spring damping.
    - Incorporates subtle rotational drift and camera elevation changes matching the music's energy tier from `DanceDirector`.
    - Rhythmic bob and micro-shake driven by `DanceDirector.beatPulse` (strength-weighted positional offset decayed per frame).
  - **Exit Phase:** When dance finishes, smoothly interpolates (lerp/slerp over ~1.2s) back to the standard view target `chestTarget = (0, 1.3, 0)` and default camera orbit position.
  - **OrbitControls State Resynchronization:** Before re-enabling `controls.enabled = true`, explicitly sync OrbitControls' internal spherical coordinates to prevent a violent snap-back:
    1. Align camera matrix: `camera.lookAt(chestTarget)`.
    2. Synchronize target: `controls.target.copy(chestTarget)`.
    3. Force internal recalculation: `controls.update()`.
    4. Re-enable user interaction: `controls.enabled = true`.
- **Execution Order within Render Loop:**
  - In `renderer.ts`, `controls.update()` runs _before_ `this.updaters`.
  - `WaifuCharacterController.update(dt)` runs inside `this.updaters`.
  - Crucially, `danceCameraController.update(dt)` must be called **after `this.vrm.update(dt)`** (line 580 in `WaifuCharacterController.ts`) or call `this.hipsNode.updateWorldMatrix(true, false)` beforehand so that hips world position is evaluated from the current frame's animation transforms, avoiding a 1-frame tracking lag during fast dance moves.

---

## 4. Potential Technical Risks & Gotchas

1. **VRM Material Cel-Shading Acne (Self-Shadowing):**
   - VRM characters use `@pixiv/three-vrm` MToon materials. In standard Three.js shadow passes, enabling `receiveShadow = true` on character meshes often causes dark raster striping (shadow acne) across the face and hair.
   - _Mitigation:_ Set `mesh.castShadow = true` on all VRM skinned meshes so the character casts crisp shadows onto the floor, but keep `mesh.receiveShadow = false` on face/body meshes.
2. **Z-Fighting with Visualizer Floor Rings:**
   - `FloorRingPool` meshes are positioned at `floorY = 0.012` with step offsets `i * 0.0012` (lines 56–61).
   - _Mitigation:_ The 3D floor mesh must be positioned at `y = 0` (or `y = -0.0005`), ensuring the visualizer rings float cleanly 12mm above the floor without depth buffer contention.
3. **OrbitControls Desynchronization & Snap-Back:**
   - In addition to fighting active camera overrides during movement, `OrbitControls` caches internal spherical coordinates (`radius`, `phi`, `theta`). If the camera is moved dynamically and `controls.enabled` is simply turned back on, the first user mouse/touch input will cause an immediate snap-back to pre-dance angles.
   - _Mitigation:_ Explicitly set `controls.target.copy(chestTarget)`, call `controls.update()`, and only then restore `controls.enabled = true`.
4. **Window Resizing Mid-Dance:**
   - Dynamic camera calculations must respect canvas aspect ratio changes during window resize events so FOV does not clip the character on mobile or ultrawide screens.
5. **Low-End GPU Budget:**
   - Adding a complex 3D environment could overload low-tier devices.
   - _Mitigation:_ Ensure 3D environment assets (geometry, textures) adhere to the existing `AdaptiveQualityGovernor` and `getQualitySettings(tier)` tiers.

---

## 5. Recommended Implementation Order

1. **Step 1: Settings & Type Definitions**
   - Add `world3DEnabled: boolean` to `Settings` interface in `src/waifu/types.ts` (default `false`).
   - Add `world3DEnabled: false` to `DEFAULT_SETTINGS`.
   - Add toggle switch to `src/waifu/SettingsPanel.tsx`.
2. **Step 2: 3D Environment Subsystem (Floor & Lighting)**
   - Create `src/waifu/environment/WorldEnvironment.ts` (manages floor mesh at `y = 0`, shadow receiver, and `scene.background`).
   - Implement stylized floor with `receiveShadow = true`, plus environment backdrop/lighting.
   - Set `mesh.castShadow = true` and `mesh.receiveShadow = false` on character meshes in `vrmLoader.ts` (or `WaifuStage.tsx`) to avoid MToon cel-shading acne.
   - Add `set3DWorldMode(enabled: boolean)` in `Renderer.ts` and `RenderingController.ts`.
   - Toggle `scene.background = colorOrSky` vs `null` without modifying React DOM background styles.
3. **Step 3: Dynamic Dance Camera Controller**
   - Create `src/waifu/camera/DanceCameraController.ts` with explicit states (`INACTIVE`, `BLENDING_IN`, `ACTIVE`, `BLENDING_OUT`).
   - Implement smooth tracking of `hipsNode`, gentle orbital drift, and beat-synchronized micro-shake using `danceDirector.beatPulse`.
   - Implement smooth return-to-base interpolation and OrbitControls spherical resynchronization.
4. **Step 4: Integration in `WaifuCharacterController`**
   - Wire `DanceCameraController` into `WaifuCharacterController.ts` at the end of `update(dt)`, immediately following `this.vrm.update(dt)`.
   - Gate dynamic camera based on `world3DEnabled` and `animState === "dance"`.
5. **Step 5: Quality & Performance Validation**
   - Verify Low, Medium, and High quality tiers.
   - Validate that turning 3D World Mode OFF completely preserves the original 2D image background experience with zero regressions.

---

## 6. Unverified Items

- The exact stylistic preference for the 3D environment (e.g. realistic room vs. anime stage vs. neon cyberpunk grid platform) was not specified in the prompt and will be chosen during implementation.
- No issues or blockers were found that would prevent implementing either feature.
