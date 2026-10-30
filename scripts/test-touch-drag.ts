/**
 * Touch-drag unit tests — pure logic, no WebGL.
 *
 * Covers:
 *   1. dragChainsAt — the shared clamped spring force field (radius falloff,
 *      force clamp, direction toward the pointer target, root untouched).
 *   2. TouchDragController — camera-plane projection, displacement clamp,
 *      borrowed-view identity (no per-frame allocation), cancel/end.
 *   3. findDragChainAt — head-pat exclusion, bone ancestry, skinned-mesh
 *      skeleton evidence, occlusion-tested nearest secondary bone, and the
 *      null result that leaves the camera orbit undisturbed.
 *
 * Run:
 *   npx esbuild scripts/test-touch-drag.ts --bundle --format=esm \
 *     --platform=node --outfile=.tmp.mjs --log-level=warning && node .tmp.mjs
 */

import * as THREE from "three";
import { dragChainsAt, PhysicsBone, PhysicsBoneChain } from "../src/waifu/physics/PhysicsBone";
import { TouchDragController } from "../src/waifu/touchDrag";
import { findDragChainAt, type TouchAnchors, type TouchZoneConfig } from "../src/waifu/touchZones";
import { PHYSICS_CONFIG } from "../src/waifu/physicsConfig";

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

const ZERO = new THREE.Vector3();
const CFG: TouchZoneConfig = PHYSICS_CONFIG.touch;

// ── Fixtures ────────────────────────────────────────────────

function makeCamera(
  x: number,
  y: number,
  z: number,
  target: THREE.Vector3,
): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(28, 1.6, 0.1, 50);
  cam.position.set(x, y, z);
  cam.lookAt(target);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

/** Place a node at a world position (anchored at the scene root). */
function place(x: number, y: number, z: number): THREE.Object3D {
  const node = new THREE.Object3D();
  node.position.set(x, y, z);
  node.updateMatrixWorld(true);
  return node;
}

function makeAnchors(over: Partial<TouchAnchors> = {}): TouchAnchors {
  const anchors: TouchAnchors = {
    head: place(0, 1.5, 0),
    neck: place(0, 1.35, 0),
    handL: place(-0.5, 1.2, 0.3),
    handR: place(0.5, 1.2, 0.3),
    categories: new Set<string>(),
    classified: [],
    boneCategory: new Map(),
    ...over,
  };
  return anchors;
}

/**
 * Build a PhysicsBoneChain whose PhysicsBone positions are set explicitly —
 * dragChainsAt reads `bone.position`, not the bone object transforms.
 * All tuning is zeroed so a bone's Δposition after `simulate(1, 0, 0)` is
 * exactly the applied force (accel × dt with dt = 1, mass = 1).
 */
function makeChain(positions: [number, number, number][]): {
  chain: PhysicsBoneChain;
  bones: PhysicsBone[];
} {
  const container = new THREE.Object3D();
  const rootObj = new THREE.Object3D();
  container.add(rootObj);
  container.updateMatrixWorld(true);

  const bones: PhysicsBone[] = [];
  let prev: PhysicsBone | null = null;
  // Flat object hierarchy (all under container) so obj.position IS the world
  // position; the chain order lives in the parentBone links, which is all
  // bone.simulate / dragChainsAt need.
  for (const p of positions) {
    const obj = new THREE.Object3D();
    container.add(obj);
    obj.position.set(p[0], p[1], p[2]);
    container.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
    const parentWorld = new THREE.Vector3().setFromMatrixPosition(rootObj.matrixWorld);
    const restOffset = new THREE.Vector3().subVectors(worldPos, parentWorld);
    const pb = new PhysicsBone(obj, prev, worldPos, restOffset);
    // Zero every natural force so the drag spring is the only accelerant.
    pb.stiffness = 0;
    pb.gravityInfluence = 0;
    pb.airResistance = 0;
    pb.damping = 0;
    bones.push(pb);
    prev = pb;
  }
  return { chain: new PhysicsBoneChain(bones), bones };
}

// ── 1. dragChainsAt ─────────────────────────────────────────

section("dragChainsAt — clamped spring force field");

{
  // Anchor at origin; target one metre up. Radius 0.3.
  const { chain, bones } = makeChain([
    [0, 0, 0], // root (never touched)
    [0.05, 0, 0], // near — dist 0.05, falloff 0.833
    [0.2, 0, 0], // near — dist 0.2, falloff 0.333
    [0.5, 0, 0], // far — outside radius
  ]);
  const target = new THREE.Vector3(0, 1, 0);
  const anchor = new THREE.Vector3(0, 0, 0);

  dragChainsAt([chain], target, anchor, 0.3, 10, 5);
  const world = bones.map((b) => b.position.clone());
  for (const b of bones) b.simulate(1, ZERO, ZERO);

  const moved = (b: PhysicsBone) => b.position.clone().sub(b.previous);
  const near = moved(bones[1]);
  const mid = moved(bones[2]);
  const far = moved(bones[3]);

  check("root bone receives no force", moved(bones[0]).length() === 0);
  check("bone beyond radius receives no force", far.length() === 0, `Δ=${far.length()}`);
  // Expected force = |target − pos| · strength · (1 − dist/radius), clamped.
  const expectedForce = (i: number) => {
    const dist = world[i].distanceTo(anchor);
    const raw = world[i].distanceTo(target) * 10 * (1 - dist / 0.3);
    return Math.min(raw, 5);
  };
  check(
    "near-bone force clamped to maxForce",
    Math.abs(near.length() - expectedForce(1)) < 1e-6,
    `|Δ|=${near.length()} expected ${expectedForce(1)}`,
  );
  check(
    "unclamped far bone scales with falloff",
    Math.abs(mid.length() - expectedForce(2)) < 1e-6,
    `|Δ|=${mid.length()} expected ${expectedForce(2)}`,
  );
  check(
    "force points toward the pointer target",
    near.clone().normalize().dot(target.clone().sub(world[1]).normalize()) > 0.999 &&
      mid.clone().normalize().dot(target.clone().sub(world[2]).normalize()) > 0.999,
  );
}

// ── 2. TouchDragController ──────────────────────────────────

section("TouchDragController — plane projection, clamp, borrowed view");

{
  const cam = makeCamera(0, 1.4, 3, new THREE.Vector3(0, 1.0, 0));
  let camera: THREE.Camera | null = null;
  const ctrl = new TouchDragController(() => camera);
  camera = cam;

  const grab = new THREE.Vector3(0, 1.0, 0);
  ctrl.begin(grab, "hair");
  check("begin activates the drag", ctrl.active && ctrl.category === "hair");

  const view = ctrl.view();
  check("view() returns a state while active", view !== null);
  check("borrowed view is the controller (no copies)", view === (ctrl as unknown));
  const sameRef = ctrl.view();
  ctrl.movePointer(0.2, 0.1);
  check("view() identity is stable across moves (alloc-free)", ctrl.view() === sameRef);

  // Target must stay on the camera-facing plane through the grab point.
  const planeNormal = cam.position.clone().sub(grab).normalize();
  const planeDist = ctrl.target!.clone().sub(grab).dot(planeNormal);
  check("target stays on the drag plane", Math.abs(planeDist) < 1e-5, `dist=${planeDist}`);

  // Extreme pointer → displacement clamped.
  ctrl.movePointer(80, 80);
  const wander = ctrl.target.distanceTo(grab);
  check(
    "target displacement clamped to maxDisplacement",
    wander <= PHYSICS_CONFIG.drag.maxDisplacement + 1e-6,
    `wander=${wander}`,
  );

  ctrl.end();
  check("end() deactivates and view() goes null", !ctrl.active && ctrl.view() === null);
  const t = ctrl.target.clone();
  ctrl.movePointer(0.5, 0.5);
  check("movePointer is a no-op when inactive", ctrl.target.equals(t));

  ctrl.begin(new THREE.Vector3(0, 0.8, 0), "tail");
  ctrl.cancel();
  check("cancel() deactivates the drag", !ctrl.active && ctrl.view() === null);

  // No camera → begin/move degrade gracefully instead of throwing.
  camera = null;
  ctrl.begin(grab, "cloth");
  ctrl.movePointer(0.3, 0.3);
  check("no camera: state stays consistent", ctrl.active && ctrl.target.distanceTo(grab) < 1e-9);
}

// ── 3. findDragChainAt ──────────────────────────────────────

section("findDragChainAt — grab decision");

{
  const hairBone = place(0.18, 1.3, 0.12); // sidelock, below the head anchor
  const tailBone = place(0, 0.9, -0.3); // roots behind the torso
  const clothBone = place(0, 0.7, 0.1); // skirt panel
  const anchors = makeAnchors({
    classified: [
      { object: hairBone, category: "hair" },
      { object: tailBone, category: "tail" },
      { object: clothBone, category: "cloth" },
    ],
    boneCategory: new Map([
      [hairBone, "hair"],
      [tailBone, "tail"],
      [clothBone, "cloth"],
    ]),
    categories: new Set(["hair", "tail", "cloth"]),
  });

  // Head-pat zones win over grabs.
  const headHit = findDragChainAt(
    {
      hitObject: null,
      point: new THREE.Vector3(0.1, 1.4, 0.08),
      normal: new THREE.Vector3(0, 0, 1),
      camera: null,
    },
    anchors,
    CFG,
  );
  check("hit inside the head radius is NOT a grab (pat zone)", headHit === null);

  // Ancestry: the hit object descends from a classified hair bone.
  const strand = new THREE.Object3D();
  hairBone.add(strand);
  strand.updateMatrixWorld(true);
  const ancestryHit = findDragChainAt(
    {
      hitObject: strand,
      point: hairBone.position.clone(),
      normal: new THREE.Vector3(0, 0, 1),
      camera: null,
    },
    anchors,
    CFG,
  );
  check("ancestry to a classified bone returns its family", ancestryHit === "hair");

  // Humanoid ancestry is never a grab.
  const humanoidChild = new THREE.Object3D();
  anchors.head!.add(humanoidChild);
  humanoidChild.updateMatrixWorld(true);
  const humanoidHit = findDragChainAt(
    {
      hitObject: humanoidChild,
      point: new THREE.Vector3(0, 1.1, 0.1), // below the head radius
      normal: new THREE.Vector3(0, 0, 1),
      camera: null,
    },
    anchors,
    CFG,
  );
  check("humanoid ancestry is not grabbable", humanoidHit === null);

  // Nearest visible secondary: plain-object hit near the tail, camera behind.
  const camBehind = makeCamera(0, 1.2, -3, new THREE.Vector3(0, 1.0, 0));
  const tailHit = findDragChainAt(
    {
      hitObject: new THREE.Object3D(),
      point: tailBone.position.clone(),
      normal: new THREE.Vector3(0, 0, -1),
      camera: camBehind,
    },
    anchors,
    CFG,
  );
  check("plain-object hit near the tail grabs the tail", tailHit === "tail");

  // Occlusion: same tail bone, hit on the front torso — bone is behind the
  // hit surface from the camera's viewpoint, so the press is NOT a grab.
  const camFront = makeCamera(0, 1.2, 3, new THREE.Vector3(0, 1.0, 0));
  const occludedHit = findDragChainAt(
    {
      hitObject: new THREE.Object3D(),
      point: new THREE.Vector3(0, 0.9, -0.05),
      normal: new THREE.Vector3(0, 0, 1),
      camera: camFront,
    },
    anchors,
    CFG,
  );
  check("occluded tail bone cannot claim a front-torso hit", occludedHit === null);

  // Cloth grab near the skirt bone.
  const clothHit = findDragChainAt(
    {
      hitObject: new THREE.Object3D(),
      point: clothBone.position.clone(),
      normal: new THREE.Vector3(0, 0, 1),
      camera: camFront,
    },
    anchors,
    CFG,
  );
  check("plain-object hit near the skirt grabs cloth", clothHit === "cloth");

  // Nothing grabbable → null (orbit proceeds undisturbed).
  const nothingHit = findDragChainAt(
    {
      hitObject: new THREE.Object3D(),
      point: new THREE.Vector3(0, 1.0, 0.15),
      normal: new THREE.Vector3(0, 0, 1),
      camera: camFront,
    },
    anchors,
    CFG,
  );
  check("torso hit far from any chain returns null", nothingHit === null);

  // Skinned-mesh evidence: a dedicated Hair mesh skinned by hair bones.
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry());
  mesh.skeleton = new THREE.Skeleton([hairBone, strand]);
  const meshHit = findDragChainAt(
    {
      hitObject: mesh,
      point: hairBone.position.clone(),
      normal: new THREE.Vector3(0, 0, 1),
      camera: null,
    },
    anchors,
    CFG,
  );
  check("skinned-mesh skeleton evidence returns the family", meshHit === "hair");
}

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
