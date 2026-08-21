import { create } from "zustand";
import { getToken, setToken as saveToken, clearToken } from "@/utils/auth";

interface AuthState {
  token: string | null;
  username: string | null;
  nickname: string | null;
  avatarPath: string | null;
  role: "admin" | "member" | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  initialize: () => void;
  login: (
    token: string,
    username: string,
    role?: "admin" | "member" | null,
    nickname?: string | null,
    avatarPath?: string | null,
  ) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  username: null,
  nickname: null,
  avatarPath: null,
  role: null,
  isAuthenticated: false,
  isLoading: true,

  initialize: () => {
    const token = getToken();
    if (token) {
      set({ token, isAuthenticated: true, isLoading: false });
      // 刷新后 token 仍在但 username/role 已丢（未持久化），经 /auth/me 回填——
      // 顶栏用户菜单（UserMenu）依赖身份与角色渲染。失败静默降级：仅不显示
      // 用户名/角色徽标，不阻断进入主界面。
      void fetch("/api/v1/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`status ${res.status}`);
          const payload = (await res.json()) as {
            username?: unknown;
            nickname?: unknown;
            avatar_path?: unknown;
            role?: unknown;
          };
          set({
            username: typeof payload.username === "string" ? payload.username : null,
            nickname:
              typeof payload.nickname === "string" && payload.nickname.length > 0
                ? payload.nickname
                : null,
            avatarPath:
              typeof payload.avatar_path === "string" && payload.avatar_path.length > 0
                ? payload.avatar_path
                : null,
            role: payload.role === "admin" || payload.role === "member" ? payload.role : null,
          });
        })
        .catch(() => {
          // 网络异常 / 后端未就绪 / token 失效：保持已登录状态，身份字段留空
        });
      return;
    }
    // 无 token 时先问后端是否启用了鉴权。`AUTH_ENABLED=false` 时后端全链路
    // bypass，前端也应该跳过登录页直接进主界面。超时 / 网络异常 / 响应 shape
    // 异常时 fail-closed 退回到登录页，避免误把损坏响应当成"无需鉴权"放行。
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    fetch("/api/v1/auth/status", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const payload: unknown = await res.json();
        if (
          typeof payload !== "object" ||
          payload === null ||
          typeof (payload as { enabled?: unknown }).enabled !== "boolean"
        ) {
          throw new Error("invalid /auth/status payload");
        }
        const { enabled } = payload as { enabled: boolean };
        if (!enabled) {
          set({ isAuthenticated: true });
        }
      })
      .catch((err) => {
        console.warn("[auth] /auth/status fetch failed; defaulting to login", err);
      })
      .finally(() => {
        clearTimeout(timeoutId);
        set({ isLoading: false });
      });
  },

  login: (token, username, role = null, nickname = null, avatarPath = null) => {
    saveToken(token);
    set({ token, username, nickname, avatarPath, role, isAuthenticated: true, isLoading: false });
  },

  logout: () => {
    const token = getToken();
    if (token) {
      void fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    clearToken();
    set({
      token: null,
      username: null,
      nickname: null,
      avatarPath: null,
      role: null,
      isAuthenticated: false,
    });
  },

  setLoading: (isLoading) => set({ isLoading }),
}));
