import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  LANGUAGE_DISPLAY_LABELS,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "@/i18n";

interface LanguageSwitcherProps {
  compact?: boolean;
}

export function LanguageSwitcher({ compact = true }: LanguageSwitcherProps) {
  const { t, i18n } = useTranslation(["common", "dashboard"]);
  const detectedLanguage = i18n.resolvedLanguage ?? i18n.language;
  const languageCode = detectedLanguage.split("-")[0];
  const currentLanguage = SUPPORTED_LANGUAGES.includes(languageCode as SupportedLanguage)
    ? languageCode as SupportedLanguage
    : "zh";
  const languageLabel = LANGUAGE_DISPLAY_LABELS[currentLanguage];

  const cycleLanguage = () => {
    const index = SUPPORTED_LANGUAGES.indexOf(currentLanguage);
    const nextLanguage = SUPPORTED_LANGUAGES[(index + 1) % SUPPORTED_LANGUAGES.length];
    void i18n.changeLanguage(nextLanguage);
  };

  return (
    <button
      type="button"
      onClick={cycleLanguage}
      className={compact
        ? "focus-ring inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md border border-hairline-soft bg-bg-grad-a/45 px-2 text-[11.5px] text-text-3 transition hover:scale-105 hover:border-hairline hover:bg-bg-grad-a hover:text-text"
        : "inline-flex shrink-0 items-center gap-2 rounded-md border border-hairline-soft bg-bg-grad-a/45 px-2.5 py-1.5 text-[12px] text-text-3 transition-colors hover:border-hairline hover:bg-bg-grad-a hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"}
      title={languageLabel}
      aria-label={t("dashboard:language_setting")}
    >
      <Languages className="h-3.5 w-3.5" aria-hidden />
      <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.14em]">
        {currentLanguage}
      </span>
    </button>
  );
}
