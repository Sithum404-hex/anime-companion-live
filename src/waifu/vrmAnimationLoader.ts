import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { VRM } from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from "@pixiv/three-vrm-animation";

export const VRMA_ANIMATIONS = [
  "Angry",
  "Excited",
  "Happy",
  "Idle",
  "Rejected",
  "Talking",
  "DwarfIdle",
  "DwarfIdle2",
] as const;

export type VRMAAnimationName = (typeof VRMA_ANIMATIONS)[number];

/**
 * Some built-in clip names don't live at the root of /animations/.
 * Talking.vrma is only shipped in /animations/named/ — without this,
 * every "talking" state 404s and silently falls back to the idle clip.
 */
const BUILTIN_OVERRIDES: Partial<Record<VRMAAnimationName, string>> = {
  Talking: "/animations/named/Talking.vrma",
};

export function getAnimationUrl(name: VRMAAnimationName): string {
  return BUILTIN_OVERRIDES[name] ?? `/animations/${name}.vrma`;
}

let _animLoader: GLTFLoader | null = null;

/** VRMA clips only — do not register VRMLoaderPlugin (it can corrupt .vrma parsing). */
function getAnimLoader(): GLTFLoader {
  if (!_animLoader) {
    _animLoader = new GLTFLoader();
    _animLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  }
  return _animLoader;
}

const vrmAnimationCache = new Map<string, unknown>();
const MAX_CACHE_SIZE = 12;
const evictionOrder: string[] = [];

function cacheGet(url: string): unknown | undefined {
  return vrmAnimationCache.get(url);
}

function cacheSet(url: string, data: unknown) {
  if (vrmAnimationCache.has(url)) return;
  if (vrmAnimationCache.size >= MAX_CACHE_SIZE) {
    const oldest = evictionOrder.shift();
    if (oldest) vrmAnimationCache.delete(oldest);
  }
  vrmAnimationCache.set(url, data);
  evictionOrder.push(url);
}

/**
 * Created AnimationClips are cached per URL so the animation mixer can reuse
 * the same action for repeated plays (AI emotes, dances) instead of
 * accumulating a new action every time.
 */
const clipCache = new Map<string, THREE.AnimationClip>();
const MAX_CLIP_CACHE_SIZE = 48;
const clipEvictionOrder: string[] = [];

function clipCacheGet(url: string): THREE.AnimationClip | undefined {
  return clipCache.get(url);
}

function clipCacheSet(url: string, clip: THREE.AnimationClip) {
  if (clipCache.has(url)) return;
  if (clipCache.size >= MAX_CLIP_CACHE_SIZE) {
    const oldest = clipEvictionOrder.shift();
    if (oldest) clipCache.delete(oldest);
  }
  clipCache.set(url, clip);
  clipEvictionOrder.push(url);
}

export async function loadVRMAnimation(
  url: string,
  vrm: VRM,
  options?: VRMAnimationOptions,
): Promise<THREE.AnimationClip> {
  const cacheKey = options?.lockRootMotion ? `${url}#rootlocked` : url;
  const cachedClip = clipCacheGet(cacheKey);
  if (cachedClip) return cachedClip;

  const loader = getAnimLoader();

  let vrmAnimationData = cacheGet(url);

  if (!vrmAnimationData) {
    const gltf = await loader.loadAsync(url);

    const animations = gltf.userData.vrmAnimations;
    if (!animations || animations.length === 0) {
      throw new Error(`[vrmAnimationLoader] No VRM animations found in: ${url}`);
    }
    vrmAnimationData = animations[0];
    cacheSet(url, vrmAnimationData);
  }

  const clip = createVRMAnimationClip(
    vrmAnimationData as Parameters<typeof createVRMAnimationClip>[0],
    vrm,
  );

  if (!clip) {
    throw new Error(`[vrmAnimationLoader] Failed to create AnimationClip from: ${url}`);
  }

  // Dance clips authored with root motion would walk her off-center and spin
  // her back-to-camera mid-choreography. Locking keeps her centered and
  // front-facing while preserving every joint keyframe.
  if (options?.lockRootMotion) {
    sanitizeRootMotion(clip, vrm);
  }

  // createVRMAnimationClip already targets humanoid normalized bones
  // (e.g. Normalized_J_Bip_C_Hips). Do NOT retarget to raw skinned bones —
  // vrm.humanoid.update() copies normalized → raw each frame.
  clipCacheSet(cacheKey, clip);
  return clip;
}

export interface VRMAnimationOptions {
  /**
   * Neutralize hips root motion: damp lateral travel around the clip's median
   * position and recenter dominant facing toward the camera. Used for dance
   * clips so she never wanders or shows her back mid-dance.
   */
  lockRootMotion?: boolean;
}

const _sanQ = new THREE.Quaternion();
const _sanCorr = new THREE.Quaternion();
const _sanFwd = new THREE.Vector3();
const _sanYAxis = new THREE.Vector3(0, 1, 0);
/** Residual X/Z travel kept after damping (weight shifts stay, walks go). */
const ROOT_TRAVEL_DAMP = 0.15;

function wrapPi(angle: number): number {
  return angle - Math.PI * 2 * Math.round(angle / (Math.PI * 2));
}

/**
 * Post-process a retargeted clip in place:
 *   1. Hips position track — pull X/Z toward the per-axis median so the body
 *      stays centered (Y bob untouched).
 *   2. Hips quaternion track — rotate every keyframe by -medianYaw so the
 *      dominant heading faces the camera (+Z). Internal hip motion is fully
 *      preserved; only net heading drift/spins are removed.
 */
function sanitizeRootMotion(clip: THREE.AnimationClip, vrm: VRM): void {
  const hipsName = vrm.humanoid?.getNormalizedBoneNode("hips")?.name;
  if (!hipsName) return;

  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf(".");
    if (dot < 0) continue;
    const boneName = track.name.slice(0, dot);
    const property = track.name.slice(dot + 1);
    if (boneName !== hipsName && !/hips$/i.test(boneName)) continue;

    if (property === "position") {
      const values = track.values;
      const keys = values.length / 3;
      if (keys < 2) continue;
      let medianX = 0;
      let medianZ = 0;
      for (let i = 0; i < keys; i++) {
        medianX += values[i * 3];
        medianZ += values[i * 3 + 2];
      }
      medianX /= keys;
      medianZ /= keys;
      for (let i = 0; i < keys; i++) {
        values[i * 3] = medianX + (values[i * 3] - medianX) * ROOT_TRAVEL_DAMP;
        values[i * 3 + 2] = medianZ + (values[i * 3 + 2] - medianZ) * ROOT_TRAVEL_DAMP;
      }
    } else if (property === "quaternion") {
      const values = track.values;
      const keys = values.length / 4;
      if (keys < 2) continue;
      // Unroll yaw across keyframes to avoid ±180° wraparound, take the
      // circular median as the clip's dominant facing.
      const unrolled = new Array<number>(keys);
      let prevYaw = 0;
      for (let i = 0; i < keys; i++) {
        _sanQ.fromArray(values, i * 4);
        _sanFwd.set(0, 0, 1).applyQuaternion(_sanQ);
        const yaw = Math.atan2(_sanFwd.x, _sanFwd.z);
        unrolled[i] = i === 0 ? yaw : unrolled[i - 1] + wrapPi(yaw - prevYaw);
        prevYaw = yaw;
      }
      const sorted = [...unrolled].sort((a, b) => a - b);
      const medianYaw = sorted[Math.floor(keys / 2)];
      _sanCorr.setFromAxisAngle(_sanYAxis, -medianYaw);
      for (let i = 0; i < keys; i++) {
        _sanQ.fromArray(values, i * 4);
        _sanQ.premultiply(_sanCorr);
        _sanQ.toArray(values, i * 4);
      }
    }
  }
}

export async function loadBuiltInAnimation(
  name: VRMAAnimationName,
  vrm: VRM,
): Promise<THREE.AnimationClip> {
  return loadVRMAnimation(getAnimationUrl(name), vrm);
}

export function clearAnimationCache(): void {
  vrmAnimationCache.clear();
  evictionOrder.length = 0;
  clipCache.clear();
  clipEvictionOrder.length = 0;
}

// ── Dance animation registry ───────────────────────────────
// Note: VRMA files are served as static assets from public/animations/dance/
// import.meta.glob cannot access public/ files, so we list them explicitly.

export interface AnimationEntry {
  name: string;
  url: string;
}

const DANCE_FILES: string[] = [
  "Arms Hip Hop Dance",
  "Belly Dance",
  "Bellydancing slow",
  "Booty Hip Hop Dance",
  "Dancing",
  "Dancing (1)",
  "Hip Hop Dancing",
  "Hip Hop Dancing (1)",
  "Hip Hop Dancing (2)",
  "Hip Hop Dancing (3)",
  "Hip Hop Dancing (4)",
  "Hip Hop Dancing (5)",
  "Hip Hop Dancing (6)",
  "Hip Hop Dancing (7)",
  "Hip Hop Dancing (8)",
  "Hip Hop Dancing (9)",
  "Hip Hop Dancing (10)",
  "Hip Hop Dancing (11)",
  "Hip Hop Dancing (12)",
  "Hip Hop Dancing (13)",
  "Jazz Dancing",
  "Macarena Dance",
  "Rumba Dancing",
  "Salsa Dancing",
  "Salsa Dancing (1)",
  "Samba Dancing",
  "Samba Dancing (1)",
  "Samba Dancing (2)",
  "Samba Dancing (3)",
  "Samba Dancing (4)",
  "Samba Dancing (5)",
  "Samba Dancing (6)",
  "Samba Dancing (7)",
  "Shuffling",
  "Snake Hip Hop Dance",
  "Twist Dance",
  "Ymca Dance",
];

/**
 * Encode each path segment once — spaces/parens/commas in clip filenames must
 * not be double-encoded. Shared by every animation pool below.
 */
function assetUrl(folder: string, name: string): string {
  const encoded = name
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/animations/${folder}/${encoded}.vrma`;
}

let danceCache: AnimationEntry[] | null = null;

export function getDanceAnimations(): AnimationEntry[] {
  if (danceCache) return danceCache;
  danceCache = DANCE_FILES.map((name) => ({ name, url: assetUrl("dance", name) }));
  return danceCache;
}

// ── /named/ folder animations ───────────────────────────
// All VRMA files actually present in public/animations/named/.
// The registry (animationRegistry.ts) resolves every intent against these.

const NAMED_FILES: string[] = [
  "are you Crazy Gesture",
  "Bashful",
  "Blow A Kiss",
  "Catwalk Idle To Twist R",
  "Catwalk Walk Forward HighKnees",
  "Crying",
  "Hand Raising",
  "Jog In Circle",
  "Jump",
  "Kiss",
  "Look Around",
  "Loser",
  "No",
  "Talking",
  "Thankful",
  "Thinking",
  "Threatening",
  "Unarmed Idle 01",
];

let namedCache: AnimationEntry[] | null = null;

export function getNamedAnimations(): AnimationEntry[] {
  if (namedCache) return namedCache;
  namedCache = NAMED_FILES.map((name) => ({ name, url: assetUrl("named", name) }));
  return namedCache;
}

// ── /poses/ folder animations ───────────────────────────

const POSE_FILES: string[] = [
  "Female Laying Pose (1)",
  "Female Laying Pose",
  "Female Standing Pose",
];

let poseCache: AnimationEntry[] | null = null;

export function getPoseAnimations(): AnimationEntry[] {
  if (poseCache) return poseCache;
  poseCache = POSE_FILES.map((name) => ({ name, url: assetUrl("poses", name) }));
  return poseCache;
}

// ── /imotes/ folder animations ─────────────────────────
// XSTAGE collection (gestures, poses, greetings, kpop imotes) converted
// from FBX to .vrma. Registered as metadata only — loaded lazily on demand.

const IMOTE_FILES: string[] = [
  "Bunny Ears Gesture",
  "Draw-a-Star Gesture",
  "Exit - Hand Wave to Camera",
  "Feminine - Exaggerated Hey~ 2",
  "Give Your Soul kpop dance imote",
  "HEART CRUSH_A ver kpop dance imote",
  "HEART CRUSH_B ver k pop dance imote",
  "Heart-Flutter Pose",
  "Light-stick Wave (cheer)",
  "Planet B Challenge k pop dance imote",
  "Planet B k pop dance imote",
  "Sexy - Anger2",
  "Sexy - Cold and lonely",
  "Singing - Standing Dynamically 5 (Handheld Microphone)",
  "Take Selfie",
  "Welcoming with Open Arms",
];

let imoteCache: AnimationEntry[] | null = null;

export function getImoteAnimations(): AnimationEntry[] {
  if (imoteCache) return imoteCache;
  imoteCache = IMOTE_FILES.map((name) => ({ name, url: assetUrl("imotes", name) }));
  return imoteCache;
}

// ── Unified lookup: resolve animation URL by name across all pools ──

export function resolveAnimationUrl(name: string): string | null {
  // 1. Check built-in (via getAnimationUrl)
  if ((VRMA_ANIMATIONS as readonly string[]).includes(name)) {
    return getAnimationUrl(name as VRMAAnimationName);
  }
  // 2. Check dance pool
  const dance = getDanceAnimations().find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (dance) return dance.url;
  // 3. Check named pool
  const named = getNamedAnimations().find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (named) return named.url;
  // 4. Check pose pool
  const pose = getPoseAnimations().find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (pose) return pose.url;
  // 5. Check imotes pool (XSTAGE gestures / poses / kpop imotes)
  const imote = getImoteAnimations().find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (imote) return imote.url;
  // 6. Treat as raw path
  return name.endsWith(".vrma") ? name : null;
}
