import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { KeyRound, Loader2, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { getToken } from "@/utils/auth";
import { API } from "@/api";
import { FieldLabel } from "@/components/ui/FieldLabel";
import { ACCENT_BTN_CLS, ACCENT_BUTTON_STYLE, CARD_STYLE, INPUT_CLS } from "@/components/ui/darkroom-tokens";

async function readError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => ({})) as { detail?: unknown };
  return new Error(typeof payload.detail === "string" ? payload.detail : fallback);
}

export function AccountSecuritySection() {
  const { t, i18n } = useTranslation(["common", "dashboard"]);
  const token = useAuthStore((state) => state.token) ?? getToken();
  const storedNickname = useAuthStore((state) => state.nickname);
  const storedAvatar = useAuthStore((state) => state.avatarPath);
  const storedUsername = useAuthStore((state) => state.username);
  const [nickname, setNickname] = useState(storedNickname ?? "");
  const [savingNickname, setSavingNickname] = useState(false);
  const [nicknameError, setNicknameError] = useState("");
  const [nicknameSuccess, setNicknameSuccess] = useState(false);
  const [avatarPath, setAvatarPath] = useState(storedAvatar);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [avatarSuccess, setAvatarSuccess] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleNicknameSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setNicknameError("");
    setNicknameSuccess(false);
    if (!token) {
      setNicknameError(t("dashboard:nickname_save_failed"));
      return;
    }
    setSavingNickname(true);
    try {
      const response = await fetch("/api/v1/auth/me", {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Accept-Language": i18n.language || "zh",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ nickname: nickname.trim() || null }),
      });
      if (!response.ok) throw await readError(response, t("dashboard:nickname_save_failed"));
      const payload = (await response.json()) as { nickname?: unknown };
      const next =
        typeof payload.nickname === "string" && payload.nickname.length > 0
          ? payload.nickname
          : null;
      useAuthStore.setState({ nickname: next });
      setNickname(next ?? "");
      setNicknameSuccess(true);
    } catch (err) {
      setNicknameError(err instanceof Error ? err.message : t("dashboard:nickname_save_failed"));
    } finally {
      setSavingNickname(false);
    }
  };

  const handleAvatarUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !token) return;
    setAvatarError("");
    setAvatarSuccess(false);
    setAvatarUploading(true);
    try {
      const form = new FormData();
      form.append("avatar", file);
      const response = await fetch("/api/v1/auth/me/avatar", {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Accept-Language": i18n.language || "zh",
          Authorization: `Bearer ${token}`,
        },
        body: form,
      });
      if (!response.ok) throw await readError(response, t("dashboard:avatar_failed"));
      const payload = (await response.json()) as { avatar_path?: unknown };
      const next =
        typeof payload.avatar_path === "string" && payload.avatar_path.length > 0
          ? payload.avatar_path
          : null;
      useAuthStore.setState({ avatarPath: next });
      setAvatarPath(next);
      setAvatarSuccess(true);
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : t("dashboard:avatar_failed"));
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleAvatarRemove = async () => {
    if (!token) return;
    setAvatarError("");
    setAvatarSuccess(false);
    setAvatarUploading(true);
    try {
      const response = await fetch("/api/v1/auth/me/avatar", {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          "Accept-Language": i18n.language || "zh",
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) throw await readError(response, t("dashboard:avatar_failed"));
      useAuthStore.setState({ avatarPath: null });
      setAvatarPath(null);
      setAvatarSuccess(true);
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : t("dashboard:avatar_failed"));
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSuccess(false);
    if (newPassword.length < 8) {
      setError(t("dashboard:password_requirements"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("dashboard:password_mismatch"));
      return;
    }
    if (!token) {
      setError(t("dashboard:password_change_unavailable"));
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/v1/auth/password", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Accept-Language": i18n.language || "zh",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      if (!response.ok) throw await readError(response, t("dashboard:password_change_failed"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("dashboard:password_change_failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-6">
      <div>
        <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-accent-2">
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          {t("dashboard:account_security")}
        </div>
        <h2 className="font-editorial text-2xl text-text">{t("dashboard:change_password")}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-text-3">{t("dashboard:change_password_description")}</p>
      </div>

      <div className="rounded-xl border border-hairline-soft p-5" style={CARD_STYLE}>
        <form onSubmit={(event) => { void handleNicknameSubmit(event); }} className="max-w-xl space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {avatarPath ? (
              <img
                src={API.getAvatarUrl(avatarPath, avatarPath) ?? undefined}
                alt={t("dashboard:avatar_label")}
                className="h-12 w-12 rounded-full border border-hairline object-cover"
              />
            ) : (
              <span
                className="display-serif grid h-12 w-12 shrink-0 place-items-center rounded-full text-lg font-bold"
                style={{
                  background: "linear-gradient(135deg, var(--color-accent) 0%, oklch(0.55 0.12 260) 100%)",
                  color: "oklch(0.12 0 0)",
                }}
              >
                {((storedNickname ?? storedUsername) || "?").slice(0, 1).toUpperCase()}
              </span>
            )}
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  aria-label={t("dashboard:avatar_upload")}
                  onChange={(event) => { void handleAvatarUpload(event); }}
                />
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={avatarUploading}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-strong px-2.5 text-[11.5px] font-medium text-text-2 transition hover:border-accent/50 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {avatarUploading ? (
                    <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                  ) : (
                    <Upload className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {avatarUploading ? t("dashboard:avatar_uploading") : t("dashboard:avatar_upload")}
                </button>
                {avatarPath && (
                  <button
                    type="button"
                    onClick={() => { void handleAvatarRemove(); }}
                    disabled={avatarUploading}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[11.5px] font-medium text-text-3 transition hover:border-warm-ring hover:text-warm-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    {t("dashboard:avatar_remove")}
                  </button>
                )}
              </div>
              <p className="text-[11px] text-text-4">{t("dashboard:avatar_hint")}</p>
            </div>
          </div>
          {avatarError && <p role="alert" className="text-sm text-red-200">{avatarError}</p>}
          {avatarSuccess && <p role="status" className="text-sm text-emerald-300">{t("dashboard:avatar_success")}</p>}
          <div>
            <FieldLabel htmlFor="account-nickname">{t("dashboard:nickname")}</FieldLabel>
            <input
              id="account-nickname"
              type="text"
              maxLength={100}
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              className={INPUT_CLS}
              placeholder={t("dashboard:nickname_placeholder")}
            />
            <p className="mt-1.5 text-xs text-text-4">{t("dashboard:nickname_hint")}</p>
          </div>
          {nicknameError && <p role="alert" className="text-sm text-red-200">{nicknameError}</p>}
          {nicknameSuccess && <p role="status" className="text-sm text-emerald-300">{t("dashboard:nickname_saved")}</p>}
          <button type="submit" disabled={savingNickname} className={`${ACCENT_BTN_CLS} justify-center`} style={ACCENT_BUTTON_STYLE}>
            {savingNickname && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
            {savingNickname ? t("dashboard:saving_nickname") : t("dashboard:save_nickname")}
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-hairline-soft p-5" style={CARD_STYLE}>
        <form onSubmit={(event) => { void handleSubmit(event); }} className="max-w-xl space-y-4">
          <div>
            <FieldLabel htmlFor="account-current-password" required>{t("dashboard:current_password")}</FieldLabel>
            <input id="account-current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className={INPUT_CLS} required />
          </div>
          <div>
            <FieldLabel htmlFor="account-new-password" required>{t("dashboard:new_password")}</FieldLabel>
            <input id="account-new-password" type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className={INPUT_CLS} required />
          </div>
          <div>
            <FieldLabel htmlFor="account-confirm-password" required>{t("dashboard:confirm_password")}</FieldLabel>
            <input id="account-confirm-password" type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className={INPUT_CLS} required />
          </div>
          <p className="text-xs text-text-4">{t("dashboard:password_requirements")}</p>
          {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
          {success && <p role="status" className="text-sm text-emerald-300">{t("dashboard:password_change_success")}</p>}
          <button type="submit" disabled={saving} className={`${ACCENT_BTN_CLS} justify-center`} style={ACCENT_BUTTON_STYLE}>
            {saving && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
            {saving ? t("dashboard:changing_password") : t("dashboard:save_password")}
          </button>
        </form>
      </div>
    </section>
  );
}
