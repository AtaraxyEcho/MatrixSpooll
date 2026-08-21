import { useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { getToken } from "@/utils/auth";
import { FieldLabel } from "@/components/ui/FieldLabel";
import { ACCENT_BTN_CLS, ACCENT_BUTTON_STYLE, CARD_STYLE, INPUT_CLS } from "@/components/ui/darkroom-tokens";

async function readError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => ({})) as { detail?: unknown };
  return new Error(typeof payload.detail === "string" ? payload.detail : fallback);
}

export function AccountSecuritySection() {
  const { t, i18n } = useTranslation(["common", "dashboard"]);
  const token = useAuthStore((state) => state.token) ?? getToken();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

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
