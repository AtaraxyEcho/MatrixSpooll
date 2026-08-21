import { ExternalLink, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";

const MODIFIED_DATE = "2026-08-21";
const ORIGINAL_REPOSITORY = "https://github.com/ArcReel/ArcReel";
const CURRENT_REPOSITORY = "https://github.com/MockMine/MatrixSpooll";
const LICENSE_URL = `${CURRENT_REPOSITORY}/blob/main/LICENSE`;
const NOTICE_URL = `${CURRENT_REPOSITORY}/blob/main/NOTICE`;

const LINK_CLASS =
  "inline-flex items-center gap-1.5 break-all text-accent-2 transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function AboutSection() {
  const { t } = useTranslation("dashboard");

  return (
    <section className="space-y-6">
      <div>
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-accent-2">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          {t("license_source_kicker")}
        </div>
        <h2 className="font-editorial text-[28px] font-normal leading-tight text-text">
          {t("license_source_title")}
        </h2>
      </div>

      <div className="space-y-5 rounded-[10px] border border-hairline bg-bg-grad-a/35 p-5 text-[12.5px] leading-6 text-text-2">
        <p>{t("license_source_modified", { date: MODIFIED_DATE })}</p>
        <p className="font-medium text-text">
          Powered by ArcReel —{" "}
          <a className={LINK_CLASS} href={ORIGINAL_REPOSITORY} target="_blank" rel="noreferrer">
            {ORIGINAL_REPOSITORY}
            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </a>
        </p>

        <div className="space-y-2 border-t border-hairline-soft pt-4">
          <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-accent-2">
            {t("license_source_license_heading")}
          </h3>
          <p>{t("license_source_license_description")}</p>
          <p>{t("license_source_no_warranty")}</p>
          <div className="flex flex-col gap-1">
            <a className={LINK_CLASS} href={LICENSE_URL} target="_blank" rel="noreferrer">
              {t("license_source_license_link")}
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
            </a>
            <a className={LINK_CLASS} href={NOTICE_URL} target="_blank" rel="noreferrer">
              {t("license_source_notice_link")}
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
            </a>
          </div>
        </div>

        <div className="space-y-2 border-t border-hairline-soft pt-4">
          <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-accent-2">
            {t("license_source_copyright_heading")}
          </h3>
          <p>{t("license_source_original_copyright")}</p>
          <p>{t("license_source_modified_copyright")}</p>
        </div>
      </div>
    </section>
  );
}
