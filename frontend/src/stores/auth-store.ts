import { create } from "zustand";
import { consumeLegacyToken, sessionFetch } from "@/utils/auth";

interface SessionProfile {
  username?: unknown;
  nickname?: unknown;
  avatar_path?: unknown;
  role?: unknown;
}

interface AuthState {
  username: string | null;
  nickname: string | null;
  avatarPath: string | null;
  role: "admin" | "member" | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  initialize: () => void;
  login: (
    username: string,
    role?: "admin" | "member" | null,
    nickname?: string | null,
    avatarPath?: string | null,
  ) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  username: null,
  nickname: null,
  avatarPath: null,
  role: null,
  isAuthenticated: false,
  isLoading: true,

  initialize: () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    void (async () => {
      try {
        let response = await sessionFetch("/api/v1/auth/me", { signal: controller.signal });
        if (response.status === 401) {
          const legacyToken = consumeLegacyToken();
          if (legacyToken) {
            response = await sessionFetch("/api/v1/auth/session/exchange", {
              method: "POST",
              headers: { Authorization: `Bearer ${legacyToken}` },
              signal: controller.signal,
            });
          }
        }

        let profile: SessionProfile | null = null;
        if (response.ok) {
          profile = (await response.json()) as SessionProfile;
        } else if (response.status !== 401) {
          throw new Error(`status ${response.status}`);
        }

        if (profile) {
          set({
            username: typeof profile.username === "string" ? profile.username : null,
            nickname: typeof profile.nickname === "string" && profile.nickname ? profile.nickname : null,
            avatarPath: typeof profile.avatar_path === "string" && profile.avatar_path ? profile.avatar_path : null,
            role: profile.role === "admin" || profile.role === "member" ? profile.role : null,
            isAuthenticated: true,
          });
          return;
        }
        const status = await fetch("/api/v1/auth/status", { signal: controller.signal });
        if (!status.ok) throw new Error(`status ${status.status}`);
        const payload = (await status.json()) as { enabled?: unknown };
        if (payload.enabled === false) set({ isAuthenticated: true });
      } catch (err: unknown) {
        console.warn("[auth] session bootstrap failed; defaulting to login", err);
      } finally {
        clearTimeout(timeoutId);
        set({ isLoading: false });
      }
    })();
  },

  login: (username, role = null, nickname = null, avatarPath = null) => {
    set({ username, nickname, avatarPath, role, isAuthenticated: true, isLoading: false });
  },

  logout: () => {
    void sessionFetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    set({
      username: null,
      nickname: null,
      avatarPath: null,
      role: null,
      isAuthenticated: false,
    });
  },

  setLoading: (isLoading) => set({ isLoading }),
}));
