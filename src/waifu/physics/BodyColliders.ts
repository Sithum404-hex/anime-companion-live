import * as THREE from "three";
import { VRMHumanBoneName, type VRM } from "@pixiv/three-vrm";
import type { PhysicsBone } from "./PhysicsBone";
import { PHYSICS_CONFIG, type ColliderSet } from "../physicsConfig";

/**
 * BodyColliders — a small, allocation-free set of world-space colliders
 * rebuilt each frame from the VRM humanoid bones:
 *
 *   • head sphere (existing)
 *   • spine capsule (hips → chest)
 *   • left/right upper-arm capsules (upperArm → lowerArm)
 *   • left/right hip spheres (upperLeg origins)
 *
 * Every frame:
 *   1. `update()` copies the current bone world positions into preallocated
 *      scratch vectors (no new objects).
 *   2. Subsystems call `collideBone(bone, pushStrength, set)` per non-root
 *      simulated bone, which pushes the bone out of any penetrated collider.
 *
 * Collider gating per quality tier:
 *   "head"     → head sphere only
 *   "headSpine" → + spine capsule + hip spheres
 *   "full"     → + both upper-arm capsules
 */
export class BodyColliders {
  private headCenter = new THREE.Vector3();
  private spineA = new THREE.Vector3();
  private spineB = new THREE.Vector3();
  private armLA = new THREE.Vector3();
  private armLB = new THREE.Vector3();
  private armRA = new THREE.Vector3();
  private armRB = new THREE.Vector3();
  private hipL = new THREE.Vector3();
  private hipR = new THREE.Vector3();

  private headBone: THREE.Object3D | null = null;
  private hipsBone: THREE.Object3D | null = null;
  private chestBone: THREE.Object3D | null = null;
  private spineBone: THREE.Object3D | null = null;
  private armLABone: THREE.Object3D | null = null;
  private armLBBone: THREE.Object3D | null = null;
  private armRABone: THREE.Object3D | null = null;
  private armRBBone: THREE.Object3D | null = null;
  private hipLBone: THREE.Object3D | null = null;
  private hipRBone: THREE.Object3D | null = null;

  constructor(vrm: VRM) {
    const hum = vrm.humanoid;
    if (!hum) return;
    const get = (n: VRMHumanBoneName) => hum.getNormalizedBoneNode(n) ?? null;
    this.headBone = get(VRMHumanBoneName.Head);
    this.hipsBone = get(VRMHumanBoneName.Hips);
    this.spineBone = get(VRMHumanBoneName.Spine);
    this.chestBone = get(VRMHumanBoneName.Chest) ?? get(VRMHumanBoneName.UpperChest);
    this.armLABone = get(VRMHumanBoneName.LeftUpperArm);
    this.armLBBone = get(VRMHumanBoneName.LeftLowerArm);
    this.armRABone = get(VRMHumanBoneName.RightUpperArm);
    this.armRBBone = get(VRMHumanBoneName.RightLowerArm);
    this.hipLBone = get(VRMHumanBoneName.LeftUpperLeg);
    this.hipRBone = get(VRMHumanBoneName.RightUpperLeg);
  }

  /** Refresh collider transforms from the current bone matrices (no allocations). */
  update(): void {
    const set = (target: THREE.Vector3, node: THREE.Object3D | null) => {
      if (node) {
        node.updateWorldMatrix(true, false);
        target.setFromMatrixPosition(node.matrixWorld);
      }
    };
    set(this.headCenter, this.headBone);
    this.headCenter.y -= PHYSICS_CONFIG.colliders.headOffsetY;
    // Spine capsule: hips → chest (fall back to spine if chest missing).
    set(this.spineA, this.hipsBone);
    set(this.spineB, this.chestBone ?? this.spineBone);
    set(this.armLA, this.armLABone);
    set(this.armLB, this.armLBBone);
    set(this.armRA, this.armRABone);
    set(this.armRB, this.armRBBone);
    set(this.hipL, this.hipLBone);
    set(this.hipR, this.hipRBone);
  }

  /** Push a physics bone out of every active collider for the given set. */
  collideBone(bone: PhysicsBone, pushStrength: number, set: ColliderSet): void {
    const c = PHYSICS_CONFIG.colliders;

    bone.collideSphere(this.headCenter, c.headRadius, pushStrength);

    if (set === "head") return;

    bone.collideCapsule(this.spineA, this.spineB, c.spineRadius, pushStrength);
    bone.collideSphere(this.hipL, c.hipRadius, pushStrength);
    bone.collideSphere(this.hipR, c.hipRadius, pushStrength);

    if (set !== "full") return;

    bone.collideCapsule(this.armLA, this.armLB, c.armRadius, pushStrength);
    bone.collideCapsule(this.armRA, this.armRB, c.armRadius, pushStrength);
  }
}
