import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { getSupabase, supabase, supabaseCall } from "./supabase";
import { storageBridge, type StorageMode } from "./storageBridge";
import type { User } from "@supabase/supabase-js";

interface Profile {
  username: string;
  avatar_url: string;
}

export interface AuthContextType {
  user: User | null;
  mode: StorageMode;
  loading: boolean;
  profile: Profile;
  signIn: (email: string, password: string) => Promise<string | null>;
  /** Returns null on success, "confirm" when email verification is required, or an error message. */
  signUp: (
    email: string,
    password: string,
    username?: string,
  ) => Promise<string | null | "confirm">;
  signOut: () => Promise<void>;
  continueAsGuest: () => void;
  updateProfile: (data: Partial<Profile>) => Promise<void>;
  divorce: () => Promise<void>;
}

const AUTH_STORAGE_KEY = "waifu.auth.v1";
/**
 * Name entered on the contract before email confirmation. Supabase RLS only
 * allows a signed-in user to write their profile row, so the name is stashed
 * here and flushed into `profiles` on the first authenticated session.
 */
const PENDING_NAME_KEY = "waifu.pendingName.v1";

/** Best-effort profile write — never blocks login UX on failure. */
async function upsertUsername(userId: string, username: string): Promise<void> {
  if (!username.trim()) return;
  await supabaseCall(
    () =>
      getSupabase()
        .from("profiles")
        .upsert(
          { id: userId, username: username.trim(), updated_at: new Date().toISOString() },
          { onConflict: "id" },
        )
        .then(() => undefined),
    undefined,
  );
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState<StorageMode>("guest");
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile>({ username: "", avatar_url: "" });

  const loadProfile = useCallback(async (userId: string) => {
    const data = await supabaseCall(
      () =>
        getSupabase()
          .from("profiles")
          .select("username, avatar_url")
          .eq("id", userId)
          .maybeSingle()
          .then((r) => r.data),
      null,
    );
    if (data) {
      setProfile({ username: data.username ?? "", avatar_url: data.avatar_url ?? "" });
    }
    // A name entered before email confirmation lands in the profile now.
    const pendingName = localStorage.getItem(PENDING_NAME_KEY);
    if (pendingName) {
      localStorage.removeItem(PENDING_NAME_KEY);
      if (!data?.username) {
        setProfile((p) => ({ ...p, username: pendingName }));
        void upsertUsername(userId, pendingName);
      }
    }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTH_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.mode === "guest") {
          setMode("guest");
          storageBridge.setMode("guest");
        }
      }
    } catch {
      /* ignore */
    }

    // Bounded session restore — if Supabase is unreachable (dead DNS, paused
    // project, offline) this resolves as "no session" instead of hanging the
    // whole app on the loading screen. The user keeps browsing in guest mode.
    supabaseCall(() => getSupabase().auth.getSession(), null)
      .then((result) => {
        const session = result?.data?.session ?? null;
        if (session?.user) {
          setUser(session.user);
          setMode("authenticated");
          storageBridge.setMode("authenticated");
          localStorage.removeItem(AUTH_STORAGE_KEY);
          loadProfile(session.user.id);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));

    // Without Supabase configured there is no auth channel to subscribe to.
    // Session restore above already resolved to "no session" and switched the
    // app to guest mode, so skip the listener instead of crashing.
    let unsubscribe: (() => void) | undefined;
    if (supabase) {
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user) {
          setUser(session.user);
          setMode("authenticated");
          storageBridge.setMode("authenticated");
          localStorage.removeItem(AUTH_STORAGE_KEY);
          loadProfile(session.user.id);
        }
      });
      unsubscribe = () => subscription.unsubscribe();
    }

    return () => unsubscribe?.();
  }, [loadProfile]);

  const AUTH_UNREACHABLE = "Can't reach the auth service — check your connection and try again.";

  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    const result = await supabaseCall(
      () => getSupabase().auth.signInWithPassword({ email, password }),
      null,
    );
    if (!result) return AUTH_UNREACHABLE;
    const { data, error } = result;
    if (error) return error.message;
    if (data.session) {
      setUser(data.user);
      setMode("authenticated");
      storageBridge.setMode("authenticated");
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
    return null;
  }, []);

  const signUp = useCallback(
    async (
      email: string,
      password: string,
      username?: string,
    ): Promise<string | null | "confirm"> => {
      const result = await supabaseCall(() => getSupabase().auth.signUp({ email, password }), null);
      if (!result) return AUTH_UNREACHABLE;
      const { data, error } = result;
      if (error) return error.message;
      // If session exists (email confirmation disabled), log in immediately
      if (data.session && data.user) {
        setUser(data.user);
        setMode("authenticated");
        storageBridge.setMode("authenticated");
        localStorage.removeItem(AUTH_STORAGE_KEY);
        // Persist the name from the contract right away.
        if (username?.trim()) {
          setProfile((p) => ({ ...p, username: username.trim() }));
          void upsertUsername(data.user!.id, username);
        }
        return null;
      }
      // Email confirmation required — remember the name for the first login.
      if (username?.trim()) {
        try {
          localStorage.setItem(PENDING_NAME_KEY, username.trim());
        } catch {
          /* ignore */
        }
      }
      return "confirm";
    },
    [],
  );

  const signOut = useCallback(async () => {
    // Best-effort server-side sign-out — local state is cleared regardless so
    // an unreachable Supabase can never trap the user as "logged in".
    await supabaseCall(() => getSupabase().auth.signOut(), null);
    setUser(null);
    setMode("guest");
    storageBridge.setMode("guest");
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }, []);

  const continueAsGuest = useCallback(() => {
    setUser(null);
    setMode("guest");
    storageBridge.setMode("guest");
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ mode: "guest" }));
  }, []);

  const updateProfile = useCallback(
    async (data: Partial<Profile>) => {
      if (!user) return;
      const updates: Record<string, string> = {};
      if (data.username !== undefined) updates.username = data.username;
      if (data.avatar_url !== undefined) updates.avatar_url = data.avatar_url;
      if (Object.keys(updates).length === 0) return;
      await supabaseCall(
        () =>
          getSupabase()
            .from("profiles")
            .upsert(
              { id: user.id, ...updates, updated_at: new Date().toISOString() },
              { onConflict: "id" },
            )
            .then(() => undefined),
        undefined,
      );
      setProfile((p) => ({ ...p, ...data }));
    },
    [user],
  );

  const divorce = useCallback(async () => {
    if (!user) return;
    // Purge all user data (best-effort — never throws or hangs)
    await supabaseCall(
      () =>
        Promise.all([
          getSupabase().from("favorite_moments").delete().eq("user_id", user.id),
          getSupabase().from("friendship_log").delete().eq("user_id", user.id),
          getSupabase().from("chat_messages").delete().eq("user_id", user.id),
          getSupabase().from("settings").delete().eq("user_id", user.id),
          getSupabase().from("profiles").delete().eq("id", user.id),
        ]).then(() => undefined),
      undefined,
    );
    await signOut();
    setProfile({ username: "", avatar_url: "" });
  }, [user, signOut]);

  return (
    <AuthContext.Provider
      value={{
        user,
        mode,
        loading,
        profile,
        signIn,
        signUp,
        signOut,
        continueAsGuest,
        updateProfile,
        divorce,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    if (typeof window === "undefined") {
      // Safe fallback for SSR passes where Context isn't fully mounted
      return {
        user: null,
        mode: "guest",
        loading: true,
        profile: { username: "", avatar_url: "" },
        signIn: async () => null,
        signUp: async () => null,
        signOut: async () => {},
        continueAsGuest: () => {},
        updateProfile: async () => {},
        divorce: async () => {},
      };
    }
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
