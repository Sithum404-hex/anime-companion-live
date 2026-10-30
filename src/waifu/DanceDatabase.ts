import { DanceMetadata, getAllDanceMetadata, getDanceMetadata } from "./danceMetadata";

export interface DanceEntry {
  metadata: DanceMetadata;
  lastPlayed: number;
  playCount: number;
}

export class DanceDatabase {
  private dances: Map<string, DanceEntry> = new Map();
  private debug = false;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    const metadata = getAllDanceMetadata();
    for (const meta of metadata) {
      this.dances.set(meta.name, {
        metadata: meta,
        lastPlayed: 0,
        playCount: 0,
      });
    }
    if (this.debug) {
      console.log("[DanceDatabase] Initialized with", this.dances.size, "dances");
    }
  }

  getAll(): DanceMetadata[] {
    return Array.from(this.dances.values()).map((e) => e.metadata);
  }

  getByName(name: string): DanceMetadata | undefined {
    const entry = this.dances.get(name);
    return entry?.metadata;
  }

  getByUrl(url: string): DanceMetadata | undefined {
    for (const entry of this.dances.values()) {
      if (entry.metadata.url === url) return entry.metadata;
    }
    return undefined;
  }

  recordPlay(name: string): void {
    const entry = this.dances.get(name);
    if (entry) {
      entry.lastPlayed = Date.now();
      entry.playCount++;
    }
  }

  getTimeSinceLastPlayed(name: string): number {
    const entry = this.dances.get(name);
    if (!entry) return Infinity;
    return Date.now() - entry.lastPlayed;
  }

  getPlayCount(name: string): number {
    return this.dances.get(name)?.playCount ?? 0;
  }

  getRecentHistory(limit: number = 5): DanceMetadata[] {
    const sorted = Array.from(this.dances.values())
      .filter((e) => e.lastPlayed > 0)
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .slice(0, limit)
      .map((e) => e.metadata);
    return sorted;
  }

  getDancesByStyle(style: DanceMetadata["style"]): DanceMetadata[] {
    return this.getAll().filter((d) => d.style === style);
  }

  getDancesByEnergyRange(min: number, max: number): DanceMetadata[] {
    return this.getAll().filter((d) => d.energyMax >= min && d.energyMin <= max);
  }

  getDancesByBpmRange(min: number, max: number): DanceMetadata[] {
    return this.getAll().filter((d) => d.preferredBpmMax >= min && d.preferredBpmMin <= max);
  }

  getLoopableDances(): DanceMetadata[] {
    return this.getAll().filter((d) => d.isLoopable);
  }

  getTransitionDances(): DanceMetadata[] {
    return this.getAll().filter((d) => d.isTransition);
  }

  getPrimaryDances(): DanceMetadata[] {
    return this.getAll().filter((d) => !d.isTransition);
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  reset(): void {
    for (const entry of this.dances.values()) {
      entry.lastPlayed = 0;
      entry.playCount = 0;
    }
  }
}
