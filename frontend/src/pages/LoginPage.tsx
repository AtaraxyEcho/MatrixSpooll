import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import { useAutoFocus } from "@/hooks/useAutoFocus";
import { errMsg, voidPromise } from "@/utils/async";
import { Link, useLocation, useSearch } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { safeReturnPath } from "@/utils/safe-url";
import { getDeviceId } from "@/utils/auth";
import { BRAND } from "@/branding";
import { ROUTE_ADMIN_LOGIN, ROUTE_ADMIN_MANAGER, ROUTE_APP } from "@/app-routes";
import type { LoginResponse, ErrorResponse } from "@/api";
import { FieldLabel } from "@/components/ui/FieldLabel";
import {
  ACCENT_BTN_CLS,
  ACCENT_BUTTON_STYLE,
  CARD_STYLE,
  INPUT_CLS,
  ambientGlowStyle,
  posterGridStyle,
} from "@/components/ui/darkroom-tokens";

const POSTER_GRID_STYLE = posterGridStyle({ size: 44, maskShape: "60% 60% at 50% 35%", opacity: 0.05 });
const AMBIENT_GLOW_STYLE = ambientGlowStyle();

export function LoginPage({ adminOnly = false }: { adminOnly?: boolean }) {
  const { t, i18n } = useTranslation(["common", "auth", "admin"]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [, setLocation] = useLocation();
  const search = useSearch();
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const usernameRef = useAutoFocus<HTMLInputElement>();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const body = new URLSearchParams({
        username,
        password,
        grant_type: "password",
        device_id: getDeviceId(),
      });
      const resp = await fetch("/api/v1/auth/token", {
        method: "POST",
        headers: {
          "Accept-Language": i18n.language || "zh",
        },
        body,
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as Partial<ErrorResponse>;
        const detail = data.detail;
        throw new Error(typeof detail === "string" ? detail : t("auth:login_failed"));
      }

      const data = await resp.json() as LoginResponse;
      const role = data.role ?? null;
      if (adminOnly && role !== "admin") {
        logout();
        throw new Error(t("admin:admin_required"));
      }
      login(data.access_token, data.username ?? username, role);
      const returnTo = safeReturnPath(new URLSearchParams(search).get("from"));
      setLocation(returnTo ?? (adminOnly ? ROUTE_ADMIN_MANAGER : ROUTE_APP));
    } catch (err) {
      setError(errMsg(err, t("auth:login_failed")));
    } finally {
      setLoading(false);
    }
  };

  const loginForm = (
    <form onSubmit={voidPromise(handleSubmit)} className="space-y-4">
      <div>
        <FieldLabel htmlFor="login-username" required>
          {t("auth:username")}
        </FieldLabel>
        <input
          id="login-username"
          type="text"
          autoComplete="username"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={INPUT_CLS}
          ref={usernameRef}
          required
        />
      </div>

      <div>
        <FieldLabel htmlFor="login-password" required>
          {t("auth:password")}
        </FieldLabel>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={INPUT_CLS}
          required
        />
      </div>

      {error && (
        <p role="alert" aria-live="polite" className="text-sm text-warm-bright">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className={`${ACCENT_BTN_CLS} w-full justify-center`}
        style={ACCENT_BUTTON_STYLE}
      >
        {loading && <Loader2 aria-hidden className="h-4 w-4 motion-safe:animate-spin" />}
        {loading ? t("auth:logging_in") : t("auth:login")}
      </button>
    </form>
  );

  if (adminOnly) {
    return (
      <div data-testid="login-page" className="relative min-h-screen overflow-hidden bg-bg text-text">
        <div aria-hidden className="pointer-events-none absolute inset-0" style={AMBIENT_GLOW_STYLE} />
        <div aria-hidden className="pointer-events-none absolute inset-0" style={POSTER_GRID_STYLE} />

        <div className="relative mx-auto grid min-h-screen w-full max-w-6xl gap-0 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(260px,0.75fr)_minmax(380px,1fr)] lg:py-8">
          <aside className="hidden flex-col justify-between border-r border-hairline-soft pr-12 lg:flex">
            <Link href="/login" className="inline-flex w-fit items-center gap-2 text-xs text-text-4 transition-colors hover:text-text">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {t("admin:return_to_workspace_login")}
            </Link>
            <div className="max-w-xs">
              <div className="mb-7 flex h-12 w-12 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent-2">
                <ShieldCheck className="h-6 w-6" aria-hidden />
              </div>
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-accent-2">{t("admin:admin_login_marker")}</div>
              <h1 className="font-editorial mt-3 text-5xl leading-[0.95] tracking-tight text-text">{t("admin:admin_login_title")}</h1>
              <p className="mt-5 text-sm leading-6 text-text-3">{t("admin:admin_login_description")}</p>
            </div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-4">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" aria-hidden />
              <span>{BRAND.name}</span>
            </div>
          </aside>

          <main className="flex items-center justify-center py-6 lg:px-16">
            <div className="w-full max-w-md rounded-xl border border-hairline p-7 shadow-2xl sm:p-9" style={CARD_STYLE}>
              <div className="mb-7 flex items-center gap-3 lg:hidden">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent-2">
                  <ShieldCheck className="h-5 w-5" aria-hidden />
                </div>
                <div>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-accent-2">{t("admin:admin_portal")}</div>
                  <h1 className="font-editorial mt-0.5 text-2xl text-text">{t("admin:admin_login_title")}</h1>
                </div>
              </div>
              <div className="mb-6 hidden text-center lg:block">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-text-4">{t("admin:admin_portal")}</div>
                <h1 className="font-editorial mt-1 flex items-center justify-center gap-2 text-[28px] tracking-tight text-text">
                  <img src="/logo.jpg" alt="" aria-hidden className="h-7 w-7 rounded-md object-contain" />
                  <span>{BRAND.name}</span>
                </h1>
              </div>
              {loginForm}
              <Link href="/login" className="mt-6 inline-flex items-center gap-2 text-xs text-text-4 transition-colors hover:text-text lg:hidden">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                {t("admin:return_to_workspace_login")}
              </Link>
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="login-page"
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg px-4 py-16 text-text sm:px-6"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0" style={AMBIENT_GLOW_STYLE} />
      <div aria-hidden className="pointer-events-none absolute inset-0" style={POSTER_GRID_STYLE} />

      <div
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-hairline p-7 shadow-2xl sm:p-9"
        style={CARD_STYLE}
      >
        <Link
          href={ROUTE_ADMIN_LOGIN}
          title={t("admin:admin_entry_hint")}
          className="absolute right-5 top-5 inline-flex items-center gap-1.5 rounded-md border border-accent/45 bg-accent/10 px-2.5 py-1.5 text-[11px] text-accent-2 shadow-[0_0_22px_-14px_var(--color-accent-glow)] transition-all duration-200 ease-out hover:border-accent/75 hover:bg-accent/15 hover:text-text hover:shadow-[0_0_24px_-8px_var(--color-accent-glow)] motion-safe:hover:scale-105 focus-visible:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg motion-reduce:transition-none"
        >
          <ShieldCheck className="h-3.5 w-3.5 text-accent-2" aria-hidden />
          <span>{t("admin:admin_entry")}</span>
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>

        <div className="mb-8 pr-24">
          <div className="mb-5 flex items-center gap-3">
            <img src="/logo.jpg" alt="" aria-hidden className="h-10 w-10 rounded-xl object-contain shadow-[0_0_20px_-8px_var(--color-accent-glow)]" />
            <div>
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-accent-2">{t("auth:workspace_kicker")}</div>
              <div className="mt-1 text-xs text-text-4">{BRAND.name}</div>
            </div>
          </div>
          <h1 className="font-editorial text-[34px] leading-none tracking-tight text-text sm:text-[38px]">{t("auth:workspace_title")}</h1>
          <p className="mt-3 max-w-[270px] text-sm leading-6 text-text-3">{t("auth:workspace_description")}</p>
        </div>

        {loginForm}
        <div className="mt-7 flex items-center gap-2 border-t border-hairline-soft pt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-text-4">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" aria-hidden />
          <span>{t("auth:workspace_kicker")}</span>
        </div>
      </div>
    </div>
  );
}
