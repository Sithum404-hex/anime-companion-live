import * as THREE from "three";

export class Renderer {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  clock = new THREE.Clock();
  private resizeObs?: ResizeObserver;
  private container: HTMLElement;
  private rafId = 0;
  private updaters: ((dt: number) => void)[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    this.camera.position.set(0, 1.35, 2.6);
    this.camera.lookAt(0, 1.3, 0);

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    Object.assign(this.renderer.domElement.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
    });

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 1.2);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(1, 2, 1);
    this.scene.add(dir);
    const rim = new THREE.DirectionalLight(0xffaadd, 0.6);
    rim.position.set(-1, 1.5, -1);
    this.scene.add(rim);

    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.loop();
  }

  addUpdate(fn: (dt: number) => void) {
    this.updaters.push(fn);
    return () => {
      this.updaters = this.updaters.filter((f) => f !== fn);
    };
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);
    const dt = this.clock.getDelta();
    for (const fn of this.updaters) fn(dt);
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.resizeObs?.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
