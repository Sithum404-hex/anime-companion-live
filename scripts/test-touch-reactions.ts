/**
 * Touch-reaction unit tests — pure logic, no WebGL.
 *
 * Covers:
 *   1. classifyTouchZone — bone-ancestry priority, humanoid anchor proximity,
 *      face refinement by surface normal, height fallback.
 *   2. TouchReactionController — per-zone debouncing, the global floor,
 *      dance gating, and the lean/recoil envelope lifecycle.
 *
 * Run:
 *   npx esbuild scripts/test-touch-reactions.ts --bundle --format=esm \
 *     --platform=node --outfile=.tmp.mjs --log-level=warning && node .tmp.mjs
 */

import * as THREE from "three";
import {
  classifyTouchZone,
  type TouchAnchors,
  type TouchZoneConfig,
} from "../src/waifu/touchZones";
import {
  TouchReactionController,
  type TouchReactionDeps,
} from "../src/waifu/TouchReactionController";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ── Fixtures ────────────────────────────────────────────────

const CFG: TouchZoneConfig = {
  probeRadius: 0.24,
  radiusScale: { head: 1, hands: 1, body: 0.7 },
  faceNormalDot: 0.35,
};

function makeAnchors(over: Partial<TouchAnchors> = {}): TouchAnchors {
  const anchors: TouchAnchors = {
    head: new THREE.Object3D(),
    neck: new THREE.Object3D(),
    handL: new THREE.Object3D(),
    handR: new THREE.Object3D(),
    categories: new Set<string>(),
    classified: [],
    boneCategory: new Map(),
    ...over,
  };
  // Pose the rig like the real one: head 1.5, neck 1.35, hands out to the sides.
  // Overridden (null) anchors are skipped, not posed.
  const pose = (node: THREE.Object3D | null, x: number, y: number, z: number) => {
    if (!node) return;
    node.position.set(x, y, z);
    node.updateMatrixWorld(true);
    node.updateWorldMatrix(true, false);
  };
  pose(anchors.head, 0, 1.5, 0);
  pose(anchors.neck, 0, 1.35, 0);
  pose(anchors.handL, -0.5, 1.2, 0.3);
  pose(anchors.handR, 0.5, 1.2, 0.3);
  return anchors;
}

/** Place an anchor in the world and return its world position. */
function place(node: THREE.Object3D, x: number, y: number, z: number): THREE.Vector3 {
  node.position.set(x, y, z);
  node.updateMatrixWorld(true);
  node.updateWorldMatrix(true, false);
  return new THREE.Vector3(x, y, z);
}

const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 1.4, 2.6); // front, slightly above — like the default rig

// ── 1. Zone classification ──────────────────────────────────

section("1. classifyTouchZone");

{
  // A hair chain bone wins by ancestry regardless of where it is.
  const anchors = makeAnchors();
  const hairBone = new THREE.Object3D();
  hairBone.name = "J_Sec_Hair1_01";
  const mesh = new THREE.Object3D();
  mesh.parent = hairBone;
  anchors.classified.push({ object: hairBone, category: "hair" });
  const p = place(anchors.head, 0, 1.6, 0); // hair sits nowhere near the head
  const zone = classifyTouchZone(
    { hitObject: mesh, point: p, normal: new THREE.Vector3(0, 0, 1), camera },
    anchors,
    CFG,
  );
  check("a hit on a hair-chain descendant classifies as hair", zone === "hair");
}

{
  const anchors = makeAnchors();
  const tailBone = new THREE.Object3D();
  tailBone.name = "J_Sec_Tail01";
  anchors.classified.push({ object: tailBone, category: "tail" });
  const zone = classifyTouchZone(
    {
      hitObject: tailBone,
      point: new THREE.Vector3(0, 1.0, -0.3),
      normal: new THREE.Vector3(0, 0, 1),
      camera,
    },
    anchors,
    CFG,
  );
  check("a hit on a tail bone classifies as hair (impulse-only zone)", zone === "hair");
}

{
  // Cloth ancestry → body, even above the neck (a hood).
  const anchors = makeAnchors();
  const clothBone = new THREE.Object3D();
  clothBone.name = "J_Sec_Skirt01";
  anchors.classified.push({ object: clothBone, category: "cloth" });
  const zone = classifyTouchZone(
    {
      hitObject: clothBone,
      point: new THREE.Vector3(0, 1.7, 0),
      normal: new THREE.Vector3(0, 0, 1),
      camera,
    },
    anchors,
    CFG,
  );
  check("a hit on a cloth-chain bone classifies as body", zone === "body");
}

{
  // Head anchor proximity, normal facing the camera → face.
  const anchors = makeAnchors();
  const head = place(anchors.head, 0, 1.5, 0);
  const zone = classifyTouchZone(
    {
      hitObject: null,
      point: head.clone().add(new THREE.Vector3(0, 0.02, 0.1)), // front of head
      normal: new THREE.Vector3(0, 0, 1), // faces +Z → camera
      camera,
    },
    anchors,
    CFG,
  );
  check("front-of-head hit with camera-facing normal refines to face", zone === "face");
}

{
  // Crown hit (normal up, camera in front) stays head.
  const anchors = makeAnchors();
  const head = place(anchors.head, 0, 1.5, 0);
  const zone = classifyTouchZone(
    {
      hitObject: null,
      point: head.clone().add(new THREE.Vector3(0, 0.12, 0)),
      normal: new THREE.Vector3(0, 1, 0),
      camera,
    },
    anchors,
    CFG,
  );
  check("a crown hit (upward normal) stays head", zone === "head");
}

{
  // Nearest anchor wins: point between head and hand, closer to hand.
  const anchors = makeAnchors();
  const head = place(anchors.head, 0, 1.5, 0);
  const hand = place(anchors.handR, 0.5, 1.2, 0.3);
  const zone = classifyTouchZone(
    {
      hitObject: null,
      point: hand.clone().lerp(new THREE.Vector3(0, 0, 0), 0.15),
      normal: new THREE.Vector3(0, 0, 1),
      camera,
    },
    anchors,
    CFG,
  );
  check("a hit nearer the hand than the head classifies as hands", zone === "hands");
  void head;
}

{
  // Height fallback: above the neck with no anchor in range → head.
  const anchors = makeAnchors({ head: null });
  place(anchors.neck, 0, 1.35, 0);
  const zone = classifyTouchZone(
    {
      hitObject: null,
      point: new THREE.Vector3(2, 1.6, 2), // far away, above neck height
      normal: new THREE.Vector3(0, 0, 1),
      camera,
    },
    anchors,
    CFG,
  );
  check("above-neck height fallback yields head", zone === "head");
}

{
  // Everything else → body.
  const anchors = makeAnchors();
  place(anchors.neck, 0, 1.35, 0);
  const zone = classifyTouchZone(
    {
      hitObject: null,
      point: new THREE.Vector3(0, 1.0, 0.1),
      normal: new THREE.Vector3(0, 0, 1),
      camera,
    },
    anchors,
    CFG,
  );
  check("a torso-level hit with no anchor in range falls back to body", zone === "body");
}

// ── 2. Controller: debounce, gating, envelopes ─────────────

section("2. TouchReactionController");

/** Build a controller with recording deps and a controllable clock. */
function makeController(opts: { dancing?: boolean; speaking?: boolean } = {}) {
  let simNow = 10_000; // start off the zero axis so nothing is time-ambiguous
  const calls = {
    emotions: [] as { emotion: string; intensity: number; duration: number }[],
    eyesClosed: 0,
    gestures: 0,
    impulses: [] as { scale: number }[],
    hearts: 0,
  };
  const deps: TouchReactionDeps = {
    queueEmotion: (emotion, intensity, duration) =>
      calls.emotions.push({ emotion, intensity, duration }),
    forceEyesClosed: () => {
      calls.eyesClosed++;
    },
    playGesture: () => {
      calls.gestures++;
    },
    impulseAt: (_p, scale) => calls.impulses.push({ scale }),
    isDancing: () => opts.dancing ?? false,
    isSpeaking: () => opts.speaking ?? false,
  };
  const c = new TouchReactionController(
    deps,
    () => camera,
    makeAnchors(),
    () => simNow,
  );
  c.onHeartBurst = () => {
    calls.hearts++;
  };
  return {
    c,
    calls,
    advance: (ms: number) => {
      simNow += ms;
    },
  };
}

const headPoint = new THREE.Vector3(0.05, 1.55, 0.05);
const headNormal = new THREE.Vector3(0, 1, 0);

{
  const { c, calls } = makeController();
  c.onTouch(null, headPoint, headNormal);
  check(
    "first head touch fires the happy overlay",
    calls.emotions.some((e) => e.emotion === "happy"),
  );
  check("head touch closes the eyes once", calls.eyesClosed === 1);
  check("head touch fires one heart burst", calls.hearts === 1);
  check("head touch pushes physics once", calls.impulses.length === 1);
}

{
  const { c, calls } = makeController();
  const handPoint = new THREE.Vector3(0.5, 1.2, 0.3);
  const handNormal = new THREE.Vector3(0, 0, 1);
  c.onTouch(null, handPoint, handNormal);
  c.onTouch(null, handPoint, handNormal); // immediate repeat
  check("an immediate repeat is debounced (one gesture total)", calls.gestures === 1);
  check("physics still fires on the debounced touch", calls.impulses.length === 2);
}

{
  // Mashing one spot must never machine-gun overlays.
  const { c, calls } = makeController();
  for (let i = 0; i < 20; i++) c.onTouch(null, headPoint, headNormal);
  const happy = calls.emotions.filter((e) => e.emotion === "happy").length;
  check("20 rapid head touches yield exactly one happy overlay", happy === 1, `got ${happy}`);
  check(
    "20 rapid touches yield exactly one heart burst",
    calls.hearts === 1,
    `got ${calls.hearts}`,
  );
}

{
  const { c, calls } = makeController({ dancing: true });
  c.onTouch(null, headPoint, headNormal);
  check(
    "while dancing: no expressions, no hearts, no impulses",
    calls.emotions.length === 0 && calls.hearts === 0 && calls.impulses.length === 0,
  );
}

{
  // Zone cooldowns are independent, but the global floor still applies: a face
  // touch 100 ms after a head pat is swallowed by the floor (anti-spam by
  // design), while one after the floor has passed fires.
  const facePoint = new THREE.Vector3(0, 1.52, 0.12);
  const faceNormal = new THREE.Vector3(0, 0, 1);
  const { c, calls } = makeController();
  c.onTouch(null, headPoint, headNormal); // head (crown normal) — t≈0
  c.onTouch(null, facePoint, faceNormal); // face — inside the global floor
  check(
    "the global floor swallows a different-zone touch 0 ms later",
    !calls.emotions.some((e) => e.emotion === "embarrassed"),
  );
  const { c: c2, calls: calls2, advance } = makeController();
  c2.onTouch(null, headPoint, headNormal);
  advance(1_000); // > globalCooldownMs (450 ms)
  c2.onTouch(null, facePoint, faceNormal);
  check(
    "a different zone fires once the global floor has passed",
    calls2.emotions.some((e) => e.emotion === "embarrassed"),
  );
}

{
  const { c, calls } = makeController({ speaking: true });
  const facePoint = new THREE.Vector3(0, 1.52, 0.12);
  c.onTouch(null, facePoint, new THREE.Vector3(0, 0, 1));
  const blush = calls.emotions.find((e) => e.emotion === "embarrassed");
  check("while speaking, the face overlay is softened", !!blush && blush.intensity < 0.7);
}

{
  // Envelope lifecycle: rise → hold → fall → zero.
  const { c } = makeController();
  c.onTouch(null, headPoint, headNormal);
  let peak = 0;
  let settled = 0;
  for (let i = 0; i < 200; i++) {
    const { headZ } = c.update(1 / 60);
    peak = Math.max(peak, Math.abs(headZ));
    settled = headZ;
  }
  check("the lean envelope rises to a visible peak", peak > 0.05, `peak ${peak.toFixed(3)}`);
  check("the lean envelope settles back to zero", settled === 0, `final ${settled}`);
}

{
  // Recoil envelope for face touches.
  const { c } = makeController();
  c.onTouch(null, new THREE.Vector3(0, 1.52, 0.12), new THREE.Vector3(0, 0, 1));
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    const { torsoX } = c.update(1 / 60);
    peak = Math.max(peak, Math.abs(torsoX));
  }
  check(
    "the recoil envelope peaks below the lean envelope",
    peak > 0.01 && peak < 0.15,
    `peak ${peak.toFixed(3)}`,
  );
}

{
  // Reset clears everything.
  const { c } = makeController();
  c.onTouch(null, headPoint, headNormal);
  c.update(0.05);
  c.reset();
  const { headZ } = c.update(1 / 60);
  check("reset zeroes the envelope immediately", headZ === 0);
}

{
  // Sign of the lean follows the touched side.
  const { c } = makeController();
  c.onTouch(null, new THREE.Vector3(0.3, 1.55, 0), headNormal);
  let firstZ = 0;
  for (let i = 0; i < 20; i++) {
    const { headZ } = c.update(1 / 60);
    if (headZ !== 0 && firstZ === 0) firstZ = headZ;
  }
  check("a right-side pat leans right (positive headZ)", firstZ > 0, `first ${firstZ.toFixed(4)}`);
}

{
  // A hair-mesh hit at crown height is still a head pat (most VRMs cover the
  // head with a Hair skinned mesh), while a hit on a hanging strand is not.
  const { c, calls, advance } = makeController();
  const crownHairPoint = new THREE.Vector3(0.05, 1.48, 0.05); // ≈ head anchor 1.5
  c.onTouch(null, crownHairPoint, headNormal);
  check(
    "a hair-mesh hit at crown height fires the head-pat reactions",
    calls.emotions.some((e) => e.emotion === "happy") &&
      calls.hearts === 1 &&
      calls.eyesClosed === 1,
  );
  advance(10_000);
  const { c: c2, calls: calls2 } = makeController();
  const strandPoint = new THREE.Vector3(0.4, 1.1, 0.1); // well below the crown
  c2.onTouch(null, strandPoint, headNormal);
  check(
    "a low hair hit gives only the impulse (no pat)",
    calls2.emotions.length === 0 && calls2.hearts === 0 && calls2.impulses.length === 1,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
