
# 🎮 AI Anime Waifu Live Wallpaper

A 3D anime character that lives on your screen — talks, listens, reacts to sound and motion, and changes mood. Runs entirely in the browser.

## What gets built

### Page (single route `/`)
A fullscreen canvas with the VRM character centered over a chosen background. A subtle settings gear (top-right) and chat input (bottom) auto-hide after 3s of mouse inactivity and reappear on movement. Fullscreen "wallpaper mode" toggle.

### Your uploaded VRM
Your file is copied to `public/models/waifu.vrm` and set as the default. Drop more `.vrm` files into `public/models/` and add their filenames to `public/models/manifest.json` to expose them in the model selector.

### Core systems (modular, vanilla-style classes under `src/`)
- **renderer** — Three.js scene, camera, lighting, render loop
- **vrmLoader** — loads VRM models, hot-swaps without reload
- **animation** — idle breathing, auto-blink, head look-at, smooth state transitions
- **voiceEngine** — browser SpeechSynthesis with anime preset (pitch 1.6, rate 1.1) routed through Web Audio: GainNode + BiquadFilter (high-shelf boost) + light convolver reverb
- **lipSync** — AnalyserNode reads TTS audio volume → drives `vrm.expressionManager.setValue("aa", v)` with smoothing + noise clamp every frame
- **micInput** — mic stream + AnalyserNode for loudness detection
- **motionDetect** — webcam frame-difference (downscaled canvas) → motion score
- **aiEngine** — calls OpenRouter with the user's key from Settings; system prompt: *"You're a cute anime assistant. Speak in short, expressive, playful sentences. Use emotions like 'ehh?', 'yay!', 'hmm~'."*
- **stateManager** — IDLE / TALKING / LISTENING / SCARED / HAPPY with smooth blends
- **emotionSystem** — calm / happy / scared / curious; modulates voice pitch & idle timing
- **reactionSystem** — combines all inputs:
  - voice/AI reply → TALKING
  - loud noise (no speech) → SCARED
  - webcam motion → CURIOUS
  - positive AI sentiment → HAPPY
  - else → IDLE

### UI
- **Chat bar** — type or hit 🎤 for speech-to-text (Web Speech API), sends to AI, response is spoken with lip sync
- **Settings panel** (gear icon, slide-in):
  - OpenRouter API key (stored in localStorage, password field)
  - Model selector (VRM list from manifest)
  - Background selector (`bg1.jpg`, `bg2.jpg`, plus solid colors)
  - Voice on/off, mic on/off, webcam on/off
  - Sound sensitivity slider, motion sensitivity slider
  - Voice pitch & rate sliders
- **Fullscreen toggle** for live-wallpaper mode

### Persistence
All settings + selected model/background saved in `localStorage`.

### Performance
- Single `requestAnimationFrame` loop, throttled motion detection (every 3rd frame at 160×120)
- Lazy-load VRM only when selected
- No heavy ML models — pure Web APIs

## Honest limitations
- **OpenRouter key lives in browser localStorage** (your choice). Don't use a key with high spending limits.
- **VRM file listing** — browsers can't scan folders, so users edit `public/models/manifest.json` to register new models.
- **Wrapped in React/TanStack Start** (not vanilla `index.html`) since that's this project's stack — same behavior, same deployability on Vercel.
- **Backgrounds** — I'll generate two simple anime-style backgrounds (`bg1.jpg`, `bg2.jpg`) so the selector has working defaults.

## Deliverables
Working app on `/` with your VRM loaded by default, full settings panel, and all reactive systems wired up. Ready to deploy to Vercel.
