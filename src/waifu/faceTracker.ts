import { FaceLandmarker } from "@mediapipe/tasks-vision";
// WASM binaries ship inside the installed package — importing them here keeps
// the JS glue and the wasm ABI in lockstep. A version-pinned CDN copy drifted
// from the npm package (0.10.14 wasm vs 0.10.35 JS) and broke landmarker init.
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import nosimdLoaderPath from "@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url";
import nosimdBinaryPath from "@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url";

/** Mirrors the unexported WasmFileset shape from @mediapipe/tasks-vision. */
interface WasmFileset {
  wasmLoaderPath: string;
  wasmBinaryPath: string;
}

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** SIMD wasm crashes on older engines — validate before picking the fileset. */
function supportsWasmSimd(): boolean {
  try {
    // (module (func (result v128) (v128.const i32x4 0 0 0 0)))
    const simdBytes = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 14, 1, 12, 0, 253, 12, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 11,
    ]);
    return WebAssembly.validate(simdBytes);
  } catch {
    return false;
  }
}

function buildWasmFileset(): WasmFileset {
  return supportsWasmSimd()
    ? { wasmLoaderPath, wasmBinaryPath }
    : { wasmLoaderPath: nosimdLoaderPath, wasmBinaryPath: nosimdBinaryPath };
}

export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  active = false;
  lastX = 0;
  lastY = 0;
  private lastScore = 0;
  private frame = 0;
  private frameSkip = 2;
  private timestampMs = 0;
  private startError: string | null = null;

  constructor(_res = 160) {
    // resolution kept for API compatibility with quality settings
  }

  setResolution(_res: number) {
    // no-op — MediaPipe handles internal resolution
  }

  setFrameSkip(skip: number) {
    this.frameSkip = Math.max(1, skip);
  }

  get error(): string | null {
    return this.startError;
  }

  private async createLandmarker(delegate: "GPU" | "CPU"): Promise<FaceLandmarker> {
    return FaceLandmarker.createFromOptions(buildWasmFileset(), {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate,
      },
      outputFaceBlendshapes: false,
      runningMode: "VIDEO",
      numFaces: 1,
    });
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.startError = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 320 },
          height: { ideal: 240 },
          facingMode: "user",
        },
        audio: false,
      });

      const v = document.createElement("video");
      v.srcObject = stream;
      v.playsInline = true;
      v.muted = true;
      await v.play();

      let landmarker: FaceLandmarker;
      try {
        landmarker = await this.createLandmarker("GPU");
      } catch {
        landmarker = await this.createLandmarker("CPU");
      }

      this.landmarker = landmarker;
      this.video = v;
      this.stream = stream;
      this.frame = 0;
      this.timestampMs = 0;
      this.active = true;
    } catch (e) {
      this.startError = e instanceof Error ? e.message : "Webcam access denied";
      console.warn("[FaceTracker]", this.startError);
      this.stop();
      throw e;
    }
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.landmarker?.close();
    this.landmarker = null;
    this.video = null;
    this.stream = null;
    this.active = false;
    this.lastScore = 0;
  }

  tick(): { score: number; cx: number; cy: number } {
    if (!this.active || !this.video || !this.landmarker) {
      return { score: 0, cx: this.lastX, cy: this.lastY };
    }

    this.frame++;
    if (this.frame % this.frameSkip !== 0) {
      return { score: this.lastScore, cx: this.lastX, cy: this.lastY };
    }

    if (this.video.readyState < 2) {
      return { score: this.lastScore, cx: this.lastX, cy: this.lastY };
    }

    this.timestampMs = performance.now();
    const results = this.landmarker.detectForVideo(this.video, this.timestampMs);

    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
      const nose = results.faceLandmarks[0][1];
      this.lastX = (nose.x - 0.5) * 2;
      this.lastY = -(nose.y - 0.5) * 2;
      this.lastScore = 1;
      return { score: 1, cx: this.lastX, cy: this.lastY };
    }

    this.lastScore = Math.max(0, this.lastScore - 0.15);
    return { score: this.lastScore, cx: this.lastX, cy: this.lastY };
  }
}
