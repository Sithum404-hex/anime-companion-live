export class MicInput {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private data: Uint8Array | null = null;
  private stream: MediaStream | null = null;
  active = false;
  private fftSize = 512;

  setFftSize(size: number) {
    this.fftSize = size;
    if (this.analyser) {
      try {
        this.analyser.fftSize = size;
        this.data = new Uint8Array(size / 2);
      } catch {
        // Ignored
      }
    }
  }

  async start() {
    if (this.active) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    // Autoplay policy: a context created outside a user gesture starts
    // suspended — level() would read zeros forever until resumed.
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = this.fftSize;
    src.connect(an);
    this.ctx = ctx;
    this.analyser = an;
    this.data = new Uint8Array(an.frequencyBinCount);
    this.stream = stream;
    this.active = true;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.active = false;
  }

  level(): number {
    if (!this.analyser || !this.data) return 0;
    this.analyser.getByteTimeDomainData(this.data as unknown as Uint8Array<ArrayBuffer>);
    let sum = 0;
    const data = this.data;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }
}
