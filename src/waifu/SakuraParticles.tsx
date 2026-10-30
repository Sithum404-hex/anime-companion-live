import { useEffect, useRef } from "react";

/**
 * Ambient sakura petals.
 *
 * Pure CSS animation driven by the `.petal` class in `styles.css` — no
 * requestAnimationFrame, no layout reads, so it costs nothing next to the
 * Three.js render loop. A media query in the stylesheet disables it entirely
 * under `prefers-reduced-motion`.
 *
 * Deliberately sparse and low-contrast. This is a live wallpaper: the scene
 * and the character are already the loud parts.
 */
export function SakuraPetals({ count = 14 }: { count?: number }) {
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;

    // Respect the OS setting in JS as well, so no petals are even created.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const nodes: HTMLElement[] = [];
    for (let i = 0; i < count; i++) {
      const petal = document.createElement("i");
      petal.className = "petal";
      const size = 7 + Math.random() * 11;
      petal.style.width = `${size}px`;
      petal.style.height = `${size * 0.68}px`;
      petal.style.left = `${Math.random() * 100}%`;
      petal.style.setProperty("--petal-drift", `${-40 + Math.random() * 80}px`);
      petal.style.setProperty("--petal-spin", `${140 + Math.random() * 260}deg`);
      petal.style.setProperty("--petal-opacity", `${0.18 + Math.random() * 0.3}`);
      // Staggered durations so they never fall in lockstep.
      petal.style.animationDuration = `${16 + Math.random() * 18}s`;
      petal.style.animationDelay = `${-Math.random() * 30}s`;
      layer.appendChild(petal);
      nodes.push(petal);
    }

    return () => nodes.forEach((n) => n.remove());
  }, [count]);

  return (
    <div
      ref={layerRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: 10 }}
    />
  );
}
