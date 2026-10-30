import type { VRM } from "@pixiv/three-vrm";
import { VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";

/**
 * Classification categories for non-humanoid VRM bones.
 * These map to the physics subsystems that drive them.
 */
export type BoneCategory = "hair" | "cloth" | "tail" | "ear" | "accessory" | "unknown";

/**
 * Describes a discovered bone with its classification and metadata.
 */
export interface ClassifiedBone {
  /** The THREE.Object3D (bone) node. */
  bone: THREE.Object3D;
  /** Category classification. */
  category: BoneCategory;
  /** Name in lowercase (for pattern matching). */
  name: string;
  /** Parent bone in the skeleton hierarchy. */
  parent: THREE.Object3D | null;
  /** Index within a chain (0 = root, incrementing outward). */
  chainIndex: number;
  /** Chain identifier (all bones in a chain share this). */
  chainId: string;
  /** Whether this bone is likely the tip/end of a chain. */
  isTip: boolean;
  /** Side: -1 left, 0 center, 1 right. */
  side: number;
}

/**
 * Discovers and classifies all physics-relevant bones in a VRM model.
 *
 * Strategy:
 * 1. Gets all humanoid bones via the VRM humanoid API.
 * 2. Identifies non-humanoid bones (hair, cloth, tail, accessory).
 * 3. Classifies by name pattern matching (works for both VRM 0.x and 1.0).
 * 4. Organizes into chains based on parent-child relationships.
 */
export class BoneClassifier {
  /** All non-humanoid bones discovered and classified. */
  readonly classified: ClassifiedBone[] = [];
  /** Organized chains (grouped by chainId). */
  readonly chains: Map<string, ClassifiedBone[]> = new Map();

  /** Humanoid bone references cached for collision. */
  readonly head: THREE.Object3D | null;
  readonly chest: THREE.Object3D | null;
  readonly hips: THREE.Object3D | null;

  constructor(private vrm: VRM) {
    this.head = this.getHumanoidBone(VRMHumanBoneName.Head);
    this.chest =
      this.getHumanoidBone(VRMHumanBoneName.UpperChest) ||
      this.getHumanoidBone(VRMHumanBoneName.Chest);
    this.hips = this.getHumanoidBone(VRMHumanBoneName.Hips);
    this.discover();
  }

  private getHumanoidBone(name: string): THREE.Object3D | null {
    try {
      return this.vrm.humanoid?.getNormalizedBoneNode(name as unknown as VRMHumanBoneName) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Traverse the whole scene graph to discover physics-relevant bones.
   *
   * IMPORTANT: hair / skirt / tail / ear chains (J_Sec_*, 襟, スカート…) live
   * in the RAW skeleton, which is a separate hierarchy from the normalized
   * humanoid bones. Walking from the normalized hips — as this used to do —
   * can never reach them, leaving the entire Verlet physics engine inert on
   * models whose hair motion isn't pre-authored. We start at vrm.scene
   * instead and filter to actual Bone nodes.
   */
  private discover(): void {
    if (!this.vrm.humanoid) return;

    // Collect every humanoid bone name (raw AND normalized spellings) so
    // spine/limb bones are never mis-classified.
    const humanoidNames = new Set<string>();
    for (const key of Object.values(VRMHumanBoneName)) {
      try {
        const normalized = this.vrm.humanoid.getNormalizedBoneNode(key);
        if (normalized) humanoidNames.add(normalized.name.toLowerCase());
        const raw = this.vrm.humanoid.getRawBoneNode(key);
        if (raw) humanoidNames.add(raw.name.toLowerCase());
      } catch {
        // Bone may not exist in this VRM version
      }
    }

    // Walk the whole model — meshes etc. are excluded by the instanceof check.
    const root: THREE.Object3D = this.vrm.scene;
    const visited = new Set<THREE.Object3D>();
    const chainStack: Map<string, ClassifiedBone[]> = new Map();

    const walk = (node: THREE.Object3D, depth: number): void => {
      if (visited.has(node) || depth > 64) return;
      visited.add(node);

      const name = node.name.toLowerCase().trim();
      if (!name || !(node instanceof THREE.Bone)) {
        // Meshes, empties and anonymous nodes are never driven — but their
        // children may contain bones, so keep walking.
        for (let i = 0; i < node.children.length; i++) {
          walk(node.children[i], depth + 1);
        }
        return;
      }

      // Skip humanoid bones — only secondary chains are physics-driven.
      if (!humanoidNames.has(name)) {
        const category = this.classifyByName(name);
        if (category !== "unknown") {
          const side = this.detectSide(name);
          const parent = node.parent;

          // Determine chain info
          let chainIndex = 0;
          let chainId = `${category}_${name}`;
          let isTip = true;

          // Check if parent is also classified in the same category
          if (parent) {
            const parentName = parent.name.toLowerCase().trim();
            const parentCategory = this.classifyByName(parentName);
            if (parentCategory === category) {
              chainIndex = this.getChainDepth(node, category);
              chainId = `${category}_${this.getChainRoot(node, category)?.name || name}`;
            }
          }

          // Check if this bone has children of the same category
          for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            const childName = child.name.toLowerCase().trim();
            if (this.classifyByName(childName) === category) {
              isTip = false;
              break;
            }
          }

          const cb: ClassifiedBone = {
            bone: node,
            category,
            name,
            parent,
            chainIndex,
            chainId,
            isTip,
            side,
          };

          this.classified.push(cb);

          if (!chainStack.has(chainId)) {
            chainStack.set(chainId, []);
          }
          chainStack.get(chainId)!.push(cb);
        }
      }

      // Continue traversal
      for (let i = 0; i < node.children.length; i++) {
        walk(node.children[i], depth + 1);
      }
    };

    walk(root, 0);

    // Sort chains by chainIndex and store
    for (const [id, bones] of chainStack) {
      bones.sort((a, b) => a.chainIndex - b.chainIndex);
      this.chains.set(id, bones);
    }

    // ── Diagnostic dump (dev builds only — never spam production consoles) ──
    if (import.meta.env.DEV) {
      if (this.classified.length > 0) {
        const byCat = new Map<string, string[]>();
        for (const cb of this.classified) {
          if (!byCat.has(cb.category)) byCat.set(cb.category, []);
          byCat.get(cb.category)!.push(cb.name);
        }
        console.log(`[BoneClassifier] ${this.classified.length} bones classified:`);
        for (const [cat, names] of byCat) {
          console.log(`  ${cat} (${names.length}):`, names.slice(0, 8));
        }
      } else {
        console.warn("[BoneClassifier] No non-humanoid bones classified — physics will be inert.");
      }
    }
  }

  /**
   * Classify a bone by its name using pattern matching.
   */
  private classifyByName(name: string): BoneCategory {
    // Hair patterns
    if (
      name.includes("hair") ||
      name.includes("bang") ||
      name.includes("pony") ||
      name.includes("twin") ||
      name.includes("sidelock") ||
      name.includes("forelock") ||
      name.includes("tail_hair") ||
      name.includes("strand") ||
      name.includes("ahoge")
    ) {
      return "hair";
    }

    // Cloth patterns
    if (
      name.includes("skirt") ||
      name.includes("dress") ||
      name.includes("cloth") ||
      name.includes("sleeve") ||
      name.includes("ribbon") ||
      name.includes("frill") ||
      name.includes("hem") ||
      name.includes("apron") ||
      name.includes("collar") ||
      name.includes("襟") || // eri (collar in Japanese)
      name.includes("裾") || // suso (hem)
      name.includes("スカート") || // skirt
      name.includes("skirt") ||
      name.includes("sash") ||
      name.includes("belt")
    ) {
      // Check if it's more likely an accessory (ribbon, bow)
      if (name.includes("ribbon") || name.includes("bow")) {
        // Deep check: ribbons on head are accessories, on body are cloth
        return "accessory";
      }
      return "cloth";
    }

    // Tail patterns
    if (
      name.includes("tail") ||
      name.includes("shippo") ||
      name.includes("しっぽ") ||
      name.includes("尻尾") ||
      name.includes("foxtail") ||
      name.includes("fox_tail") ||
      name.includes("animal_tail")
    ) {
      return "tail";
    }

    // Ear patterns (animal ears, not humanoid ears)
    if (
      name.includes("catear") ||
      name.includes("cat_ear") ||
      name.includes("animal_ear") ||
      name.includes("mimi") ||
      name.includes("耳") ||
      name.includes("fo_year") ||
      name.includes("fox_ear") ||
      name.includes("ear")
    ) {
      return "ear";
    }

    // Accessory patterns
    if (
      name.includes("acces") ||
      name.includes("accessory") ||
      name.includes("pendant") ||
      name.includes("necklace") ||
      name.includes("choker") ||
      name.includes("bow") ||
      name.includes("brooch") ||
      name.includes("broach") ||
      name.includes("decoration") ||
      name.includes("ornament") ||
      name.includes("bauble") ||
      name.includes("charm") ||
      name.includes("medal") ||
      name.includes("badge") ||
      name.includes("flower") ||
      name.includes("feather") ||
      name.includes("tassel")
    ) {
      return "accessory";
    }

    return "unknown";
  }

  /**
   * Detect which side of the body a bone belongs to.
   */
  private detectSide(name: string): number {
    // Japanese notation
    if (name.includes("_l") || name.includes("_l_") || name.endsWith("_l")) return -1;
    if (name.includes("_r") || name.includes("_r_") || name.endsWith("_r")) return 1;
    if (name.includes("l.") || name.includes(".l")) return -1;
    if (name.includes("r.") || name.includes(".r")) return 1;

    // English notation
    if (/left/i.test(name) && !/right/i.test(name)) return -1;
    if (/right/i.test(name) && !/left/i.test(name)) return 1;
    if (name.startsWith("l_") || name.startsWith("l-")) return -1;
    if (name.startsWith("r_") || name.startsWith("r-")) return 1;

    // Number-based: even = left, odd = right
    const numMatch = name.match(/_(\d+)$/);
    if (numMatch) {
      return parseInt(numMatch[1], 10) % 2 === 0 ? -1 : 1;
    }

    return 0;
  }

  /**
   * Compute chain depth (index) for a bone within its category chain.
   */
  private getChainDepth(bone: THREE.Object3D, category: BoneCategory): number {
    let depth = 0;
    let current = bone.parent;
    while (current) {
      const cn = current.name.toLowerCase().trim();
      if (this.classifyByName(cn) === category) {
        depth++;
      }
      current = current.parent;
    }
    return depth;
  }

  /**
   * Find the root bone of a chain (farthest ancestor in the same category).
   */
  private getChainRoot(bone: THREE.Object3D, category: BoneCategory): THREE.Object3D | null {
    let root: THREE.Object3D | null = null;
    let current: THREE.Object3D | null = bone;
    while (current) {
      const cn = current.name.toLowerCase().trim();
      if (this.classifyByName(cn) === category) {
        root = current;
      }
      current = current.parent;
    }
    return root;
  }

  /**
   * Filter classified bones by category.
   */
  getByCategory(category: BoneCategory): ClassifiedBone[] {
    return this.classified.filter((b) => b.category === category);
  }

  /**
   * Get all chains for a specific category.
   */
  getChainsByCategory(category: BoneCategory): ClassifiedBone[][] {
    const result: ClassifiedBone[][] = [];
    for (const [, chain] of this.chains) {
      if (chain.length > 0 && chain[0].category === category) {
        result.push(chain);
      }
    }
    return result;
  }

  /** Whether any bones of the given category were found. */
  hasCategory(category: BoneCategory): boolean {
    return this.classified.some((b) => b.category === category);
  }
}
