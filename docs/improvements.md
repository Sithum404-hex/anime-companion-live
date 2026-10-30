# Waifu Site — Improvement & Implementation Plan

Audit of the current build (`src/waifu/**`) with concrete, prioritized upgrades.
Focus areas you asked about: **physics**, **touch interactions (normal modes)**,
**high performance mode**, and **Yuki dance + audio visualizers**.

---

## LIVE MODE (shipped — Gemini Live realtime conversation)

Yuki now has a third mode, **Live**, alongside Chat and Screen Vision:
realtime mic + webcam conversation through Google's Gemini Live API
(`gemini-2.5-flash-native-audio-latest`, raw WebSocket, ephemeral-token auth —
see the model note below; `gemini-3.8-live` does not answer audio turns).
Replies are spoken
with the EXISTING Soundcast/Typecast voice (Gemini's native audio is discarded;
its output transcription feeds the normal VoiceEngine → lip-sync pipeline).

- Push-to-talk only: **Space** (keydown/keyup, auto-repeat + text fields
  ignored) or the on-screen hold button (mouse + touch via pointer events).
- Camera/mic are open ONLY while PTT is held; between turns everything is
  released. Frames: 1 immediate frame on press, then ~1 fps, 640×360,
  JPEG q0.6, near-identical scenes skipped (sampled-pixel diff check).
- One Gemini session persists while in Live mode. The resumption handle is owned
  by the controller (not the client instance) and re-seeded into every new
  connection, so context genuinely survives the ~10 min WebSocket limit — see
  the resumption fix below and `scripts/diag-live-resume.cjs`.
- Latency: replies are spoken **sentence by sentence**. Streaming transcript
  text is split on `.`/`!`/`?`/`…` boundaries as it arrives (partial trailing
  text is buffered, so "3.14" and "e.g." stay intact), and each finished
  sentence is synthesized + played immediately. She therefore starts talking
  after the first sentence instead of after the whole reply.
- Overlap: while one sentence plays, the next queued sentence is pre-synthesized
  through the existing TTS cache (`prefetchSpeech`, same options as the speak
  path so it is a guaranteed cache hit) — synthesis cost overlaps playback
  instead of adding to it.
- Ordering + safety: a single consumer drains the queue in order; any
  superseding event (new PTT press, cancel, exiting Live, unmount) bumps a
  speech generation counter and clears the queue, so a cancelled reply can
  never resume mid-sentence.
- Interruption: pressing PTT while she speaks cancels Soundcast playback,
  stops the speaking animation, and flushes the in-flight Gemini turn.
- Emotion tags: every Gemini reply starts with a registry-aligned tag
  (`[happy]`, `[bashful]`, `[kiss]`, …) that drives her VRM expression and
  body animation through the SAME chat-mode paths (`onAIResponse` →
  ExpressionController, `onAiAnimationIntent` → registry validation →
  CharacterBehaviorEngine). Tags are buffered across transcription chunks,
  stripped before Soundcast, and shown as a pill in the Live panel.
- Setup: add `GEMINI_API_KEY` to `.env.local` (server-side only — the browser
  receives short-lived ephemeral tokens from the new `liveToken` server fn).

**Bug fixes found by driving the real UI (all verified against the live API):**

- **Wrong model (the actual "Live never answers" bug).** `gemini-3.8-live`
  accepts `setup`, returns `setupComplete` and even runs server-side VAD
  (`voiceActivity` → `ACTIVITY_START`) — but then sends an empty
  `serverContent` and never transcribes or answers, so Live mode looks
  connected and silently never replies. Verified by replaying real speech
  (Typecast-generated PCM, 16 kHz) through the exact same client: with
  `gemini-3.8-live` and `gemini-3.1-flash-live-preview` there is no input
  transcription and no reply; with `gemini-2.5-flash-native-audio-latest` the
  full turn works — `inputTranscription` → `[happy]`-tagged reply →
  `turnComplete`. `LIVE_MODEL` is now that verified model (re-test any new
  candidate before changing it).
- **`connect()` never resolved.** `setupComplete` set `setupAck` and fired
  `onReady`, but nothing settled the awaited promise — so a perfectly healthy
  session sat until the 15 s backstop and was then closed, surfacing as
  "Gemini Live connection timed out" (and, with the mic then failing, nothing
  worked at all). The setup promise is now settled on `setupComplete`; a
  verified connect takes ~1–2 s. Server-side error messages (`msg.error`) are
  also surfaced now instead of being swallowed until the timeout.
- **The microphone never started.** `createScriptProcessor(1600, 1, 1)` threw
  `IndexSizeError` — Web Audio only accepts `0` or a power of two in
  [256, 16384]. Now `MIC_BUFFER_SIZE = 2048` (≈43 ms chunks @ 48 kHz).
- **Stuck on "Thinking…".** A silent/failed turn gets no `turnComplete`, so
  the state machine never left PROCESSING. A 15 s turn watchdog now returns to
  Idle with "No response received — try again.", and it is disarmed the moment
  real output arrives.
- **Actionable errors.** Raw DOM exceptions are mapped to user-facing text
  (microphone blocked / not found / busy) instead of `NotAllowedError`.
- **Glued words in the reply text ("missedyoutoo").** Each streamed output
  transcription delta was `trim()`-ed and concatenated, so the word boundaries
  Gemini puts _between_ deltas were lost — the panel text read wrong and the
  spoken sentences were mispronounced (the TTS input had the same glue).
  A shared `joinStreamedText()` now inserts a space only when neither side
  already has one, never inside CJK text, never before punctuation
  (`,.`/`)`) and never after opening brackets/quotes-split tokens (`3` +
  `.14` stays `3.14`).
- **Stuck on "Thinking…" after a barge-in answer.** Gemini's VAD can end the
  turn _while PTT is still held_ — the full reply plays during `Listening` —
  and on release `finishTurn()` re-marked the turn PROCESSING after it had
  already been spoken, with nothing left to settle it (no new chunks, no new
  `turnComplete`). `maybeFinishSpeaking()` now settles PROCESSING → IDLE too,
  and `finishTurn()` calls it, so the panel returns to Idle whether or not the
  answer arrived before the release.
- **Honest camera badge.** If the webcam fails to open, "Cam ON" no longer
  lies — `cameraActive` is cleared with the failure (vision stays optional).
- **Compact Live panel.** The control card was ~330 px tall and covered the
  scene; it is now a ~110 px three-row strip (state · emotion · mic/cam, then
  an only-when-present transcript/error row, then the PTT button + Exit), so it
  reads as a wallpaper HUD instead of a modal. "Connecting…" also only appears
  while a PTT hold is actually waiting on the handshake (the session is
  created lazily), instead of showing permanently while idle.
- **Verified end-to-end (real speech, real API):** spoken turns fed through the
  app's own capture path (Typecast-generated PCM exposed as a `getUserMedia`
  audio stream, so `startMic` captures genuine speech) produce e.g.
  `You: "Hey Yuki, I brought you some strawberry milk. Do you want some?"` →
  `excited` emotion pill → `Ooh, strawberry milk! Yay, I love it!` → **two**
  Soundcast utterances (`VoiceEngine … session 3` then `session 4`), i.e. the
  sentence-level queue synthesises and plays each sentence separately. The
  state chip walks `Ready → Listening → Speaking → Idle` and now settles to
  Idle even when the reply finished before the PTT release.
- **Lip-sync verified by measurement, not by eye.** A spy on
  `LipSyncController.update` (the viseme driver writing the VRM
  `aa/ee/ih/oh/ou` blendshapes) recorded a single 65-frame burst of wide mouth
  values (peak 0.63) exactly aligned with the `VoiceEngine` playback window,
  and only breathing amplitude (≤ 0.06) outside it.
- **The start of every sentence was thrown away** (the real "she never hears me"
  bug). The mic must open _before_ connecting — browsers gate
  `AudioContext.resume()` on transient user activation, so awaiting the Gemini
  handshake first left the context suspended and captured nothing at all. The
  cost of that ordering is that ~1–2 s of speech is recorded before there is a
  socket to send it on, and `onaudioprocess` simply returned while
  `!client.connected`. Measured with real speech: asking
  _"Hey Yuki, I brought you some strawberry milk. Do you want some?"_ arrived at
  Gemini as **"milk. Do you want some?"** — she reliably missed the beginning, so
  users had to hold PTT longer purely to be heard. Chunks captured during the
  handshake are now buffered (`audioPreRoll`, capped at ~4 s) and replayed, in
  order, the moment the session is ready. After the fix the same sentence
  transcribes **100 %**: `"Hey Yuki, I brought you some strawberry milk. Do you
want some?"`.
- **Session resumption never actually happened.** `ensureSession()` builds a new
  `GeminiLiveClient` for every connect, but the resumption handle lived only on
  the client instance — so it died with it and every reconnect (the ~10 min
  limit, a network blip, an expired token) silently restarted the conversation
  from nothing, despite the docs claiming one session persisted. The handle is
  now owned by `LiveModeController`, pushed out via `onResumptionHandle` and
  re-seeded into each new client (and cleared on exit, since it belongs to the
  dropped session). Verified against the live API: turn 1 tells her a fact →
  server issues a handle → socket dropped → reconnect seeded with the handle →
  _"Your favorite color is teal!"_, while a cold control session answers _"I don't
  know"_. Note the server only issues a handle once there is real conversation
  content, so a one-line probe legitimately gets none.
- **Diagnostics that reported false failures.** `scripts/diag-live-turn.cjs` fed
  a synthetic 220 Hz sine tone, which Gemini's VAD does not classify as speech,
  so it printed `RESULT: FAIL — no conversational turn` on a completely healthy
  system — the most likely reason Live looked broken when it was not. It now
  reports `INCONCLUSIVE` for tone input and points at the real-speech tests.
  `scripts/diag-live-ws.cjs` also defaulted to `gemini-3.8-live`, the
  known-silent model, so running it with no argument reproduced the outage on
  demand; it now defaults to the verified model.
- **Talking state — mostly fine, one residual nuance.** The earlier "Live never
  enters `talking`" note no longer reproduces. A timestamped ASM/TTS timeline
  shows the correct sequence: the `[emotion]` one-shot plays
  (`Thinking → Gesture → ai:Happy.vrma`), then the engine returns to
  `Gesture → Talking → talking:Talking` and _holds_ it for the remainder of the
  audible speech (~5 s across two sentences) before dropping to `Idle` on TTS
  end. The remaining nuance: when an emotion one-shot happens to outlast the
  speech, she finishes in `Idle` rather than `Talking`, because
  `CharacterBehaviorEngine.onTtsStarted()` cannot enter `SPEAKING` while
  `currentAction` is occupied. Cosmetic and self-correcting, but it is a real
  (if occasional) state-bookkeeping inconsistency. Related: `AiAnimationDirector`
  (331 lines, holding the same "keep `talking` while `speaking`" logic) is
  **dead code** — it is never instantiated, and its `onTtsStarted`/`onTtsEnded`
  are never called, so its `speaking` flag is permanently `false`.
- ⚠️ **Known gap remaining:** `GEMINI_API_KEY` was missing from
  `docs/deploy-guide.md`, so deploying by the guide left Live mode broken in
  production ("GEMINI_API_KEY not set on server") while Chat and Screen kept
  working. Documented, with an explicit note that Live needs it.
- **Honest camera badge (regression guard).** `cameraActive` was set to `true`
  immediately after the mic opened, before the webcam was even requested, so the
  badge claimed a camera that could still fail to open. It now switches on when
  frames actually flow and off again if the camera fails.
- Diagnostics: `scripts/diag-live-models.cjs` lists every Live-capable model the
  key can reach and flags whether `LIVE_MODEL` still exists;
  `scripts/diag-live-ws.cjs` logs every raw Live WebSocket message;
  `scripts/diag-live-text.cjs` runs text turns across N models;
  `scripts/diag-live-speech.cjs` runs a real-speech audio turn at the protocol
  level; `scripts/diag-live-resume.cjs` proves context survives a reconnect; and
  `scripts/e2e-live-hifi.cjs` drives the **real browser app** end to end (real
  `createLiveToken` server fn, real WebSocket, real `startMic()` capture path)
  with speech fed through Chrome's actual fake audio device, reporting the exact
  audio chunks/bytes that reached Gemini plus a timestamped ASM/TTS timeline.

Files: `src/lib/liveToken.ts`, `src/waifu/liveClient.ts`,
`src/waifu/liveMode.ts`, `src/waifu/LiveControl.tsx`, plus wiring in
`src/routes/index.tsx`, `src/waifu/WaifuStage.tsx`,
`src/waifu/WaifuCharacterController.ts` (new `cancelSpeech()`).

> **Design principle (locked):** touch reactions are **normal-mode only**.
> When Yuki is dancing, she is performing — taps/pokes/gestures must never
> interrupt the choreography, exactly like a real girl absorbed in her dance.
> The existing gate in `WaifuCharacterController.ts` is _correct by design_
> and stays. Everything in §1 below applies to non-dance states
> (IDLE/TALKING/HAPPY/CURIOUS/…).
> she should be like a realistic give by every coner and every time

---

## 0. TL;DR — Top 10 quick wins

| #   | Item                                                                                        | Effort | Impact           |
| --- | ------------------------------------------------------------------------------------------- | ------ | ---------------- |
| 1   | Directional poke impulses from the actual ray-hit point                                     | S      | Realism          |
| 2   | Add an audio **visualizer system** (none exists today)                                      | M      | Showcase feature |
| 3   | Body-zone reactions — head pat, face blush, hand wave (normal mode)                         | M      | "Real girl" feel |
| 4   | Fixed-timestep physics accumulator (frame-rate independent springs)                         | M      | Stability        |
| 5   | Kill per-frame `new THREE.Vector3()` allocations in physics hot loop                        | S      | GC / stutter     |
| 6   | Add body colliders (shoulders/chest/spine capsules) — hair clips during dance               | M      | Visual quality   |
| 7   | True "Battery Saver / Max Perf" toggle (30 fps cap + physics substep reduction)             | S      | Mobile           |
| 8   | Continuous dynamic resolution scaling instead of discrete tier jumps                        | M      | Smoothness       |
| 9   | Haptic feedback (`navigator.vibrate`) on mobile pokes/beats — ✅ shipped                    | S      | Mobile feel      |
| 10  | Remove dead code: `CursorTracker.ts` never imported; unused `skip` var in `renderer.ts:340` | XS     | Hygiene          |

---

## 1. Touch Interactions (normal modes only)

### 1.1 Why touch stays OFF during dance — intentional, keep it

`src/waifu/WaifuCharacterController.ts:152`:

```ts
this.events.on("input:interaction", () => {
  ...
  // Clicks are frozen while she's dancing — they must not interrupt the dance
  if (this.animation.stateMachine.currentAnimState === "dance") return;
  this.physics.poke();
  ...
});
```

This gate is a **feature, not a bug**. Reasons it should stay:

- Dance clips own the entire skeleton. Any queued emote/state change mid-clip
  forces a crossfade that visibly breaks choreography timing.
- Beat-sync depends on `DanceDirector` anchors (`danceStartTime`,
  `bpmAtDanceStart`); an interruption desyncs her from the music.
- Realism goal: a girl dancing doesn't freeze mid-spin because someone poked
  her — she keeps dancing. Ignoring touches _is_ the realistic behavior.

No changes recommended here. All interaction work below targets the other states.

### 1.2 Directional impulses from the real hit point

Today `SecondaryPhysicsManager.poke()` fires a **random-direction burst** through
every chain regardless of where the user touched.

The raycast in `renderer.ts` (`handlePointerDown`) already intersects the model —
return the hit point + surface normal:

```ts
// renderer.ts
const hits = this.raycaster.intersectObjects(this.clickableRoot.children, true);
if (hits.length > 0) {
  this.onInteractionStart?.();
  this.onPoke?.(hits[0].point, hits[0].face?.normal ?? null); // NEW
}
```

Then in `SecondaryPhysicsManager`, apply force **with distance falloff**:

```ts
poke(at: THREE.Vector3): void {
  for (const sys of [this.hair, this.cloth, this.tail, this.accessories]) {
    sys.applyImpulseAt(at, radius = 0.35, strength = 5.5);
  }
}
// In each subsystem: per-bone falloff
// f = dir * strength * smoothstep(radius, 0, dist(bone.position, at))
```

This alone makes touches feel _physical_ — hair near the finger blasts away,
distant strands barely move. (Normal-mode touches; dance keeps its gate.)

### 1.3 Body-zone reactions — the "real girl" layer (normal mode) — ✅ SHIPPED

Map ray-hit Y position / bone name / surface normal / world position to
reactions, exactly as specified here. See `src/waifu/touchZones.ts` (pure,
unit-tested classifier), `src/waifu/TouchReactionController.ts` (debounced
reactions + lean/recoil envelopes), `src/waifu/touchHeartFx.ts` (CSS-only
hearts) and `scripts/test-touch-reactions.ts` (27 checks).

| Zone      | Detection                                   | Reaction                                                       | Status |
| --------- | ------------------------------------------- | -------------------------------------------------------------- | ------ |
| Head      | bone ancestry / crown-height hair hit       | "head pat": lean INTO the touch, closed-eye happy face, hearts | ✅     |
| Face      | head anchor + camera-facing surface normal  | embarrassed blush + step back (non-dance only)                 | ✅     |
| Hand      | hand anchor proximity                       | quick wave/high-five emote                                     | ✅     |
| Hair/Tail | classified secondary bone (nearest visible) | localised physics impulse (stronger scale)                     | ✅     |
| Skirt     | cloth chain                                 | physics impulse; grab-and-drag shipped (1.4)                   | ✅/✅  |

Every expressive reaction is debounced (per-zone cooldowns + a 450 ms global
floor, `PHYSICS_CONFIG.touch.cooldownMs`); physics impulses are not debounced
for feel. Dance gate: touches in the dance state return before any reaction.

### 1.4 Grab & drag secondary motion — ✅ SHIPPED

While the pointer is held down on hair/skirt/tail/accessory chains, the pointer
ray is projected onto a camera-facing plane through the grab point and nearby
Verlet points feel a clamped spring toward it:

```ts
// per fixed substep while dragging (dragChainsAt in PhysicsBone.ts)
force = (pointerTarget − bone.position) · strength · falloff(dist to grab point)
force = clampLength(0, PHYSICS_CONFIG.drag.maxForce)
bone.applyForce(force);
```

Release → natural snap-back with Verlet overshoot (the spring force simply
disappears; existing restoration pulls the chains home). Normal mode only —
the dance gate answers `null` in `onDragCheck`, so dance keeps the gesture for
the camera. Implementation map:

- `touchDrag.ts` — `TouchDragController`: camera-plane projection,
  displacement clamp, borrowed zero-alloc view (`view()`)
- `touchZones.ts` — `findDragChainAt`: grab decision (ancestry → mesh-skeleton
  evidence → occlusion-tested nearest secondary bone; head-pat radius excluded)
- `PhysicsBone.ts` — `dragChainsAt`: shared clamped spring force field
- `SecondaryPhysicsManager.setDrag` / `applyDragStep` — per-substep routing by
  chain family (accessories ride along with hair/tail grabs)
- `renderer.ts` — capture-phase `pointerdown` runs before OrbitControls; a
  grab disables orbit for that gesture, uses `setPointerCapture`, and ends on
  `pointerup` / `pointercancel` / `pointerleave`; `dispose()` cancels
- `WaifuCharacterController` — dance gate + dance-start/unmount cancellation;
  `PHYSICS_CONFIG.drag` holds the tuneables

Unit tests: `scripts/test-touch-drag.ts` (23 checks).

### 1.5 Stage gestures — unified pointer path (new) — ✅ SHIPPED

The renderer now runs a single pointer-event path (`pointerdown`/`move`/`up`/`cancel`
with `setPointerCapture`) for the character side and a separate document-level
stage-gesture recognizer on the same stream. The recognizer classifies tap /
double-tap / long-press / swipe-up / two-finger-tap using <8 px + <300 ms for
tap and never touches OrbitControls — camera rotation is unaffected unless the
user is actually dragging the stage. Implementation:

- `src/waifu/stageGestures.ts` — `StageGestureRecognizer`, pure classify logic
  with deterministic thresholds (8 px / 300 ms / 600 ms / 320 ms / 10 px);
- `src/waifu/controller/RenderingController.ts` — stage-gesture callbacks
  (`onStageDoubleTap`, `onStageTwoFingerTap`, `onStageSwipeUp`);
- `src/waifu/WaifuCharacterController.ts` — mounts the recognizer, forwards
  through the dance gate, implements double-tap emote, two-finger confetti
  burst (short-lived DOM puff, no new systems), swipe-up dance-intensity boost
  (safe during dance);
- `src/waifu/WaifuStage.tsx` — mounts/dispose forwarding.

Gestures aimed **at her** (character zone hits) are normal-mode only and use the
existing touch path; stage gestures never interrupt the animation, so they're
safe (kept working) during dance:

| Gesture                               | Action                                                                                             | Mode              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------- |
| Double-tap on stage                   | Happy emote (queued, normal-mode only — not while dancing)                                         | Normal only       |
| Long-press (>600ms, no move) on stage | No stage reaction (character long-press lives on the hit side via `TouchReactionController`)       | —                 |
| Swipe up on stage                     | Dance intensity preference bumped briefly (`danceDirector.setIntensityPreference("high")` for ~6s) | Safe during dance |
| Two-finger tap                        | Short-lived CSS confetti puff (DOM, no rAF loop, no new physics/visualizer systems)                | Safe during dance |

### 1.6 Haptics (mobile) — ✅ SHIPPED

`src/waifu/haptics.ts` owns every vibration; no other module calls
`navigator.vibrate` directly.

| Moment                      | Pattern                              | Gate                                                       |
| --------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| Poke that actually hits her | `12 ms` tick (unchanged feel)        | Normal modes only — the existing dance gate runs before it |
| Music beat                  | `7–14 ms` pulse, nudged by intensity | Rising edge of the beat flag + a 220 ms minimum spacing    |

```ts
this.haptics.poke(); // short poke tick
this.haptics.beat(audio.beat, audio.intensity); // subtle beat pulse
```

Why it is safe:

- **Capability-checked** — `navigator.vibrate` is missing on iOS Safari and in
  several embedded webviews. `isHapticsSupported()` drives the Settings hint,
  and every call degrades to a no-op; a `vibrate()` that throws
  (“no sticky activation”, permission policy) is swallowed, never surfaced.
- **Setting** — `settings.hapticsEnabled` (“Haptic feedback (mobile)”, default
  **on**, so the shipped poke tick is unchanged for anyone who never opens
  Settings) is the single master switch. Turning it off cancels anything
  already buzzing and forgets the current beat.
- **No excessive vibration** — `vibrate()` cancels the previous pattern, so the
  beat path fires on the **rising edge** of the analyser's beat flag only, and
  refuses anything closer than `BEAT_MIN_INTERVAL_MS` (220 ms → at most ~4.5
  pulses/second). A stuck-high beat flag yields exactly one pulse instead of one
  per frame; ten seconds of 60 fps frames at ~4 Hz yields ~20 pulses.
- **Output only** — haptics read nothing and write nothing except the device
  vibrator. The beat pulse consumes the very same `animation.audioSnapshot()`
  the physics step already consumes, and no caller branches on the result, so a
  haptic can never change dance, animation or physics state.
- **Hidden tabs are skipped** — browsers reject vibration there anyway; skipping
  avoids the console warning.

One path, not two: the duplicate `navigator.vibrate?.(12)` that lived in
`renderer.ts` was removed. A single touch poke used to fire **two** overlapping
12 ms vibrations (one at the renderer, one in the controller); the controller's
(capability-checked, dance-gated) call is now the only one.

Logic checks: `node scripts/dev/test-haptics.cjs` (stubbed Vibration API —
capability, gate, edge/debounce, intensity clamp, throw and hidden-document
paths).

### 1.7 Unify on Pointer Events — ✅ SHIPPED

`renderer.ts` was already using `pointerdown`/`pointermove`/`pointerup`/`pointercancel`
for the character-drag side; the stage-gesture recognizer now shares the same pointer
stream via the renderer's capture-phase forwarders (`onStagePointerDown/Move/Up/Cancel`).
One code path for mouse/touch/pen, `setPointerCapture` on the drag side, `touch-action: none`
already set on `interactionDom`. The recognizer never installs its own document listeners in the
app — it is driven by the renderer forwarders — so rotating/pinching the camera (OrbitControls)
never accidentally fires stage gestures.

---

## 2. Physics — what to improve

> Current setup runs **two parallel systems**: the custom Verlet chains
> (`SecondaryPhysicsManager`: Hair/Cloth/Tail/Accessory) AND the native VRM
> spring bones re-tuned every frame by `SecondaryMotionController` inside
> `vrm.update()`. First action item: **audit whether both drive the same hair
> bones** (double simulation = fighting transforms + wasted CPU).

### 2.1 Fixed timestep (frame-rate independence)

`PhysicsBone.simulate()` integrates `force * dt` with variable dt (capped at 33 ms).
Spring response (`stiffness * 8`) therefore changes between 60 Hz phones and
120 Hz phones.

```ts
// SecondaryPhysicsManager.update()
this.acc += Math.min(dt, 0.05);
const H = 1 / 120; // fixed 120 Hz substeps
while (this.acc >= H) {
  this.stepAll(H); // verlet integrate + constraints
  this.acc -= H;
}
```

Low tier: `H = 1/60`, 1 iteration instead of 3. High tier keeps 120 Hz × 3.

### 2.2 Eliminate allocations in the hot loop

Per frame today (roughly): `HairPhysics` clones gravity, allocates headPos +
per-chain force vectors; `PhysicsBone.simulate()` allocates ~6 vectors per bone;
`applyImpulse()` clones per bone; ×3 constraint iterations ×60 fps → thousands of
short-lived objects/sec → GC hitches mid-dance.

Fix with module-scoped scratch vectors:

```ts
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
```

and refactor `simulate/constrainDistance/applyRotation/applyImpulse` to reuse them.
Also hoist `organicWave` results computed identically for every chain.

### 2.3 Body colliders — stop hair clipping during dance

Only a head sphere exists (`HEAD_RADIUS 0.12`). During spins/arm swings hair and
skirts pass through torso/arms.

Add capsule colliders built once from humanoid bones:

- Spine capsule (hips → neck, r≈0.09)
- Each upper-arm capsule (shoulder→elbow, r≈0.05) — updated per frame from bone matrices
- Hip spheres L/R (r≈0.08)

Cost: ~7 sphere/capsule tests per bone — negligible vs. the 3 constraint
iterations. Reuse `PhysicsBone.collideSphere`; add `collideCapsule` (point-segment
distance).

### 2.4 Choreography-driven hip inertia (PRIMARY dance driver, not the beat) — ✅ SHIPPED

The beat impulse stayed a **subtle musical additive** on top of the choreography.
The primary source of dance secondary motion is now the **hips' actual world
motion**, read once per rendered frame by a new `HipMotionTracker` and fed to
every chain as opposite-direction inertia. Random beat motion is no longer the
main driver.

**Architecture in one picture:**

- `src/waifu/physics/HipMotionTracker.ts` — owns read-only snapshots of the
  hips/root bone: `pivot` (hip world position), `velocity` (smoothed m/s),
  `acceleration` (smoothed m/s²), `yawRate` (rad/s about world +Y) and
  `yawAcceleration` (rad/s²), all EMA-smoothed/frame-rate-independent and
  clamped to `PHYSICS_CONFIG.global.hipInertia`. Nothing here mutates a bone;
  it is a pure reader, which is why physics driven by it can never steer the
  dance.
- `src/waifu/physics/PhysicsBone.ts` — new shared helper `hipInertiaChains()` +
  `HipInertiaDrive` interface. Applied to every non-root bone of a chain, with
  three physical terms: **linear** = opposite to the hip's acceleration
  (hip forward ⇒ strands lag back; hip left ⇒ strands lag right), **tangential**
  = −α × r (a spin/twist leaves the strands behind), **centrifugal** = +ω² r
  (strands flung outward during a spin). Weighted along each chain (roots barely
  move, tips react most, same curve as the impulse path) and clamped per bone, so
  no clip and no spin can blow the solver up.
- `src/waifu/physicsConfig.ts` — new `hipInertia` block: EMA time constant,
  sample-dt clamp, accepted speed/acceleration/yaw bands, the three gain terms
  (`accelGain`, `velGain`, `yawAccelGain`, `centrifugalGain`), `maxForce`, per-family
  gain (`hair:1 / cloth:0.6 / tail:0.45 / accessories:0.55`) and per-state response
  (dance = 1, idle = trace).
- Each subsystem (`HairPhysics`, `TailPhysics`, `ClothPhysics`, `AccessoryPhysics`)
  gains `applyHipInertia(drive)` — the public per-subsystem entry point — and the
  `SecondaryPhysicsManager` reads the hips once per frame (`hipMotion.sample(dt)`),
  builds the drive in `updateHipDrive(animState)`, and calls the four
  `applyHipInertia(this.hipDrive)` calls **per fixed substep** (so 60/90/120 Hz
  integrate the same hip motion identically), **after** the drag step and **before**
  each subsystem integrates.

**Random component is demoted, not removed.** The beat kick is now a clean upward
bounce (`upwardBase` + intensity-scaled `upwardIntensity`) with a deliberately
small `randomShare` (0.22) so the music no longer invents body motion — the hips
do that. Beat and hip inertia coexist; the hip inertia is the loud one.

**Dance is untouched by design:** the tracker only reads transforms, the drive only
writes forces into the physics chains, and no caller branches on a return value.
Verification (`scripts/dev/smoke-dance-physics.cjs`, 41 browser checks across slow /
fast / spinning / high-energy clips): each clip keeps one clip, one `"dance"` state,
monotonic mixer time, and unchanged clip timing; the hair tip's offset from its own
anchor negatively correlates with hip velocity and with hip acceleration (the new
signal); the vertical bounce correlation collapses when the drive is stubbed out
(A/B attribution); a spin-only experiment (linear + tangential zeroed, centrifugal
left) shows the strands deflect outward with ω²; and stopping the dance returns her
to a calm normal state.

Logic checks: `node scripts/dev/test-hip-inertia.cjs` (signs, clamps, rotation
terms, inactivity, tracker prime/reset, all pass). Lint/typecheck/build clean.

Files: `src/waifu/physics/HipMotionTracker.ts`, `src/waifu/physics/PhysicsBone.ts`
(`HipInertiaDrive` + `hipInertiaChains`), `src/waifu/physicsConfig.ts` (`hipInertia`),
`src/waifu/physics/HairPhysics.ts`, `src/waifu/physics/TailPhysics.ts`,
`src/waifu/physics/ClothPhysics.ts`, `src/waifu/physics/AccessoryPhysics.ts`,
`src/waifu/physics/SecondaryPhysicsManager.ts`, `scripts/dev/test-hip-inertia.cjs`,
`scripts/dev/smoke-dance-physics.cjs`.

### 2.5 Spin-aware skirt flare — ✅ SHIPPED

`hipInertiaChains` already flings every chain outward with ω²r, but at skirt
radii (~0.1–0.2 m) that term lands around 0.1 m/s² — invisible next to gravity
(≈4.9 m/s² effective). The skirt therefore needed its own term. This is a
**skirt-only** outward push that engages while the hips actually rotate and
decays back to zero when they stop.

**Architecture:**

- `ClothPhysics.initialize()` now records a `skirtFlags` entry per chain next to
  `chains` (the skirt/sleeve decision moved into one `isSkirtChain()` helper so
  `buildChain` and the flag can never disagree), plus a `skirtChains` getter for
  diagnostics/tests.
- `ClothPhysics.updateSpinFlare(dt, yawRate, pivot, stateGain)` — the **envelope**,
  called ONCE per rendered frame by `SecondaryPhysicsManager` from the same
  `HipMotionTracker` snapshot the §2.4 inertia reads, so every fixed substep of a
  frame shares one flare strength (identical at 60/90/120 Hz). Target = ramp
  (|yaw| above `minYawRate`, full at `fullYawRate`) × `strength` × tier scale ×
  state response, smoothed by an attack/decay pair (fast build, slow release) and
  snapped to a real zero below 0.4% of full strength.
- `ClothPhysics.update()` applies the current flare to **skirt panels only**,
  before each chain integrates: envelope × tip weight × clamped(r / radiusRef),
  pointing away from the hip axis in the **XZ plane only** (fabric inflates, it
  does not lift her hem), clamped per bone to `maxStrength`. One module-scoped
  scratch vector — no per-frame allocations.
- Tiers: `spinFlare.tierScale` = `{ low: 0, medium: 0.55, high: 1 }` — LOW keeps
  the flare off entirely, MEDIUM is shaded down, HIGH is full. Forwarded from
  `SecondaryPhysicsManager.setQuality()` (`q.tier`), so it rides the existing
  per-tier budget path rather than adding a second quality system.
- `clearSpinFlare()` is the explicit "stop now" API (`reset()` clears it too).

**Tuning is driven by measurement, not taste.** The shipped dance clips rotate
the hips at ~2.5–4.2 rad/s (p75–p95 of |yaw| in the browser smoke test), so
`minYawRate` 1.2 / `fullYawRate` 3.5 puts full strength inside that band: the
fast / spinning / high-energy clips flare fully, a gentle sway does not.

**Verification — `scripts/dev/test-skirt-flare.cjs` (34 logic checks, synthetic
rig):** flare is skirt-only (sleeves get exactly zero), outward on both panels,
horizontal-only, scales with yaw rate, silent below threshold, saturates past
`fullYawRate`, per-bone clamp holds even at 40× strength, LOW ⇒ zero and MEDIUM ⇒
exactly the configured fraction of HIGH (envelope _and_ applied force), a smooth
decay reaching a true zero, a rig with no skirt panels is a no-op, **zero Vector3
allocations across 20 000 flare frames** (with a live control proving the
counter works), and no regression to hip inertia / skirt drape tuning.

**Verification — `scripts/dev/smoke-dance-physics.cjs` (57 browser checks, slow /
fast / spinning / high-energy clips):** the flap cap is never exceeded; the flare
correlates with the hips' rotation on every clip (corr(flare, ω²) 0.52–0.77); the
spinning clip engages it (p75 ≈ 2.0 m/s², peak 2.9); an A/B with `updateSpinFlare`
stubbed out shows the hems sitting ~12 mm further out on the fastest frames with
the flare on vs <1 mm with it off; after the dance stops the flare is exactly
zero and the hems are back at their resting reach. Dance integrity is unchanged:
one clip, one `"dance"` state, monotonic mixer time per clip.

Files: `src/waifu/physics/ClothPhysics.ts`, `src/waifu/physicsConfig.ts`
(`cloth.spinFlare`), `src/waifu/physics/SecondaryPhysicsManager.ts`,
`scripts/dev/test-skirt-flare.cjs`, `scripts/dev/smoke-dance-physics.cjs`.

### 2.6 Per-tier physics budgets

| Tier | Substeps  | Constraint iters | Flutter waves | Colliders  |
| ---- | --------- | ---------------- | ------------- | ---------- |
| low  | 60 Hz ×1  | 1                | off           | head only  |
| med  | 90 Hz ×2  | 2                | on            | head+spine |
| high | 120 Hz ×3 | 3                | on            | all        |

Expose via `QualitySettings` (`physicsHz`, `physicsIters`) in `performance.ts`.

### 2.7 Config single-source-of-truth

`physicsConfig.ts` values are only consumed by `SecondaryMotionController`;
`HairPhysics`/`ClothPhysics` hardcode their own numbers inline. Merge both into
`PHYSICS_CONFIG` so tuning one file tunes everything.

---

## 3. High Performance Mode

Existing: 3 quality tiers + adaptive FPS switch (25↓ / 45↑) in `renderer.ts`. Gaps:

### 3.1 True "Battery Saver / Max Perf" toggle

Settings already persist `qualityTier` — add a boolean `maxPerfMode` that forces:

- RAF capped to **30 fps** (accumulator skip in `Renderer.loop`)
- `renderScale` 0.55, pixelRatio 1
- shadows OFF (medium currently enables them — see 3.4)
- physics per-tier budget from §2.6 (low)
- webcam/face tracker paused, FFT 128
- visualizers reduced to 2D overlay only (§4)

One switch, instant battery win on phones.

### 3.2 Continuous Dynamic Resolution Scaling — ✅ SHIPPED

Tier jumps cause visible quality pops. Resolution now adapts continuously via a
frame-time EMA, while tiers keep owning every non-resolution feature.

**Control law** (`src/waifu/dynamicResolution.ts`, DOM-free and unit-testable):

```ts
ema = ema * 0.95 + frameMs * 0.05; // ~20 frame memory, rejects spikes
if (ema > 20)
  scale -= 0.03; // < 50 fps  → shrink fast
else if (ema < 13) scale += 0.015; // > 77 fps  → grow slowly
// 13–20 ms is a dead band → hold; 400 ms cooldown → at most one step per window
```

| Property                      | How it is guaranteed                                       |
| ----------------------------- | ---------------------------------------------------------- |
| Decrease faster than increase | `stepDown` is 2× `stepUp` (0.03 / 0.015)                   |
| Clamped                       | `[0.5, tier renderScale]` — the tier stays the ceiling     |
| No oscillation                | 7 ms dead band + 400 ms cooldown + EMA smoothing           |
| Smooth                        | integer-quantised sizes, equality-checked before `setSize` |

**Scope discipline:** the scaler touches the drawing buffer and nothing else.
Shadows, AA, tone mapping and the animation/physics budgets stay in the tier
system, so a resolution change can never move a tier or pop a visible feature.
On a tier change the ceiling is re-seated — a downgrade pulls the scale down, an
upgrade only raises the ceiling so the scale is earned back gradually.

**Known, deliberate limit:** a vsync-locked 60 Hz screen cannot report more
headroom than ~16.7 ms, which lands inside the dead band. The scaler therefore
_settles_ at the resolution that sustains the budget and holds there instead of
probing upward — periodic probe-and-pump is exactly the oscillation to avoid.
Real recovery happens on displays that can report < 13 ms frames.

Verified by `scripts/test-dynamic-resolution.ts` (32 checks: low FPS, stable
60 FPS, high FPS, rapid changes, asymmetry, spike rejection, tier changes) and
end-to-end in the app: backing store tracked the tier base down to the 0.5 floor
while the CSS box stayed pinned at 100% — no stretching, no UI scaling, no
resize loop.

### 3.3 GC hygiene outside physics

- `DanceDirector.computeNextSelection` sorts + spreads arrays at 25 Hz — acceptable,
  but the `adjusted.map({...s})` spread can be reused buffers; low priority.
- `AnimationStateMachine`/`ExpressionController`: audit for per-frame vector/quat
  allocations same as §2.2.

### 3.4 Shadows audit

Renderer clears alpha-transparent (`setClearColor(0x000000, 0)`) over a CSS
background — verify a shadow-catcher floor mesh actually exists. If not,
**shadows are pure wasted GPU** on medium+; disable them or add an
`ShadowMaterial` floor disc (looks great + justifies the cost).

### 3.5 Renderer robustness — ✅ SHIPPED

**Context loss** — `webglcontextlost` / `webglcontextrestored` were already wired in
`Renderer`, and they hold up: loss is `preventDefault`ed (so a restore is actually
permitted), the loop early-returns while lost, and restore re-applies tone mapping,
shadows and size. Verified against a real `WEBGL_lose_context` loss — 1 frame during
the loss, rendering resumed immediately after. One gap closed: the frame-rate history
is now cleared on restore, so the one brutal frame a driver reset produces can no
longer masquerade as a struggling machine and drop a tier for a stall that already ended.

**Tier cooldown** — `src/waifu/adaptiveQuality.ts` extracts the timing half of adaptive
quality (thresholds, streaks, cooldown) into a pure, DOM-free governor. All pre-existing
thresholds are unchanged; the new behaviour is a **10 s quiet window after any tier
change, in both directions**, during which streaks are discarded so the first decision
after the window is built from fresh frames. Any tier change starts the window —
including one the user makes in Settings, which is what stops the adaptive loop from
silently reverting a deliberate pick. A one-sided cooldown would only relocate the
oscillation, so it blocks both ways. On a pathological ping-pong machine (medium @ 24 fps,
low @ 55 fps) the hop period goes from ~12 s to ~28 s.

**FPS cap** — 30 / 60 / Off, persisted as `Settings.fpsCap`, defaulting to `"uncapped"` so
existing installs see no behaviour change. The gate is a **deadline grid**
(`anchor + frameIndex * capMs`) with the index recomputed from elapsed time rather than
incremented: accumulating `next += capMs` drifts a ULP per frame and, on a display whose
refresh is an exact multiple of the cap, never recovers — a 30 fps cap on 60 Hz settled
into alternating 33/50 ms frames, which is judder _and_ an effective 24 fps. Deriving the
index from `now` also resyncs for free after a stall, with no catch-up burst.

A cap suspends DRS sampling. A pinned 33 ms interval is a choice, not a performance
signal, and feeding it to the scaler would drive the render scale to its floor while the
machine sat comfortably inside budget. The scale holds; the scaler resumes on the first
uncapped frame.

**Max Performance priority** — resolved in one place, `resolveFpsCapMs(cap, maxPerf)`, so
the ordering does not depend on which code path reads the setting. Note that Max
Performance mode itself is still **not implemented** (§3.1); only its precedence over the
cap is built and tested, via `Renderer.setMaxPerfMode()`.

**Hidden tabs** — the loop already returned before any work when `visibility.paused`.
Verified, plus one line: `createVisibilityPause()` now seeds from the live
`document.hidden` instead of `false`, so a renderer mounted into an already-hidden tab
no longer reports itself visible until the first `visibilitychange`.

Tests: `scripts/test-renderer-robustness.ts` (58 checks).

### 3.6 Loading perf

Check whether models/animations ship Draco/meshop-compressed + KTX2 textures.
VRoid VRMs are usually 30–80 MB raw; `gltf-transform optimize` typically cuts
50–70% with zero visual loss. Biggest possible first-load improvement.

---

## 4. Yuki Dance + Audio Visualizers ⭐ (missing feature)

There is **no visualizer anywhere** today — the only feedback is the text debug
overlay (`showMusicAnalysis`). All data needed already exists: `AudioAnalyzer`
produces bass/mid/treble/flux at 25 Hz and `DanceDirector` gives BPM + predicted
next-beat timestamps.

New module: `src/waifu/visualizer/VisualizerManager.ts`, registered via
`rendering.addUpdate()`, fed by the same audio snapshot physics already gets.

### 4.1 Spectrum ring around Yuki (flagship, cheap)

64–96 bars as ONE `InstancedMesh(BoxGeometry)` in a circle (r≈1.1 m) at foot
level. Per frame: `setMatrixAt(i)` scaleY from FFT bins + emissive color lerp
by band energy. Cost ≈ one draw call. Bars duck/rise with the music; on beats,
a brightness wave ripples around the ring.

### 4.2 Beat pulse rings

Pool of 3 thin `RingGeometry` meshes flat on the floor; on every detected beat,
spawn one expanding+fading ring scaled by `beatStrength`. Use
`DanceDirector.nextBeatPredictedAt` to start the expansion ~80 ms BEFORE the
predicted beat (anticipation looks magical).

### 4.3 Particle bursts

Single `THREE.Points` buffer (≤500 particles), object-pooled. Beat spawns
N∝bass particles at the ring edge with outward velocity + gravity + fade.
No per-particle objects — one BufferAttribute update.

### 4.4 Reactive background glow

Zero WebGL cost: the page already layers CSS gradients over the canvas. Drive a
radial-gradient `div`'s opacity/scale from smoothed bass via
`style.transform` (compositor-only, no layout):

```ts
glow.style.opacity = String(0.15 + bass * 0.5);
glow.style.transform = `scale(${1 + bassKick * 0.04})`;
```

### 4.5 Bloom (high tier only)

`EffectComposer + UnrealBloomPass` gated to `quality.tier === "high"` and the
visualizer toggle. Modulate `bloom.strength = base + beatImpulse * k`.
Skip entirely on medium/low (composer cost not worth it there).

### 4.6 Mini visualizer in MusicPlayer UI — ✅ SHIPPED (Visualizer v1)

Done: `MusicVisualizer.tsx` — 48-bar `<canvas>` spectrum inside the
`MusicPlayer` card, drawn from the EXISTING pipeline: `AudioPlayerManager
.getSpectrum()` hands over the exact frequency buffer `AudioAnalyzer` already
read at ~25 Hz (zero extra AnalyserNode/FFT reads, no second AudioContext);
log-spaced bands, per-bar attack/release smoothing at display rate, falling
peak caps. A CSS/DOM background glow behind the card follows the existing
smoothed `bass` getter — compositor-only `transform`/`opacity` writes with an
epsilon gate (never touches layout). Bars/glow tint from `--hud-accent`, so
they follow her mood. One rAF loop serves both; it self-stops when nothing is
playing and everything has decayed, and never schedules work while the tab is
hidden (reuses `createVisibilityPause`). Setting: `visualizersEnabled`
(default true) in Settings → Music Visualizer; disabling unmounts the
component entirely. Low tier caps canvas DPR at 1 (no 3D effects exist in v1;
future 3D visualizers must gate on `tier === "high"` per §4.5).

### 4.7 Settings + performance gating

```ts
// types.ts Settings additions
visualizersEnabled: boolean; // default true
visualizerStyle: "ring" | "particles" | "both";
```

Auto-fallback: low tier → CSS glow + mini UI canvas only (no 3D). When tab
hidden everything already pauses via `createVisibilityPause`.

---

## 5. Code health / smaller fixes

1. **Dead code:** `CursorTracker.ts` is imported nowhere (WaifuStage implements
   its own look-tracking). Delete or adopt it.
2. `renderer.ts:340` — `const skip = this.quality.animationSkip;` unused since
   frame-skipping removal.
3. `types.ts:86` duplicates `detectQualityTier()` from `performance.ts` — keep one.
4. Debug overlays poll via `setInterval(500ms)` — fine, but pause them when
   `document.hidden`.
5. Consider exposing `getFps()` in the music-analysis overlay (you already
   sample it) so users can correlate quality/FPS.
6. Root folder cleanup: dozens of scratch scripts (`smoke*.cjs`, `tpose-*.cjs`,
   `dbg*.cjs`, screenshots) — move to `scripts/dev/` or gitignore.

---

## 6. Suggested implementation order

1. **Weekend PR #1 — Touch & feel (normal modes):** §1.2 directional
   impulses, §1.3 body-zone reactions, §1.6 haptics, §5 dead-code sweep.
   (Dance gate stays exactly as-is per the design principle.)
2. **PR #2 — Visualizers v1:** §4.6 mini canvas, §4.4 glow, §4.2 beat rings,
   settings toggle.
3. **PR #3 — Physics core:** §2.2 allocations, §2.1 fixed timestep, §2.6 tier
   budgets, §2.3 colliders.
4. **PR #4 — Perf mode:** §3.1 max-perf toggle, §3.2 DRS, §3.5 robustness.
5. **PR #5 — Showtime:** §4.1 instanced spectrum ring, §4.3 particles, §4.5 bloom,
   §1.3–1.5 zone reactions/gestures, §2.4–2.5 choreography-aware physics.

---

## 7. Changelog — shipped improvements

### PR #0 — Dance bug fix: walking away / turning / showing her back ⭐

**Root causes found (two, compounding):**

1. **Root motion inside dance clips.** The Mixamo-style VRMA dance clips carry
   `hips` position + rotation tracks. Playing them verbatim physically moves her
   around the stage ("walking") and spins her heading until she faces away
   from the camera.
2. **Camera auto-rotate.** `Renderer` enabled `controls.autoRotate` after
   8–10 s without user input (`renderer.ts`). During a long hands-free dance
   session the camera slowly orbited (~150 s per revolution) and ended up
   behind her.

**Fixes shipped:**

- `vrmAnimationLoader.ts` — new `sanitizeRootMotion(clip)` post-processing +
  `{ lockRootMotion: true }` load option:
  - Hips **position** track: X/Z damped toward the per-axis median
    (`ROOT_TRAVEL_DAMP = 0.15`) → she dances centered in place; vertical bob
    untouched.
  - Hips **quaternion** track: yaw unrolled across keyframes, circular median
    taken as the clip's dominant facing, every keyframe premultiplied by a
    corrective yaw rotation so that facing points at the camera (+Z). Internal
    hip motion is fully preserved; only net heading drift is removed.
  - Sanitized clips cache under `${url}#rootlocked`, so emotes loading the same
    file stay untouched.
- `AnimationStateMachine.ts` — all three dance load paths (`playDance` direct +
  pre-loaded, `preloadNextDance`) pass `{ lockRootMotion: true }`.
- `renderer.ts` / `RenderingController.ts` / `WaifuCharacterController.ts` —
  `setAutoRotateEnabled(false)` while `animState === "dance"`; re-enabled on
  return to idle/other states. Auto-rotate can never drift behind her again.

### PR #1 — Touch & feel (shipped alongside)

- **§1.2 Directional poke impulses** — raycast hit point now flows
  `renderer.onPokeHit(point)` → `RenderingController` → controller →
  `SecondaryPhysicsManager.poke(at)`. New shared `impulseChainsAt()` applies
  force **away from the exact touch spot** with quadratic falloff across hair,
  cloth, tail and accessories. Random-burst poke remains as fallback only.
- **§1.6 Haptics** — one capability-checked, settings-gated vibration path
  (`Haptics`): the 12 ms tick on touch pokes (unchanged feel) plus a debounced
  subtle beat pulse. Output only — it never drives animation, physics or dance
  state.
- **Dance gate preserved** — reactions fire on character hits in normal modes
  only; dancing is never interrupted (design principle above).
- **Frame-loop regression fixed (audit finding)** — `WaifuCharacterController.update()`
  (mixer, behaviour engine, physics, touch envelopes, gaze, `vrm.update`) had no
  caller: nothing subscribed `render:tick` and nothing registered with the
  renderer loop, so the scene rendered a **frozen** character (`hairEnergy === 0`,
  no clip, hips quaternion static). The controller now registers itself once via
  `rendering.addUpdate((dt) => this.update(dt))` in the constructor (and
  unsubscribes in `dispose()`). Verified live: hips/hair energy advance again and
  beat haptics see frames.
- **§2.2 Physics hot-loop allocations removed** — `PhysicsBone.simulate /
constrainDistance / collideSphere / applyRotation`, `Chain.simulate` anchor,
  and `HairPhysics.update / applyImpulse` now run allocation-free via scoped
  scratch vectors/quaternions (thousands of GC objects per second eliminated).
- **§5 Dead code sweep** — deleted unused `CursorTracker.ts`; removed leftover
  `skip` var in `renderer.ts` loop; `types.ts` now imports `detectQualityTier`
  from `performance.ts` instead of duplicating it.

**Verified:** `tsc --noEmit` clean · eslint clean on all touched files ·
production build passes · `node scripts/dev/test-haptics.cjs` 17/17 (stubbed
Vibration API) · `node scripts/dev/smoke-haptics.cjs` 22/22 in a real browser
(one pulse per detected beat, exactly one 12 ms tick per landed poke, silent
while toggled off, silent with no Vibration API, no uncaught errors).
