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
  // Let the official helper rotate legacy VRM 0.x models only.
  VRMUtils.rotateVRM0(vrm);
  return vrm;
}

export function disposeVRM(vrm: VRM) {
  VRMUtils.deepDispose(vrm.scene);
  vrm.scene.parent?.remove(vrm.scene);
  void THREE;
}
