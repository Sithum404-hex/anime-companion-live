import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

export async function loadVRM(url: string): Promise<VRM> {
  let resolvedUrl = url;
  let objectUrl: string | null = null;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Model request failed (${res.status}) for ${url}.`);
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const buf = await res.arrayBuffer();
    const head = new TextDecoder().decode(buf.slice(0, 256)).trimStart().toLowerCase();
    const looksLikeHtml =
      contentType.includes("text/html") || head.startsWith("<!doctype") || head.startsWith("<html");

    if (looksLikeHtml) {
      throw new Error(
        `Model URL "${url}" returned HTML instead of a .vrm file. Check public/models/manifest.json and ensure the file exists in public/models/.`,
      );
    }

    objectUrl = URL.createObjectURL(new Blob([buf], { type: "model/gltf-binary" }));
    resolvedUrl = objectUrl;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to fetch VRM model at ${url}.`);
  }

  const loader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
  loader.setDRACOLoader(dracoLoader);
  loader.register((parser) => new VRMLoaderPlugin(parser));
  try {
    const gltf = await loader.loadAsync(resolvedUrl);
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      throw new Error(
        `Model at "${url}" did not contain VRM data. Ensure the file is a valid .vrm model.`,
      );
    }
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    vrm.scene.traverse((obj) => {
      if ((obj as THREE.SkinnedMesh).isSkinnedMesh || (obj as THREE.Mesh).isMesh) {
        obj.frustumCulled = true;
      }
    });
    VRMUtils.rotateVRM0(vrm);
    return vrm;
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

export function disposeVRM(vrm: VRM) {
  if (!vrm || !vrm.scene) return;
  VRMUtils.deepDispose(vrm.scene);
  vrm.scene.parent?.remove(vrm.scene);
}
