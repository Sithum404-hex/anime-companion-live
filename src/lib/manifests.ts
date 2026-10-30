import type { ModelManifest, WardrobeManifest } from "@/waifu/types";

/**
 * Shared manifest loaders.
 *
 * The stage and the settings panel both need these files. Caching the
 * in-flight promise means the browser makes one request per manifest per
 * session instead of one per component (and none at all when the second
 * consumer mounts after the first has resolved).
 */

let manifestPromise: Promise<ModelManifest> | null = null;
let wardrobePromise: Promise<WardrobeManifest | null> | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function loadModelManifest(): Promise<ModelManifest> {
  if (!manifestPromise) {
    manifestPromise = fetchJson<ModelManifest>("/models/manifest.json")
      .then((data) => ({ models: Array.isArray(data?.models) ? data.models : [] }))
      .catch(() => {
        // Do not cache failures — a later mount can retry.
        manifestPromise = null;
        return { models: [] } as ModelManifest;
      });
  }
  return manifestPromise;
}

export function loadWardrobeManifest(): Promise<WardrobeManifest | null> {
  if (!wardrobePromise) {
    wardrobePromise = fetchJson<WardrobeManifest>("/models/wardrobe.json")
      .then((data) => (Array.isArray(data?.outfits) ? data : null))
      .catch(() => {
        wardrobePromise = null;
        return null;
      });
  }
  return wardrobePromise;
}
