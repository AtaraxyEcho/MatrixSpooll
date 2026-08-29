import { create } from "zustand";
import { consumeLegacyToken, sessionFetch } from "@/utils/auth";

interface SessionProfile {
  id?: unknown;
  username?: unknown;
  nickname?: unknown;
  avatar_path?: unknown;
  role?: unknown;
  is_superadmin?: unknown;
}

export type SessionEndReason = "replaced" | "revoked" | "expired" | "invalid";

interface AuthState {
  id: string | null;
  username: string | null;
  nickname: string | null;
  avatarPath: string | null;
  role: "admin" | "member" | null;
  isSuperadmin: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionEndReason: SessionEndReason | null;
  initialize: () => void;
  login: (
    username: string,
    role?: "admin" | "member" | null,
    nickname?: string | null,
    avatarPath?: string | null,
    id?: string | null,
    isSuperadmin?: boolean,
  ) => void;
  logout: () => void;
  endSession: (reason: SessionEndReason) => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  id: null,
  username: null,
  nickname: null,
  avatarPath: null,
  role: null,
  isSuperadmin: false,
  isAuthenticated: false,
  isLoading: true,
  sessionEndReason: null,

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
            id: typeof profile.id === "string" ? profile.id : null,
            username: typeof profile.username === "string" ? profile.username : null,
            nickname: typeof profile.nickname === "string" && profile.nickname ? profile.nickname : null,
            avatarPath: typeof profile.avatar_path === "string" && profile.avatar_path ? profile.avatar_path : null,
            role: profile.role === "admin" || profile.role === "member" ? profile.role : null,
            isSuperadmin: profile.is_superadmin === true,
            isAuthenticated: true,
            sessionEndReason: null,
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

  login: (username, role = null, nickname = null, avatarPath = null, id = null, isSuperadmin = false) => {
    set({
      id,
      username,
      nickname,
      avatarPath,
      role,
      isSuperadmin,
      isAuthenticated: true,
      isLoading: false,
      sessionEndReason: null,
    });
  },

  logout: () => {
    void sessionFetch("/api/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    set({
      username: null,
      nickname: null,
      avatarPath: null,
      role: null,
      isAuthenticated: false,
      sessionEndReason: null,
    });
  },

  endSession: (sessionEndReason) => {
    set({
      id: null,
      username: null,
      nickname: null,
      avatarPath: null,
      role: null,
      isSuperadmin: false,
      isAuthenticated: false,
      isLoading: false,
      sessionEndReason,
    });
  },

  setLoading: (isLoading) => set({ isLoading }),
}));
