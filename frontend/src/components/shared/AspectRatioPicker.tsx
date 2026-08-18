import { useTranslation } from "react-i18next";
import { radioCardClass } from "@/components/ui/darkroom-tokens";

export const ASPECT_RATIO_OPTIONS = [
  { value: "9:16", labelKey: "portrait_9_16" },
  { value: "16:9", labelKey: "landscape_16_9" },
  { value: "1:1", labelKey: "aspect_ratio_1_1" },
  { value: "4:3", labelKey: "aspect_ratio_4_3" },
  { value: "3:4", labelKey: "aspect_ratio_3_4" },
  { value: "21:9", labelKey: "aspect_ratio_21_9" },
] as const;

interface AspectRatioPickerProps {
  value: string;
  onChange: (value: string) => void;
  name?: string;
  disabled?: boolean;
}

export function AspectRatioPicker({
  value,
  onChange,
  name = "aspectRatio",
  disabled = false,
}: AspectRatioPickerProps) {
  const { t } = useTranslation("dashboard");

  return (
    <div
      className="grid grid-cols-2 gap-2.5 sm:grid-cols-3"
      role="radiogroup"
      aria-label={t("aspect_ratio")}
    >
      {ASPECT_RATIO_OPTIONS.map(({ value: ratio, labelKey }) => {
        const active = value === ratio;
        return (
          <label key={ratio} className={radioCardClass(active)}>
            <input
              type="radio"
              name={name}
              value={ratio}
              checked={active}
              onChange={() => onChange(ratio)}
              disabled={disabled}
              className="sr-only"
            />
            <span className="inline-flex items-center gap-2">
              <span className="flex h-4 w-6 items-center justify-center" aria-hidden="true">
                <span
                  className="block max-h-4 max-w-6 border border-hairline"
                  style={{
                    height: "14px",
                    aspectRatio: ratio.replace(":", " / "),
                    background: active ? "var(--color-accent-soft)" : "transparent",
                  }}
                />
              </span>
              {t(labelKey)}
            </span>
          </label>
        );
      })}
    </div>
  );
}
