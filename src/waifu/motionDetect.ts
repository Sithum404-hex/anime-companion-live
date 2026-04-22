export class MotionDetect {
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private prev: Uint8ClampedArray | null = null;
  private frame = 0;
  active = false;
  lastScore = 0;
  lastCx = 0; // -1..1
  lastCy = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 160;
    this.canvas.height = 120;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  async start() {
    if (this.active) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    const v = document.createElement("video");
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    await v.play();
    this.video = v;
    this.stream = stream;
    this.active = true;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video = null;
    this.stream = null;
    this.prev = null;
    this.active = false;
  }

  tick(): { score: number; cx: number; cy: number } {
    if (!this.active || !this.video) return { score: 0, cx: 0, cy: 0 };
    this.frame++;
    if (this.frame % 3 !== 0) return { score: this.lastScore, cx: this.lastCx, cy: this.lastCy };
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.drawImage(this.video, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h).data;
    let score = 0;
    let sumX = 0;
    let sumY = 0;
    let weight = 0;
    if (this.prev) {
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const i = (y * w + x) * 4;
          const dr = Math.abs(img[i] - this.prev[i]);
          const dg = Math.abs(img[i + 1] - this.prev[i + 1]);
          const db = Math.abs(img[i + 2] - this.prev[i + 2]);
          const d = dr + dg + db;
          if (d > 60) {
            score += 1;
            sumX += x;
            sumY += y;
            weight += 1;
          }
        }
      }
      score /= (w * h) / 4;
    }
    this.prev = new Uint8ClampedArray(img);
    this.lastScore = score;
    if (weight > 0) {
      this.lastCx = (sumX / weight / w) * 2 - 1;
      this.lastCy = (sumY / weight / h) * 2 - 1;
    }
    return { score, cx: this.lastCx, cy: this.lastCy };
  }
}
