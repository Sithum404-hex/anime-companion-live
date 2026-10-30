import { analyzeScreen } from "@/lib/screenAnalysis";

export interface ScreenAnalysisResult {
  summary: string;
  screenType: string;
  category: string;
}

export interface ScreenVisionState {
  enabled: boolean;
  sharing: boolean;
  lastSummary: string;
  lastScreenType: string;
  lastCategory: string;
  analyzing: boolean;
}

const SCREEN_VISION_KEY = "waifu.screenVision.v1";

type Listener = (result: ScreenAnalysisResult) => void;

export class ScreenVisionService {
  private mediaStream: MediaStream | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private intervalId: number | null = null;
  private _enabled = false;
  private _sharing = false;
  private _analyzing = false;
  private _lastSummary = "";
  private _lastScreenType = "";
  private _lastCategory = "";
  private autoAnalyze = true;
  private analysisInterval = 15000;
  private listeners: Set<Listener> = new Set();
  private onStatus: ((status: string) => void) | null = null;
  private previousFrameData: ImageData | null = null;
  private boundUnload: (() => void) | null = null;

  constructor() {
    this.boundUnload = () => {
      if (typeof window !== "undefined") {
        sessionStorage.removeItem(SCREEN_VISION_KEY);
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.boundUnload);
    }
  }

  loadState(): void {
    if (typeof window === "undefined") return;
    try {
      const raw = sessionStorage.getItem(SCREEN_VISION_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        this._lastSummary = saved.lastSummary || "";
        this._lastScreenType = saved.lastScreenType || "";
        this._lastCategory = saved.lastCategory || "";
      }
    } catch {
      /* empty */
    }
  }

  private persistState(): void {
    if (typeof window === "undefined") return;
    try {
      sessionStorage.setItem(
        SCREEN_VISION_KEY,
        JSON.stringify({
          lastSummary: this._lastSummary,
          lastScreenType: this._lastScreenType,
          lastCategory: this._lastCategory,
        }),
      );
    } catch {
      /* empty */
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get sharing(): boolean {
    return this._sharing;
  }

  get analyzing(): boolean {
    return this._analyzing;
  }

  get lastSummary(): string {
    return this._lastSummary;
  }

  get lastScreenType(): string {
    return this._lastScreenType;
  }

  get lastCategory(): string {
    return this._lastCategory;
  }

  get state(): ScreenVisionState {
    return {
      enabled: this._enabled,
      sharing: this._sharing,
      lastSummary: this._lastSummary,
      lastScreenType: this._lastScreenType,
      lastCategory: this._lastCategory,
      analyzing: this._analyzing,
    };
  }

  onResult(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setOnStatus(fn: (status: string) => void): void {
    this.onStatus = fn;
  }

  setAutoAnalyze(v: boolean): void {
    this.autoAnalyze = v;
    if (this._sharing && this._enabled) {
      this.restartInterval();
    }
  }

  setAnalysisInterval(ms: number): void {
    this.analysisInterval = Math.max(5000, Math.min(120000, ms));
    if (this._sharing && this._enabled && this.autoAnalyze) {
      this.restartInterval();
    }
  }

  private restartInterval(): void {
    this.clearInterval();
    if (this.autoAnalyze && this._sharing) {
      this.intervalId = window.setInterval(() => {
        this.analyze().catch(() => {});
      }, this.analysisInterval);
    }
  }

  private clearInterval(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private emit(result: ScreenAnalysisResult): void {
    for (const fn of this.listeners) {
      try {
        fn(result);
      } catch {
        /* empty */
      }
    }
  }

  async start(): Promise<void> {
    if (this._sharing) return;

    try {
      this.onStatus?.("Requesting screen access…");
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 5, max: 10 },
        },
        audio: false,
      });

      this.mediaStream = stream;
      this.videoTrack = stream.getVideoTracks()[0];

      if (!this.videoTrack) {
        this.stop();
        throw new Error("No video track found in screen capture.");
      }

      this.videoTrack.onended = () => {
        this.stop();
      };

      this.video = document.createElement("video");
      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();

      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });

      this._sharing = true;
      this._enabled = true;
      this.onStatus?.("Screen sharing active");

      if (this.autoAnalyze) {
        this.intervalId = window.setInterval(() => {
          this.analyze().catch(() => {});
        }, this.analysisInterval);
      }

      this.emit({
        summary: "",
        screenType: "other",
        category: "other",
      });
    } catch (err) {
      this._sharing = false;
      this._enabled = false;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Permission") ||
        msg.includes("permission") ||
        msg.includes("cancel") ||
        msg.includes("Cancel")
      ) {
        this.onStatus?.("Screen sharing permission denied");
      } else {
        this.onStatus?.(`Screen vision error: ${msg}`);
      }
      throw err;
    }
  }

  stop(): void {
    this.clearInterval();

    if (this.videoTrack) {
      this.videoTrack.stop();
      this.videoTrack.onended = null;
      this.videoTrack = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }

    this.canvas = null;
    this.ctx = null;
    this.previousFrameData = null;
    this._sharing = false;
    this._enabled = false;
    this._analyzing = false;
    sessionStorage.removeItem(SCREEN_VISION_KEY);
    this.onStatus?.("Screen sharing stopped");
  }

  captureScreenshot(): string | null {
    if (!this.video || !this.canvas || !this.ctx) return null;

    const MAX_WIDTH = 640;
    let w = this.video.videoWidth;
    let h = this.video.videoHeight;

    if (w === 0 || h === 0) return null;

    if (w > MAX_WIDTH) {
      h = Math.round(h * (MAX_WIDTH / w));
      w = MAX_WIDTH;
    }

    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(this.video, 0, 0, w, h);

    const currentData = this.ctx.getImageData(0, 0, w, h);

    if (this.previousFrameData) {
      const prev = this.previousFrameData;
      if (prev.width === currentData.width && prev.height === currentData.height) {
        const pixels = currentData.data;
        const prevPixels = prev.data;
        const totalPixels = pixels.length;
        let diffCount = 0;
        for (let i = 0; i < totalPixels; i += 4) {
          const dr = Math.abs(pixels[i] - prevPixels[i]);
          const dg = Math.abs(pixels[i + 1] - prevPixels[i + 1]);
          const db = Math.abs(pixels[i + 2] - prevPixels[i + 2]);
          if (dr > 10 || dg > 10 || db > 10) {
            diffCount++;
          }
        }
        const variance = diffCount / (totalPixels / 4);
        if (variance < 0.01) {
          return null;
        }
      }
    }

    this.previousFrameData = currentData;

    return this.canvas.toDataURL("image/jpeg", 0.6).split(",")[1];
  }

  async analyze(): Promise<ScreenAnalysisResult | null> {
    if (!this._sharing || this._analyzing) return null;

    const b64 = this.captureScreenshot();
    if (!b64) return null;

    this._analyzing = true;
    this.onStatus?.("Analyzing screen…");

    try {
      const result = await analyzeScreen({ data: { image: b64 } });

      this._lastSummary = result.summary;
      this._lastScreenType = result.screenType;
      this._lastCategory = result.category;
      this.persistState();

      this.emit(result);
      this.onStatus?.("Screen vision active");
      return result;
    } catch (err) {
      console.warn("[ScreenVision] Analysis failed:", err);
      // Include the reason (rate limit, auth, model error…) so the UI can
      // tell the user why the feature is silent instead of just "failed".
      const msg = err instanceof Error ? err.message : String(err);
      this.onStatus?.(`Screen analysis failed: ${msg}`);
      return null;
    } finally {
      this._analyzing = false;
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.onStatus = null;
    this.previousFrameData = null;
    if (this.boundUnload && typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.boundUnload);
      this.boundUnload = null;
    }
  }
}
