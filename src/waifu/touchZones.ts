/**
 * Touch-zone classification for pointer hits on the character.
 *
 * Pure and DOM-free so the zone logic is unit-testable without a WebGL
 * context. The signals used are exactly the ones the task names:
 *
 *   • hit bone names  — via BoneClassifier's existing categories, so no new
 *     per-VRM name vocabulary is invented here;
 *   • hit location    — world-space distance to humanoid anchors;
 *   • surface normal  — a head hit whose normal faces the camera is the face;
 *   • world position  — head height (above neck) distinguishes hair-touch
 *     from head-touch when no classified chain is nearby.
 *
 * Everything is approximate on purpose: zones steer *reactions*, not hitboxes.
 */

import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { VRMHumanBoneName } from "@pixiv/three-vrm";
import { BoneClassifier } from "./physics/BoneClassifier";

export type TouchZone = "head" | "face" | "hands" | "hair" | "body";

/** Normalised hit description the classifier consumes. */
export interface TouchHit {
  /** The exact object the ray hit (mesh or bone). */
  hitObject: THREE.Object3D | null;
  /** World-space hit point. */
  point: THREE.Vector3;
  /** World-space surface normal at the hit. */
  normal: THREE.Vector3;
  /** Active camera, for the face test (normal → camera). May be null. */
  camera: THREE.Camera | null;
}

/** Humanoid anchors resolved once per model. */
export interface TouchAnchors {
  head: THREE.Object3D | null;
  neck: THREE.Object3D | null;
  handL: THREE.Object3D | null;
  handR: THREE.Object3D | null;
  /** Categories (from BoneClassifier) present on this model, e.g. "hair". */
  categories: Set<string>;
  /** Classified bones whose ancestry is checked first. */
  classified: { object: THREE.Object3D; category: string }[];
  /** Classified bone → category, for skinned-mesh evidence lookup. */
  boneCategory: Map<THREE.Object3D, string>;
}

/** Config slice — mirrors PHYSICS_CONFIG.touch (kept structural for tests). */
export interface TouchZoneConfig {
  probeRadius: number;
  radiusScale: { head: number; hands: number; body: number };
  faceNormalDot: number;
}

/** Reusable scratch — classify() runs at most once per pointer event. */
const scratchPos = new THREE.Vector3();
const scratchDir = new THREE.Vector3();
const headPos = new THREE.Vector3();
const tmpVec = new THREE.Vector3();

/**
 * Secondary chains (hair strands, tails) are thin structures, not volumes —
 * a full probeRadius bubble around them would swallow the whole torso they
 * drape beside. They only claim hits well inside the body-probe radius.
 */
const SECONDARY_RADIUS_SCALE = 0.6;

/**
 * Nearest visible classified secondary bone (hair/tail/ear/cloth) to `point`.
 *
 * Real raycasts hit SkinnedMesh objects whose parent chain never reaches a
 * bone, and hair strands can hang outside every humanoid anchor radius. The
 * classified bone list (same BoneClassifier data the physics uses) gives a
 * model-agnostic answer: which secondary chain does the camera see here?
 *
 * Merged-mesh exports skin one Body mesh with the whole skeleton, and chains
 * like a fox tail root near chest height *behind* the torso — so a proximity
 * test alone would misread chest taps. The camera-side occlusion test fixes
 * that: a bone only claims the hit if it is not occluded by the surface that
 * was actually hit. Shared by classifyTouchZone and findDragChainAt.
 */
function nearestVisibleSecondary(
  point: THREE.Vector3,
  camera: THREE.Camera | null,
  anchors: TouchAnchors,
  cfg: TouchZoneConfig,
): { category: string; d2: number } | null {
  if (anchors.classified.length === 0) return null;
  let best: { category: string; d2: number } | null = null;
  if (camera) {
    scratchDir.copy(camera.position).sub(point).normalize();
  }
  for (const cb of anchors.classified) {
    if (
      cb.category !== "hair" &&
      cb.category !== "tail" &&
      cb.category !== "ear" &&
      cb.category !== "cloth"
    ) {
      continue;
    }
    cb.object.updateWorldMatrix(true, false);
    scratchPos.setFromMatrixPosition(cb.object.matrixWorld);
    if (camera) {
      // Occlusion test: bone visibly behind the hit surface → not this hit.
      tmpVec.copy(scratchPos).sub(point);
      if (tmpVec.dot(scratchDir) < -0.05) continue;
    }
    const d2 = point.distanceToSquared(scratchPos);
    const r2 = cfg.probeRadius * SECONDARY_RADIUS_SCALE;
    if (d2 <= r2 * r2 && (!best || d2 < best.d2)) {
      best = { category: cb.category, d2 };
    }
  }
  return best;
}

/**
 * Resolve the humanoid anchors + classified bone list for a model.
 *
 * Uses the existing BoneClassifier for chain categories — no new name
 * vocabulary — and the VRM humanoid API for anchors, exactly like
 * BodyColliders does. Null-safe: a model with no humanoid or no secondary
 * chains still yields a working (if coarser) classifier.
 */
export function resolveTouchAnchors(vrm: VRM): TouchAnchors {
  const anchors: TouchAnchors = {
    head: null,
    neck: null,
    handL: null,
    handR: null,
    categories: new Set<string>(),
    classified: [],
    boneCategory: new Map(),
  };

  try {
    const hum = vrm.humanoid;
    if (hum) {
      const get = (n: VRMHumanBoneName) => hum.getNormalizedBoneNode(n) ?? null;
      anchors.head = get(VRMHumanBoneName.Head);
      anchors.neck = get(VRMHumanBoneName.Neck);
      anchors.handL = get(VRMHumanBoneName.LeftHand);
      anchors.handR = get(VRMHumanBoneName.RightHand);
    }
  } catch {
    // humanoid absent — zones degrade to body/hair only
  }

  // Reuse BoneClassifier's categories rather than inventing new ones.
  try {
    const classifier = new BoneClassifier(vrm);
    for (const cb of classifier.classified) {
      anchors.classified.push({ object: cb.bone, category: cb.category });
      anchors.categories.add(cb.category);
      anchors.boneCategory.set(cb.bone, cb.category);
    }
  } catch {
    // classifier unavailable — ancestry matching simply never wins
  }

  return anchors;
}

/**
 * Classify one hit into a reaction zone.
 *
 * @returns one of "head" | "face" | "hands" | "hair" | "body".
 */
export function classifyTouchZone(
  hit: TouchHit,
  anchors: TouchAnchors,
  cfg: TouchZoneConfig,
): TouchZone {
  const { point, normal, camera, hitObject } = hit;

  // ── 1. Classified-bone ancestry: hair / tail / ear / cloth ──
  if (hitObject) {
    for (let o: THREE.Object3D | null = hitObject; o; o = o.parent) {
      const match = anchors.classified.find((c) => c.object === o);
      if (match) {
        if (match.category === "hair" || match.category === "tail" || match.category === "ear") {
          return "hair";
        }
        if (match.category === "cloth") {
          return "body";
        }
        break; // accessory / unknown: fall through to anchor proximity
      }
    }
  }

  // ── 1.5 Skinned-mesh evidence: whose surface did the ray physically hit? ──
  // Secondary chains usually get their own SkinnedMesh, and the mesh's
  // skeleton names exactly which bones skin it. If the hit mesh carries any
  // classified secondary bones, the majority category is the zone — this
  // correctly rejects taps on the torso even when a tail bone sits close by.
  const skinned = hitObject as THREE.SkinnedMesh | null;
  if (skinned?.isSkinnedMesh === true && anchors.boneCategory.size > 0) {
    const bones = skinned.skeleton?.bones;
    if (bones?.length) {
      const counts = new Map<string, number>();
      for (const b of bones) {
        const cat = anchors.boneCategory.get(b);
        if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }
      let top: { cat: string; n: number } | null = null;
      for (const [cat, n] of counts) if (!top || n > top.n) top = { cat, n };
      if (top) return top.cat === "cloth" ? "body" : "hair";
    }
  }

  // ── 2. Nearest humanoid anchor within its probe radius ──
  const candidates = [
    { zone: "head" as TouchZone, node: anchors.head, scale: cfg.radiusScale.head },
    { zone: "hands" as TouchZone, node: anchors.handL, scale: cfg.radiusScale.hands },
    { zone: "hands" as TouchZone, node: anchors.handR, scale: cfg.radiusScale.hands },
    { zone: "body" as TouchZone, node: anchors.neck, scale: cfg.radiusScale.body },
  ];

  let best: { zone: TouchZone; d2: number } | null = null;
  for (const c of candidates) {
    if (!c.node) continue;
    c.node.updateWorldMatrix(true, false);
    scratchPos.setFromMatrixPosition(c.node.matrixWorld);
    const r = cfg.probeRadius * c.scale;
    const d2 = point.distanceToSquared(scratchPos);
    if (d2 <= r * r && (!best || d2 < best.d2)) {
      best = { zone: c.zone, d2 };
    }
  }

  if (best) {
    if (best.zone === "head" && anchors.head && camera) {
      // Refine head → face: the surface normal must face the camera and the
      // hit must sit at/above the head anchor's height (front of the skull,
      // not the crown or the hair behind it).
      anchors.head.updateWorldMatrix(true, false);
      headPos.setFromMatrixPosition(anchors.head.matrixWorld);
      scratchDir.copy(camera.position).sub(point).normalize();
      if (normal.dot(scratchDir) >= cfg.faceNormalDot && point.y >= headPos.y - 0.02) {
        return "face";
      }
    }
    return best.zone;
  }

  // ── 2.5 Nearest visible secondary bone (skinned meshes carry no ancestry) ──
  // Same evidence the drag classifier uses; see nearestVisibleSecondary for
  // why ancestry and anchors alone cannot answer this for merged meshes.
  const secondary = nearestVisibleSecondary(point, camera, anchors, cfg);
  if (secondary) return secondary.category === "cloth" ? "body" : "hair";

  // ── 3. Fallback by height (world Y vs neck) ──
  if (anchors.neck) {
    anchors.neck.updateWorldMatrix(true, false);
    scratchPos.setFromMatrixPosition(anchors.neck.matrixWorld);
    if (point.y > scratchPos.y) return "head";
  }
  return "body";
}

/** Chain families that can be grabbed and dragged (all secondary chains). */
export type DragCategory = "hair" | "tail" | "ear" | "accessory" | "cloth";

const DRAG_CATEGORIES = new Set<string>(["hair", "tail", "ear", "accessory", "cloth"]);

/**
 * Decide whether a pointer-down hit starts a character drag, and which chain
 * family it grabbed. Uses the same evidence passes as classifyTouchZone —
 * bone ancestry, skinned-mesh skeleton, nearest visible secondary bone — but
 * asks a different question: "which secondary chain family did the finger
 * land on?" (versus "which reaction zone?").
 *
 * Hits inside the head-anchor radius are deliberately NOT draggable: the
 * crown is a head-pat zone (hearts / closed eyes), and grabbing what a pat
 * should touch would feel wrong. Returns null when the press is not a grab,
 * which lets the camera orbit proceed undisturbed.
 */
export function findDragChainAt(
  hit: TouchHit,
  anchors: TouchAnchors,
  cfg: TouchZoneConfig,
): DragCategory | null {
  const { point, hitObject, camera } = hit;

  // Head-pat zones win over grabs: within the head anchor's probe radius the
  // press is a pat, whatever mesh was actually hit.
  if (anchors.head) {
    anchors.head.updateWorldMatrix(true, false);
    scratchPos.setFromMatrixPosition(anchors.head.matrixWorld);
    const r = cfg.probeRadius * cfg.radiusScale.head;
    if (point.distanceToSquared(scratchPos) <= r * r) return null;
  }

  // ── 1. Classified-bone ancestry (strongest evidence) ──
  if (hitObject) {
    for (let o: THREE.Object3D | null = hitObject; o; o = o.parent) {
      const match = anchors.classified.find((c) => c.object === o);
      if (match) {
        if (DRAG_CATEGORIES.has(match.category)) return match.category as DragCategory;
        break; // humanoid / unknown ancestry: not a grab by name
      }
    }
  }

  // ── 1.5 Skinned-mesh evidence: whose surface did the ray physically hit? ──
  // A dedicated Hair/Tail/Skirt mesh is skinned mostly by its own family's
  // bones. A majority of a drag category means the finger landed on that
  // family's mesh; a majority of unclassified bones means a body mesh.
  const skinned = hitObject as THREE.SkinnedMesh | null;
  if (skinned?.isSkinnedMesh === true && anchors.boneCategory.size > 0) {
    const bones = skinned.skeleton?.bones;
    if (bones?.length) {
      const counts = new Map<string, number>();
      for (const b of bones) {
        const cat = anchors.boneCategory.get(b);
        if (cat && DRAG_CATEGORIES.has(cat)) counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }
      let top: { cat: string; n: number } | null = null;
      for (const [cat, n] of counts) if (!top || n > top.n) top = { cat, n };
      if (top) return top.cat as DragCategory;
    }
  }

  // ── 2. Nearest visible secondary bone (merged-mesh / no-ancestry case) ──
  const secondary = nearestVisibleSecondary(point, camera, anchors, cfg);
  if (secondary && DRAG_CATEGORIES.has(secondary.category)) {
    return secondary.category as DragCategory;
  }
  return null;
}
