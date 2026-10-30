import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { VRMSpringBoneJointHelper, VRMSpringBoneColliderHelper } from "@pixiv/three-vrm-springbone";

const DEBUG_PARAM = "debugSprings";

function isDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.has(DEBUG_PARAM);
}

export class SpringBoneDebugHelper {
  private group = new THREE.Group();
  private jointHelpers: VRMSpringBoneJointHelper[] = [];
  private colliderHelpers: VRMSpringBoneColliderHelper[] = [];

  constructor(
    private vrm: VRM,
    scene: THREE.Scene,
  ) {
    if (!isDebugEnabled()) return;
    this.build();
    scene.add(this.group);
  }

  private build(): void {
    const manager = this.vrm.springBoneManager;
    if (!manager) return;

    for (const joint of manager.joints) {
      const helper = new VRMSpringBoneJointHelper(joint);
      this.jointHelpers.push(helper);
      this.group.add(helper);
    }

    for (const collider of manager.colliders) {
      const helper = new VRMSpringBoneColliderHelper(collider);
      this.colliderHelpers.push(helper);
      this.group.add(helper);
    }
  }

  dispose(): void {
    for (const h of this.jointHelpers) h.dispose();
    for (const h of this.colliderHelpers) h.dispose();
    this.jointHelpers = [];
    this.colliderHelpers = [];
    this.group.parent?.remove(this.group);
  }
}
