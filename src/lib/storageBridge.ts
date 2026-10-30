import { getSupabase, supabaseCall } from "./supabase";
import type { Settings, AiState } from "@/waifu/types";
import type { ChatMsg } from "@/waifu/aiEngine";
import { DEFAULT_SETTINGS } from "@/waifu/types";

const STORAGE_KEY = "waifu.settings.v1";

export type StorageMode = "guest" | "authenticated";

export class StorageBridge {
  private mode: StorageMode = "guest";
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSettings: Settings | null = null;

  setMode(mode: StorageMode) {
    if (mode !== this.mode) this.flushSettings();
    this.mode = mode;
  }

  getMode(): StorageMode {
    return this.mode;
  }

  // ── Settings ──────────────────────────────────────────────

  async loadSettings(): Promise<Settings> {
    if (this.mode === "guest") return this.loadLocal();
    return this.loadSupabase();
  }

  async saveSettings(settings: Settings): Promise<void> {
    if (this.mode === "guest") {
      // Local writes are cheap and must land immediately.
      this.saveLocal(settings);
      return;
    }
    // Authenticated: coalesce rapid changes (slider drags, toggles) into a
    // single upsert instead of firing a request per state change.
    this.pendingSettings = settings;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const next = this.pendingSettings;
      this.pendingSettings = null;
      if (next) void this.saveSupabase(next);
    }, 700);
  }

  /** Persist any debounced settings before a mode switch (e.g. sign-out). */
  private flushSettings(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const next = this.pendingSettings;
    this.pendingSettings = null;
    if (next && this.mode === "authenticated") void this.saveSupabase(next);
  }

  private loadLocal(): Settings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_SETTINGS;
      const saved = JSON.parse(raw);
      delete saved.pitch;
      delete saved.rate;
      return { ...DEFAULT_SETTINGS, ...saved } as Settings;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  private saveLocal(settings: Settings): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  /** Resolve the current user, or null when Supabase is unreachable/hanging. */
  private async getUserOrNull() {
    const result = await supabaseCall(() => getSupabase().auth.getUser(), null);
    return result?.data?.user ?? null;
  }

  private async loadSupabase(): Promise<Settings> {
    const user = await this.getUserOrNull();
    if (!user) return DEFAULT_SETTINGS;
    const data = await supabaseCall(
      () =>
        getSupabase()
          .from("settings")
          .select("data")
          .eq("user_id", user.id)
          .maybeSingle()
          .then((r) => r.data),
      null,
    );
    if (data?.data) {
      return { ...DEFAULT_SETTINGS, ...(data.data as Partial<Settings>) };
    }
    return DEFAULT_SETTINGS;
  }

  private async saveSupabase(settings: Settings): Promise<void> {
    const user = await this.getUserOrNull();
    if (!user) return;
    await supabaseCall(
      () =>
        getSupabase()
          .from("settings")
          .upsert({ user_id: user.id, data: settings }, { onConflict: "user_id" })
          .then(() => undefined),
      undefined,
    );
  }

  // ── Chat messages ─────────────────────────────────────────

  /** Best-effort TTL: drop this user's chat rows older than 24 hours. */
  private async purgeOldMessages(userId: string): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabaseCall(
      () =>
        getSupabase()
          .from("chat_messages")
          .delete()
          .eq("user_id", userId)
          .lt("created_at", cutoff)
          .then(() => undefined),
      undefined,
    );
  }

  async saveMessage(msg: ChatMsg): Promise<void> {
    if (this.mode !== "authenticated") return;
    const user = await this.getUserOrNull();
    if (!user) return;
    await supabaseCall(
      () =>
        getSupabase()
          .from("chat_messages")
          .insert({ user_id: user.id, role: msg.role, content: msg.content })
          .then(() => undefined),
      undefined,
    );
    void this.purgeOldMessages(user.id);
  }

  async loadMessages(): Promise<ChatMsg[]> {
    if (this.mode !== "authenticated") return [];
    const user = await this.getUserOrNull();
    if (!user) return [];
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const data = await supabaseCall(
      () =>
        getSupabase()
          .from("chat_messages")
          .select("role, content, created_at")
          .eq("user_id", user.id)
          .gt("created_at", cutoff)
          .order("created_at", { ascending: true })
          .limit(100)
          .then((r) => r.data),
      null,
    );
    const rows = (data ?? []) as Array<{
      role: string;
      content: string;
      created_at?: string | null;
    }>;
    return rows
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) => ({
        role: r.role as ChatMsg["role"],
        content: r.content,
        ts: r.created_at ? Date.parse(r.created_at) : undefined,
      }));
  }

  // ── Friendship log ────────────────────────────────────────

  async saveFriendship(state: AiState): Promise<void> {
    if (this.mode !== "authenticated") return;
    const user = await this.getUserOrNull();
    if (!user) return;
    await supabaseCall(
      () =>
        getSupabase()
          .from("friendship_log")
          .insert({
            user_id: user.id,
            friendship: state.friendship,
            trust: state.trust,
            respect: state.respect,
            emotion: state.emotion,
          })
          .then(() => undefined),
      undefined,
    );
  }

  // ── Favorite moments ──────────────────────────────────────

  async saveFavoriteMoment(params: {
    chatMessageId?: string;
    note?: string;
    waifuEmotion?: string;
    waifuState?: string;
  }): Promise<void> {
    if (this.mode !== "authenticated") return;
    const user = await this.getUserOrNull();
    if (!user) return;
    await supabaseCall(
      () =>
        getSupabase()
          .from("favorite_moments")
          .insert({
            user_id: user.id,
            chat_message_id: params.chatMessageId ?? null,
            note: params.note ?? null,
            waifu_emotion: params.waifuEmotion ?? null,
            waifu_state: params.waifuState ?? null,
          })
          .then(() => undefined),
      undefined,
    );
  }

  async loadFavoriteMoments() {
    if (this.mode !== "authenticated") return [];
    const user = await this.getUserOrNull();
    if (!user) return [];
    const data = await supabaseCall(
      () =>
        getSupabase()
          .from("favorite_moments")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .then((r) => r.data),
      null,
    );
    return data ?? [];
  }
}

export const storageBridge = new StorageBridge();
