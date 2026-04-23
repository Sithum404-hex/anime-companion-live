import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

export async function loadVRM(url: string): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });
  // VRM 1.0 models already face +Z (toward a camera at positive Z). Do not rotate.
  // Ensure VRM 0.x models (which face -Z) are flipped to face the camera.
  const meta = (vrm as unknown as { meta?: { metaVersion?: string } }).meta;
  const isVRM0 = meta?.metaVersion === "0";
  if (isVRM0) {
    vrm.scene.rotation.y = Math.PI;
  }
  return vrm;
}

export function disposeVRM(vrm: VRM) {
  VRMUtils.deepDispose(vrm.scene);
  vrm.scene.parent?.remove(vrm.scene);
  void THREE;
}
