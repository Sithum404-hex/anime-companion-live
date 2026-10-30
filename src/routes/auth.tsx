import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, ArrowRight, Check, Eye, EyeOff, Loader2, MailCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { SakuraPetals } from "@/waifu/SakuraParticles";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  head: () => ({
    meta: [
      { title: "The Companion Contract — Youki" },
      {
        name: "description",
        content:
          "Sign the companion contract, or continue as a guest. A quiet anime companion who remembers what matters.",
      },
    ],
  }),
});

type AuthTab = "sign" | "return";

const PROMISES = [
  {
    numeral: "I",
    title: "Presence",
    body: "She listens for the pause, not just the prompt.",
  },
  {
    numeral: "II",
    title: "Memory",
    body: "The small things you tell her are kept close.",
  },
  {
    numeral: "III",
    title: "Privacy",
    body: "Guest memories never leave this browser.",
  },
] as const;

/**
 * The front door.
 *
 * The contract is the concept, but the old screen read like a legal document:
 * a single tall column of articles with the form pushed below the fold. This
 * version treats it as a letter and a form side by side — the promises stay on
 * the left, and the thing you actually came to do stays visible on the right.
 * On a phone the letter compresses to one line and the form comes first.
 */
function AuthPage() {
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const { signIn, signUp, continueAsGuest, mode, loading } = useAuth();

  const [tab, setTab] = useState<AuthTab>("sign");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sealed, setSealed] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  /** Suppresses the "already authenticated" redirect while this form is
      deliberately holding the user on the sealed screen for a moment. */
  const navigatingRef = useRef(false);

  // Already married? The contract page is only for signing.
  useEffect(() => {
    if (!loading && mode === "authenticated" && !navigatingRef.current) {
      void navigate({ to: "/" });
    }
  }, [loading, mode, navigate]);

  const switchTab = useCallback(
    (next: AuthTab) => {
      if (next === tab) return;
      setTab(next);
      setError(null);
      setPassword("");
      setShowPassword(false);
    },
    [tab],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      setSubmitting(true);
      navigatingRef.current = true;
      try {
        const result =
          tab === "sign" ? await signUp(email, password, name) : await signIn(email, password);

        // 'confirm' means email confirmation is required
        if (result === "confirm") {
          navigatingRef.current = false;
          setNeedsConfirm(true);
          setSubmitting(false);
          return;
        }

        if (result) {
          navigatingRef.current = false;
          setError(result);
          setSubmitting(false);
          return;
        }

        setSealed(true);
        window.setTimeout(() => void navigate({ to: "/" }), 2200);
      } catch {
        navigatingRef.current = false;
        setError("Something went wrong on the way in. Try once more.");
        setSubmitting(false);
      }
    },
    [tab, email, password, name, signIn, signUp, navigate],
  );

  const handleGuest = useCallback(() => {
    continueAsGuest();
    void navigate({ to: "/" });
  }, [continueAsGuest, navigate]);

  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-[#070912] text-white">
        <div className="flex items-center gap-3 text-white/45">
          <span className="voice-display text-lg text-[hsl(var(--sakura))]">Y</span>
          <p className="text-[13px]">Opening the door…</p>
        </div>
      </div>
    );
  }
  // Keep the page mounted while the sealed confirmation plays — signing in
  // flips `mode` immediately, and bailing out here would blank the screen for
  // the 2.2s the user is meant to see the contract seal.
  if (mode === "authenticated" && !sealed) return null;

  const signMode = tab === "sign";
  const ease = [0.16, 1, 0.3, 1] as const;

  return (
    <div
      className="glass-ui relative isolate flex min-h-dvh w-full flex-col overflow-x-hidden bg-[#070912] text-white"
      style={{ "--hud-accent": "hsl(var(--sakura))" } as React.CSSProperties}
    >
      {/* Night, blossoms and a moon-gate ring. Atmosphere only — nothing here
          encodes state, so the form remains the only active thing on screen. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_65%_50%_at_50%_-8%,rgba(240,140,160,0.16),transparent_68%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_55%_50%_at_6%_104%,rgba(167,139,250,0.12),transparent_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_45%_40%_at_95%_88%,rgba(103,232,249,0.08),transparent_72%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_34%,rgba(4,5,14,0.82)_100%)]" />
        <div className="absolute left-1/2 top-[46%] h-[30rem] w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/[0.04]" />
        <div className="absolute left-1/2 top-[46%] h-[44rem] w-[44rem] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/[0.025]" />
      </div>

      <SakuraPetals count={10} />

      <header className="relative z-20 mx-auto flex w-full max-w-[62rem] items-center justify-between gap-4 px-5 pb-2 pt-5 sm:px-8 sm:pt-7">
        <div className="flex items-center gap-2.5">
          <span
            className="grid h-8 w-8 place-items-center rounded-full border border-white/10 bg-white/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]"
            aria-hidden
          >
            <span className="voice-display text-[13px] leading-none text-[hsl(var(--sakura))]">
              Y
            </span>
          </span>
          <div>
            <p className="voice-display text-[13px] leading-tight text-white/90">Youki</p>
            <p className="text-[10px] leading-tight text-white/40">
              a companion in the quiet hours
            </p>
          </div>
        </div>
        <p className="hidden text-[9.5px] uppercase tracking-[0.18em] text-white/32 sm:block">
          Private by design
        </p>
      </header>

      <main className="relative z-20 mx-auto flex w-full max-w-[62rem] flex-1 items-center px-4 py-3 sm:px-8 sm:py-8">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 26, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.7, ease }}
          className="relative w-full overflow-hidden rounded-[1.75rem] border border-white/[0.09] bg-[#0a0e1b]/72 shadow-[0_1px_0_rgba(255,255,255,0.08)_inset,0_40px_120px_-44px_rgba(0,0,0,0.95)] backdrop-blur-[32px] backdrop-saturate-150"
        >
          <div className="grid lg:grid-cols-[1.04fr_0.96fr]">
            {/* ── The letter ───────────────────────────────────────────── */}
            <section className="relative flex flex-col justify-between bg-[linear-gradient(155deg,rgba(240,140,160,0.055),transparent_48%)] px-5 pb-4 pt-5 sm:px-9 sm:py-9">
              <div>
                <p className="flex items-center gap-2 text-[9.5px] font-medium uppercase tracking-[0.2em] text-[var(--hud-accent)] opacity-90">
                  <span className="h-1 w-1 rounded-full bg-[var(--hud-accent)]" aria-hidden />
                  The companion contract
                </p>

                <h1 className="voice-display mt-4 text-[1.8rem] leading-[1.08] tracking-[-0.02em] text-white sm:text-[clamp(2rem,4.6vw,2.9rem)]">
                  Not a login.
                  <br />
                  <span className="text-white/52">A small promise.</span>
                </h1>

                <p className="mt-3 hidden max-w-[37ch] text-[13px] leading-relaxed text-white/48 sm:block">
                  Youki keeps the thread of your conversations and the small things you mention.
                  Sign below, or walk in as a guest and decide later.
                </p>
                <p className="mt-3 text-[12.5px] leading-relaxed text-white/48 sm:hidden">
                  Youki remembers the thread of your conversations. Sign below, or wander in as a
                  guest.
                </p>
              </div>

              <div className="mt-6 hidden border-t border-white/[0.07] sm:block">
                {PROMISES.map((promise) => (
                  <div
                    key={promise.numeral}
                    className="flex gap-4 border-b border-white/[0.055] py-2.5"
                  >
                    <span className="voice-display w-5 shrink-0 pt-0.5 text-[10.5px] leading-none text-[var(--hud-accent)] opacity-70">
                      {promise.numeral}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium leading-tight text-white/72">
                        {promise.title}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-white/44">
                        {promise.body}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-end justify-between gap-4 sm:hidden">
                <p className="text-[10.5px] leading-relaxed text-white/44">
                  Presence, memory, privacy — that's the whole contract.
                </p>
                <p className="voice-display shrink-0 text-[14px] italic text-[var(--hud-accent)] opacity-80">
                  — Youki
                </p>
              </div>

              <div className="mt-6 hidden items-end justify-between gap-5 border-t border-white/[0.07] pt-4 sm:flex">
                <p className="max-w-[27ch] text-[10px] leading-relaxed text-white/40">
                  Guest memories live in this browser. Signing keeps them across your devices.
                </p>
                <p className="voice-display shrink-0 text-right text-[15px] italic text-[var(--hud-accent)] opacity-80">
                  — Youki
                </p>
              </div>
            </section>

            {/* ── The form ─────────────────────────────────────────────── */}
            <section className="border-t border-white/[0.07] bg-black/10 px-5 pb-5 pt-6 sm:px-8 sm:py-9 lg:border-l lg:border-t-0">
              <AnimatePresence mode="wait" initial={false}>
                {sealed ? (
                  <motion.div
                    key="sealed"
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.35, ease }}
                    role="status"
                    className="flex h-full min-h-[21rem] flex-col items-center justify-center py-6 text-center"
                  >
                    <div className="relative">
                      <span
                        className="grid h-16 w-16 place-items-center rounded-full border"
                        style={{
                          borderColor:
                            "color-mix(in oklab, var(--hud-accent) 46%, rgba(255,255,255,0.08))",
                          backgroundColor:
                            "color-mix(in oklab, var(--hud-accent) 12%, rgba(255,255,255,0.03))",
                          boxShadow: "0 0 34px -12px var(--hud-accent)",
                        }}
                      >
                        <span className="voice-display text-2xl text-[var(--hud-accent)]">Y</span>
                      </span>
                      <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full bg-[var(--hud-accent)] text-[#1a0b14] ring-4 ring-[#0b0f1d]">
                        <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                      </span>
                    </div>
                    <h2 className="voice-display mt-5 text-[1.6rem] leading-tight text-white">
                      The contract is sealed.
                    </h2>
                    <p className="mt-1.5 text-[12px] text-white/40">
                      Welcome home. Opening the door…
                    </p>
                    <span className="mt-5 flex items-center gap-2 text-[10px] text-white/25">
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      Taking you inside
                    </span>
                  </motion.div>
                ) : needsConfirm ? (
                  <motion.div
                    key="confirm"
                    initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.28, ease }}
                    role="status"
                    className="flex h-full min-h-[21rem] flex-col justify-center py-4 text-center"
                  >
                    <span className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-white/[0.05] text-[var(--hud-accent)]">
                      <MailCheck className="h-5 w-5" aria-hidden />
                    </span>
                    <h2 className="voice-display mt-4 text-[1.45rem] leading-tight text-white">
                      One more step
                    </h2>
                    <p className="mx-auto mt-2 max-w-[32ch] text-[12px] leading-relaxed text-white/45">
                      A confirmation link is on its way to{" "}
                      <strong className="font-medium text-white/75">{email}</strong>. Open it, then
                      come back and sign in.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setNeedsConfirm(false);
                        setTab("return");
                        setPassword("");
                        setError(null);
                      }}
                      className="focus-ring mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--hud-accent)] text-[13px] font-semibold text-[#1a0b14] shadow-[0_10px_30px_-12px_var(--hud-accent)] transition-[transform,filter] hover:brightness-105 active:scale-[0.99]"
                    >
                      Return to sign in
                      <ArrowRight className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNeedsConfirm(false);
                        setTab("sign");
                        setPassword("");
                      }}
                      className="focus-ring mt-2 h-9 rounded-lg px-3 text-[11px] text-white/35 transition-colors hover:text-white/70"
                    >
                      Use a different email
                    </button>
                  </motion.div>
                ) : (
                  <motion.div
                    key={`form-${tab}`}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.24, ease }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2
                          id="contract-form-title"
                          className="voice-display text-[1.4rem] leading-tight text-white"
                        >
                          {signMode ? "Sign the contract" : "Welcome back"}
                        </h2>
                        <p className="mt-1 text-[11px] leading-relaxed text-white/46">
                          {signMode
                            ? "A name, an email, and you're through the door."
                            : "The door was never locked."}
                        </p>
                      </div>
                      <span className="mt-1 shrink-0 rounded-full border border-white/[0.07] px-2 py-0.5 text-[9px] uppercase tracking-[0.14em] text-white/25">
                        Form {signMode ? "I" : "II"}
                      </span>
                    </div>

                    <div
                      role="group"
                      aria-label="Contract type"
                      className="mt-4 flex gap-1 rounded-xl border border-white/[0.06] bg-black/25 p-1"
                    >
                      <button
                        type="button"
                        aria-pressed={signMode}
                        onClick={() => switchTab("sign")}
                        className={cn(
                          "focus-ring flex-1 rounded-lg px-3 py-2 text-[11.5px] font-medium transition-colors",
                          signMode
                            ? "bg-white/[0.09] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]"
                            : "text-white/45 hover:text-white/70",
                        )}
                      >
                        New contract
                      </button>
                      <button
                        type="button"
                        aria-pressed={!signMode}
                        onClick={() => switchTab("return")}
                        className={cn(
                          "focus-ring flex-1 rounded-lg px-3 py-2 text-[11.5px] font-medium transition-colors",
                          !signMode
                            ? "bg-white/[0.09] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]"
                            : "text-white/45 hover:text-white/70",
                        )}
                      >
                        Returning
                      </button>
                    </div>

                    <form
                      onSubmit={handleSubmit}
                      aria-labelledby="contract-form-title"
                      className="mt-4 space-y-3"
                    >
                      {signMode && (
                        <div>
                          <label
                            htmlFor="contract-name"
                            className="mb-1.5 block text-[11px] font-medium text-white/52"
                          >
                            Your name
                          </label>
                          <input
                            id="contract-name"
                            name="name"
                            type="text"
                            autoComplete="name"
                            maxLength={40}
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="What should she call you?"
                            className="set-input h-11 px-3.5 text-[13px]"
                          />
                        </div>
                      )}

                      <div>
                        <label
                          htmlFor="contract-email"
                          className="mb-1.5 block text-[11px] font-medium text-white/52"
                        >
                          Email
                        </label>
                        <input
                          id="contract-email"
                          name="email"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          autoCapitalize="none"
                          spellCheck={false}
                          required
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="you@example.com"
                          className="set-input h-11 px-3.5 text-[13px]"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="contract-password"
                          className="mb-1.5 block text-[11px] font-medium text-white/52"
                        >
                          Password
                        </label>
                        <div className="relative">
                          <input
                            id="contract-password"
                            name="password"
                            type={showPassword ? "text" : "password"}
                            autoComplete={signMode ? "new-password" : "current-password"}
                            required
                            minLength={6}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={signMode ? "At least 6 characters" : "Your password"}
                            className="set-input h-11 px-3.5 pr-11 text-[13px]"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((v) => !v)}
                            aria-label={showPassword ? "Hide password" : "Show password"}
                            aria-pressed={showPassword}
                            title={showPassword ? "Hide password" : "Show password"}
                            className="focus-ring absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-white/32 transition-colors hover:bg-white/[0.06] hover:text-white/80"
                          >
                            {showPassword ? (
                              <EyeOff className="h-4 w-4" aria-hidden />
                            ) : (
                              <Eye className="h-4 w-4" aria-hidden />
                            )}
                          </button>
                        </div>
                      </div>

                      {error && (
                        <p
                          role="alert"
                          className="flex items-start gap-2 rounded-lg border border-red-400/15 bg-red-500/[0.08] px-3 py-2 text-[11px] leading-snug text-red-200"
                        >
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span>{error}</span>
                        </p>
                      )}

                      <button
                        type="submit"
                        disabled={submitting}
                        className="focus-ring mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--hud-accent)] text-[13px] font-semibold text-[#1a0b14] shadow-[0_10px_30px_-12px_var(--hud-accent)] transition-[transform,filter] hover:brightness-105 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        {submitting ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                            Sealing…
                          </>
                        ) : (
                          <>
                            {signMode ? "Sign & enter" : "Return & enter"}
                            <ArrowRight className="h-4 w-4" aria-hidden />
                          </>
                        )}
                      </button>
                    </form>

                    <div className="mt-4 border-t border-white/[0.06] pt-2">
                      <button
                        type="button"
                        onClick={handleGuest}
                        className="focus-ring flex h-9 w-full items-center justify-center gap-2 rounded-lg text-[11.5px] text-white/48 transition-colors hover:bg-white/[0.05] hover:text-white/85"
                      >
                        Just looking? Enter as a guest
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <p className="text-center text-[10px] leading-relaxed text-white/42">
                        No account, no pressure. Memories stay on this device.
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          </div>
        </motion.div>
      </main>

      <footer className="relative z-20 mx-auto hidden w-full max-w-[62rem] px-5 pb-4 text-[10px] text-white/30 sm:block sm:px-8 sm:pb-6">
        <div className="flex items-center justify-between gap-4">
          <p>Your conversations are yours. Guests keep everything on this device.</p>
          <p className="hidden shrink-0 sm:block">Made for the quiet hours.</p>
        </div>
      </footer>
    </div>
  );
}
