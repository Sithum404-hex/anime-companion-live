import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Supabase is optional: the app is designed to keep working in guest/offline
 * mode. Never throw at module scope here — that would take down the whole
 * bundle before the circuit breaker below has a chance to help.
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string, {
      auth: {
        // No background token-refresh ticks: when the network is down (e.g. a
        // dead proxy tunnel) supabase would otherwise retry refreshes forever,
        // flooding the console with "Failed to fetch" errors. Sessions are still
        // refreshed on demand by getSession()/getUser() calls.
        autoRefreshToken: false,
      },
    })
  : null;

/**
 * Access the client from a call site that only runs when Supabase is
 * configured. Throwing here is safe because every caller wraps this in
 * `supabaseCall`, which catches the error and returns its fallback.
 */
export function getSupabase() {
  if (!supabase) {
    throw new Error(
      "Supabase is not configured (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)",
    );
  }
  return supabase;
}

// ── Resilience layer ────────────────────────────────────────
// When the Supabase host is unreachable (paused/deleted project, dead DNS,
// offline), every call would otherwise hang until the browser's long network
// timeout — freezing startup screens and actions on "loading". These helpers
// bound each call with a short timeout and trip a circuit breaker so the app
// degrades instantly to local-only mode instead of waiting.

const CALL_TIMEOUT_MS = 5_000;
const BREAKER_THRESHOLD = 2;
const BREAKER_OPEN_MS = 60_000;

let consecutiveFailures = 0;
let breakerOpenUntil = 0;

/** True while the breaker is open — Supabase recently proved unreachable. */
export function isSupabaseCircuitOpen(): boolean {
  return performance.now() < breakerOpenUntil;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Supabase call timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Run a Supabase operation bounded by a timeout. Returns `fallback` on
 * timeout/network failure. After BREAKER_THRESHOLD consecutive failures all
 * calls short-circuit to `fallback` for BREAKER_OPEN_MS.
 */
export async function supabaseCall<T>(op: () => T | PromiseLike<T>, fallback: T): Promise<T> {
  // Guest/offline mode: no client means every call is a no-op, not an error.
  if (!supabase) return fallback;
  if (isSupabaseCircuitOpen()) return fallback;
  try {
    const result = await withTimeout(Promise.resolve(op()), CALL_TIMEOUT_MS);
    consecutiveFailures = 0;
    return result;
  } catch (e) {
    consecutiveFailures++;
    if (consecutiveFailures >= BREAKER_THRESHOLD) {
      breakerOpenUntil = performance.now() + BREAKER_OPEN_MS;
      console.warn(
        "[Supabase] Unreachable — going local-only for " +
          `${Math.round(BREAKER_OPEN_MS / 1000)}s: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return fallback;
  }
}
