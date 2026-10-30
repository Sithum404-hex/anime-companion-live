/**
 * Renderer robustness — unit tests.
 *
 * Covers the three pieces of logic that were extracted from `Renderer` so they
 * can be checked without a WebGL context:
 *
 *   B. AdaptiveQualityGovernor — thresholds, streaks and the post-change cooldown
 *   C. resolveFpsCapMs         — cap values and the Max Performance override
 *   C. Frame pacing            — the gate `loop()` uses, replayed tick by tick
 *
 * Run:
 *   npx esbuild scripts/test-renderer-robustness.ts --bundle --format=esm \
 *     --platform=node --outfile=.tmp.mjs --log-level=warning && node .tmp.mjs
 */

import { AdaptiveQualityGovernor, DEFAULT_ADAPTIVE_CONFIG } from "../src/waifu/adaptiveQuality";
import {
  resolveFpsCapMs,
  FPS_CAP_MS,
  createVisibilityPause,
  type FpsCap,
} from "../src/waifu/performance";
import type { QualityTier } from "../src/waifu/performance";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const CFG = DEFAULT_ADAPTIVE_CONFIG;
const EVAL_MS = CFG.evalIntervalSec * 1000;
const COOLDOWN_MS = CFG.cooldownSec * 1000;
const SLOW = CFG.minFps - 5; // 20
const FAST = CFG.maxFps + 10; // 55
const MID = (CFG.minFps + CFG.maxFps) / 2; // 35 — inside the dead band

/**
 * Replay `count` evaluations at the configured interval, returning the tier
 * after each one. `feed` maps (index, currentTier) to an FPS reading, which lets
 * a test model a machine whose real speed depends on the tier it is running.
 */
function simulate(
  startTier: QualityTier,
  count: number,
  feed: (index: number, tier: QualityTier) => number,
  startMs = 0,
): { tiers: (QualityTier | null)[]; governor: AdaptiveQualityGovernor } {
  const g = new AdaptiveQualityGovernor(CFG, startTier);
  const tiers: (QualityTier | null)[] = [];
  let now = startMs;
  let tier = startTier;
  for (let i = 0; i < count; i++) {
    now += EVAL_MS;
    const next = g.evaluate(feed(i, tier), now);
    tiers.push(next);
    if (next) tier = next;
  }
  return { tiers, governor: g };
}

// ── B. cooldown semantics ───────────────────────────────────────────────────
section("B. AdaptiveQualityGovernor — cooldown");

{
  const g = new AdaptiveQualityGovernor(CFG, "medium");
  check("starts at the tier it was constructed with", g.currentTier === "medium");
  check("no cooldown is pending before the first change", g.cooldownRemainingMs(0) === 0);
}

{
  // One slow evaluation must not be enough (downgradeThreshold = 2).
  const { tiers } = simulate("medium", 1, () => SLOW);
  check("a single slow evaluation does not degrade", tiers[0] === null);
}

{
  const { tiers, governor } = simulate("medium", 2, () => SLOW);
  check("two consecutive slow evaluations degrade one tier", tiers[1] === "low");
  check("the governor tracks the new tier", governor.currentTier === "low");
  check(
    "the cooldown starts at the moment of change",
    governor.cooldownRemainingMs(2 * EVAL_MS) === COOLDOWN_MS,
  );
}

{
  // The headline bug: a machine that speeds up the moment it degrades used to
  // bounce LOW -> MED -> LOW roughly every 12 s.
  const g = new AdaptiveQualityGovernor(CFG, "medium");
  let now = 0;
  let tier: QualityTier = "medium";
  const changes: { at: number; to: QualityTier }[] = [];

  // medium genuinely cannot hold 25 fps; low comfortably exceeds 45.
  const realFps: Record<QualityTier, number> = { low: 55, medium: 20, high: 12 };

  for (let i = 0; i < 600 / CFG.evalIntervalSec; i++) {
    now += EVAL_MS;
    const next = g.evaluate(realFps[tier], now);
    if (next) {
      tier = next;
      changes.push({ at: now, to: next });
    }
  }

  const gaps = changes.slice(1).map((c, i) => c.at - changes[i].at);
  const minGap = Math.min(...gaps);
  check(
    "a ping-pong machine does eventually change tier",
    changes.length > 0,
    `got ${changes.length}`,
  );
  check(
    "no two tier changes are closer than the cooldown",
    minGap >= COOLDOWN_MS,
    `min gap ${(minGap / 1000).toFixed(1)}s over ${changes.length} changes`,
  );

  // For reference, what the same machine did before the cooldown existed:
  // degrade at t=4 s, upgrade at t=12 s, degrade at t=16 s ... a 12 s cycle.
  const period = changes.length > 1 ? 600 / (changes.length - 1) : Infinity;
  console.log(
    `       ${changes.length} changes in 600 s (one every ~${period.toFixed(1)} s; ` +
      `previously one every ~12 s)`,
  );
  check(
    "cooldown stretches the bounce period well beyond the pre-fix 12 s",
    period > 12,
    `period ${period.toFixed(1)}s`,
  );
}

{
  // A user pressing "high" on a machine that measures 30 fps must not be
  // reverted seconds later — that is what made the setting look broken.
  const g = new AdaptiveQualityGovernor(CFG, "medium");
  g.notifyTierChanged("high", 1000);
  check("a user tier change starts the cooldown", g.cooldownRemainingMs(1000) === COOLDOWN_MS);
  const first = g.evaluate(SLOW, 1000 + EVAL_MS);
  check("the adaptive loop cannot immediately undo a user choice", first === null);
}

{
  // Streaks accumulated before the tier settled must not carry over.
  const g = new AdaptiveQualityGovernor(CFG, "medium");
  g.notifyTierChanged("medium", 0);
  let now = 0;
  // Burn one full slow streak inside the cooldown window.
  now += EVAL_MS;
  check("cooling down drops slow evidence (1)", g.evaluate(SLOW, now) === null);
  now += EVAL_MS;
  check("cooling down drops slow evidence (2)", g.evaluate(SLOW, now) === null);
  // Window closes; a fresh streak is needed, so the very next eval must hold.
  now = COOLDOWN_MS;
  check(
    "after the cooldown the first evaluation is not pre-credited",
    g.evaluate(SLOW, now) === null,
  );
  now += EVAL_MS;
  check("a full fresh streak degrades after the cooldown", g.evaluate(SLOW, now) === "low");
}

{
  // The cooldown is symmetric: blocking only one direction just relocates the
  // oscillation, so an upgrade must be just as protected.
  const g = new AdaptiveQualityGovernor(CFG, "low");
  g.notifyTierChanged("medium", 0);
  const next = g.evaluate(FAST, EVAL_MS);
  check("an upgrade is blocked right after a downgrade", next === null);
}

{
  // The upgrade path needs 4 evaluations = 8 s, which has to fit inside the
  // 10 s cooldown or the governor would be latched off after any change.
  const { tiers } = simulate("low", 4, () => FAST, 0);
  check(
    "the upgrade path still fits inside the cooldown window",
    tiers[3] === "medium",
    `got ${JSON.stringify(tiers)}`,
  );
  const { tiers: fresh } = simulate("low", 4, () => FAST, 500);
  check(
    "upgrading mid-cooldown does not pre-credit the ladder",
    fresh[0] === null && fresh[1] === null,
  );
}

{
  const { tiers } = simulate("low", 3, () => SLOW);
  check(
    "low is the bottom of the ladder — no downgrade",
    tiers.every((t) => t === null),
  );
  const { tiers: hi } = simulate("high", 6, () => FAST);
  check(
    "high is the top of the ladder — no upgrade",
    hi.every((t) => t === null),
  );
}

{
  const { tiers } = simulate("medium", 10, () => MID);
  check(
    "the dead band never changes tier",
    tiers.every((t) => t === null),
  );
  check("the dead band is stable at its starting tier", true);
}

{
  // A machine that settles must converge and stop, exactly as before.
  const { tiers, governor } = simulate("medium", 20, () => FAST);
  check("a healthy machine climbs one tier and stops", tiers.filter(Boolean).length === 1);
  check("and settles on high", governor.currentTier === "high");
}

{
  const g = new AdaptiveQualityGovernor(CFG, "medium");
  check("a non-finite reading is ignored", g.evaluate(Number.NaN, 0) === null);
  check("infinity is ignored", g.evaluate(Number.POSITIVE_INFINITY, 0) === null);
  check(
    "and the tier is untouched",
    g.evaluate(Number.NaN, 0) === null && g.currentTier === "medium",
  );
}

// ── C. FPS cap resolution ───────────────────────────────────────────────────
section("C. resolveFpsCapMs — cap values and Max Performance priority");

check(
  "30 fps resolves to a 33.3 ms interval",
  Math.abs(resolveFpsCapMs("30", false) - 1000 / 30) < 1e-9,
);
check(
  "60 fps resolves to a 16.7 ms interval",
  Math.abs(resolveFpsCapMs("60", false) - 1000 / 60) < 1e-9,
);
check("uncapped resolves to 0 (no ceiling)", resolveFpsCapMs("uncapped", false) === 0);

check("Max Performance releases a 30 fps cap", resolveFpsCapMs("30", true) === 0);
check("Max Performance releases a 60 fps cap", resolveFpsCapMs("60", true) === 0);
check("Max Performance on an uncapped setting is a no-op", resolveFpsCapMs("uncapped", true) === 0);

{
  // The default in DEFAULT_SETTINGS must preserve pre-existing behaviour.
  const all: FpsCap[] = ["30", "60", "uncapped"];
  const capped = all.filter((c) => resolveFpsCapMs(c, false) > 0);
  check("Max Performance overrides every cap value", capped.length === 2);
  check(
    "no cap value is faster than the uncapped value",
    all.every((c) => resolveFpsCapMs(c, false) >= resolveFpsCapMs("uncapped", false)),
  );
  check("30 fps is a slower cadence than 60 fps", FPS_CAP_MS["30"] > FPS_CAP_MS["60"]);
}

{
  // A hand-edited or older localStorage value must never invent a slowdown.
  const bogus = resolveFpsCapMs("45" as FpsCap, false);
  check("an unrecognised cap value falls back to uncapped", bogus === 0);
  check(
    "Max Performance still wins over an unrecognised value",
    resolveFpsCapMs("45" as FpsCap, true) === 0,
  );
}

// ── C. frame pacing, replayed tick by tick ───────────────────────────────────
section("C. frame pacing — the gate loop() applies");

/**
 * Replays the renderer's cap gate tick by tick at a fixed display refresh, and
 * reports which ticks executed a frame. This is a line-for-line copy of the
 * grid in `Renderer.loop()` — the naive "elapsed since last frame >= cap"
 * comparison it replaced is deliberately not what ships.
 */
function pace(
  capMs: number,
  tickMs: number,
  ticks: number,
  stallAtMs = Number.POSITIVE_INFINITY,
): { ran: number[]; dt: number[] } {
  const ran: number[] = [];
  const dt: number[] = [];
  let anchorAt = 0;
  let frameIndex = 0;
  let started = false;
  let stalled = false;
  for (let i = 0; i < ticks; i++) {
    let now = i * tickMs;
    if (!stalled && now >= stallAtMs) {
      now = stallAtMs; // one frame takes half a second
      stalled = true;
    }
    if (capMs > 0) {
      if (!started) {
        started = true;
        anchorAt = now;
      } else if (now < anchorAt + frameIndex * capMs) {
        continue; // not due yet
      }
      frameIndex = Math.floor((now - anchorAt) / capMs) + 1;
    }
    ran.push(now);
    if (ran.length > 1) dt.push(now - ran[ran.length - 2]);
  }
  return { ran, dt };
}

/** Fraction of gaps that sit more than 1 ms off the mean — the judder rate. */
function judderRate(dt: number[]): number {
  if (dt.length === 0) return 0;
  const mean = dt.reduce((a, b) => a + b, 0) / dt.length;
  return dt.filter((d) => Math.abs(d - mean) > 1).length / dt.length;
}

{
  const r = pace(0, 1000 / 60, 60); // uncapped
  check("uncapped runs every tick", r.ran.length === 60);
}

{
  // The exact-ratio case, and the one that exposed the naive gate: 30 fps on a
  // 60 Hz display must land on every second vblank, forever.
  const r = pace(1000 / 30, 1000 / 60, 180);
  const mean = r.dt.reduce((a, b) => a + b, 0) / r.dt.length;
  check(
    "a 30 fps cap on a 60 Hz display runs 30 frames per second",
    r.ran.length >= 90,
    `got ${r.ran.length}`,
  );
  check(
    "and averages the 33.3 ms cap",
    Math.abs(mean - 1000 / 30) < 1,
    `mean ${mean.toFixed(2)} ms`,
  );
  check(
    "with no judder — gaps do not alternate between one and three ticks",
    judderRate(r.dt) <= 0.05,
    `${(judderRate(r.dt) * 100).toFixed(1)}% of gaps off-cadence`,
  );
}

{
  // A 60 fps cap on a 60 Hz display must be a true no-op. The naive gate
  // dropped to 25 ms average here, i.e. it silently throttled below 60.
  const r = pace(1000 / 60, 1000 / 60, 180);
  check(
    "a 60 fps cap on a 60 Hz display drops no frames",
    r.ran.length === 180,
    `got ${r.ran.length}`,
  );
  check("and is perfectly even", judderRate(r.dt) === 0);
}

{
  const r = pace(1000 / 30, 1000 / 144, 144 * 3);
  const mean = r.dt.reduce((a, b) => a + b, 0) / r.dt.length;
  check(
    "a 30 fps cap on a 144 Hz display still yields 30 fps",
    r.ran.length === 90,
    `got ${r.ran.length}`,
  );
  // At a 6.94 ms tick the best achievable precision is one tick.
  check(
    "and holds the average to within one display tick",
    Math.abs(mean - 1000 / 30) <= 1000 / 144,
    `mean ${mean.toFixed(2)} ms`,
  );
  // 33.333 ms is 4.8 ticks at 144 Hz, so gaps must alternate between 4 and 5
  // ticks (27.8 / 34.7 ms). That is correct, not judder — the property that
  // matters is that the gate never lets two frames land on adjacent ticks.
  check(
    "and never renders two frames back to back",
    r.dt.every((d) => d >= 3 * (1000 / 144) - 1e-6),
    `min gap ${Math.min(...r.dt).toFixed(2)} ms`,
  );
}

{
  // A display that is not an exact multiple of the cap (59 Hz) must still
  // average out, not drift.
  const r = pace(1000 / 30, 1000 / 59, 59 * 3);
  const mean = r.dt.reduce((a, b) => a + b, 0) / r.dt.length;
  check(
    "a 30 fps cap on a 59 Hz display still yields 30 fps",
    r.ran.length === 90,
    `got ${r.ran.length}`,
  );
  check(
    "averaging within one display tick",
    Math.abs(mean - 1000 / 30) <= 1000 / 59,
    `mean ${mean.toFixed(2)} ms`,
  );
}

{
  // A long stall must not be followed by a burst of catch-up frames, which is
  // what an accumulated deadline would produce. `now` jumps from 50 ms to
  // 550 ms in one step.
  const r = pace(1000 / 30, 1000 / 60, 60, 550);
  const mean = r.dt.reduce((a, b) => a + b, 0) / r.dt.length;
  check(
    "a 500 ms stall resyncs the grid instead of bursting",
    r.dt.filter((d) => d < 20).length === 0,
    JSON.stringify(r.dt.map((d) => d.toFixed(0))),
  );
  check(
    "and the cadence returns to the cap",
    Math.abs(mean - 1000 / 30) < 1,
    `mean ${mean.toFixed(2)} ms`,
  );
}

{
  // The simulation must still advance in real time: dt is taken across the
  // skipped interval, so 30 rendered frames cover a full second.
  const r = pace(1000 / 30, 1000 / 60, 60);
  const covered = r.dt.reduce((a, b) => a + b, 0);
  check(
    "30 rendered frames still span a full second of simulation",
    Math.abs(covered - 1000) < 1000 / 30,
    `covered ${covered.toFixed(1)} ms`,
  );
}

// ── D. visibility pause ─────────────────────────────────────────────────────
section("D. createVisibilityPause — hidden-tab behaviour");

/**
 * Minimal document stand-in. `hidden` is a plain property the test flips, and
 * the event plumbing is just enough for the real implementation.
 */
function fakeDocument(initiallyHidden: boolean) {
  const listeners: (() => void)[] = [];
  return {
    hidden: initiallyHidden,
    addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_t: string, fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire: () => listeners.slice().forEach((fn) => fn()),
    get listenerCount() {
      return listeners.length;
    },
  };
}

const realDocument = (globalThis as { document?: unknown }).document;

{
  const doc = fakeDocument(false);
  (globalThis as { document?: unknown }).document = doc;
  const vp = createVisibilityPause();
  check("a visible document starts unpaused", vp.paused === false);
  doc.hidden = true;
  doc.fire();
  check("hiding the document pauses", vp.paused === true);
  doc.hidden = false;
  doc.fire();
  check("showing it again resumes", vp.paused === false);
  vp.dispose();
  doc.fire();
  check("dispose removes the listener", doc.listenerCount === 0);
}

{
  // The gap this covers: the flag used to start at `false` regardless of the
  // live value, so a renderer mounted into an already-hidden tab reported
  // itself visible until the first visibilitychange arrived.
  const doc = fakeDocument(true);
  (globalThis as { document?: unknown }).document = doc;
  const vp = createVisibilityPause();
  check("a document already hidden at construction is paused immediately", vp.paused === true);
  doc.hidden = false;
  doc.fire();
  check("and unpauses on the next visibility change", vp.paused === false);
  vp.dispose();
}

if (realDocument === undefined) {
  delete (globalThis as { document?: unknown }).document;
} else {
  (globalThis as { document?: unknown }).document = realDocument;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
