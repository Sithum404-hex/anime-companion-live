/**
 * Touch heart FX — a small CSS-only burst spawned by a head pat.
 *
 * Mirrors the SakuraPetals approach on purpose: pure DOM + stylesheet
 * animation, no requestAnimationFrame, no Three.js objects, so it costs
 * nothing next to the render loop and can never perturb the choreography.
 * Nodes are removed on animationend; a timeout covers the case where the
 * element is hidden before the animation finishes.
 */

import * as THREE from "three";

const HEART_COUNT = 5;
const FALLBACK_MS = 1400;

/**
 * Spawn a heart burst at a world-space point, projected into screen space.
 *
 * @param container the positioned element the hearts are appended to.
 * @param worldPoint the touch point in world space.
 * @param camera the active camera (for the projection).
 * @param canvas the canvas rect used to normalise the projection.
 */
export function spawnHeartBurst(
  container: HTMLElement,
  worldPoint: THREE.Vector3,
  camera: THREE.Camera,
  canvas: HTMLElement,
): void {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const projected = worldPoint.clone().project(camera);
  // Behind the camera — skip rather than show a mirrored burst.
  if (projected.z > 1) return;

  const x = (projected.x * 0.5 + 0.5) * rect.width;
  const y = (-projected.y * 0.5 + 0.5) * rect.height;

  for (let i = 0; i < HEART_COUNT; i++) {
    const heart = document.createElement("i");
    heart.className = "touch-heart";
    heart.textContent = "♥";
    heart.style.left = `${x}px`;
    heart.style.top = `${y}px`;
    // Per-heart drift + stagger so a burst reads as a puff, not a column.
    heart.style.setProperty("--heart-dx", `${-18 + Math.random() * 36}px`);
    heart.style.setProperty("--heart-dy", `${-46 - Math.random() * 30}px`);
    heart.style.setProperty("--heart-scale", `${0.7 + Math.random() * 0.7}`);
    heart.style.animationDelay = `${i * 45}ms`;
    container.appendChild(heart);

    const drop = () => heart.remove();
    heart.addEventListener("animationend", drop, { once: true });
    window.setTimeout(drop, FALLBACK_MS + i * 45);
  }
}
