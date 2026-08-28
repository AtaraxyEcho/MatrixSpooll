import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { API, type LegalDisclosureResponse } from "@/api";
import { ROUTE_APP } from "@/app-routes";

const LINK_CLASS =
  "focus-ring inline-flex items-center gap-1.5 break-all text-accent-2 transition-colors hover:text-accent";

export function LegalPage() {
  const { t } = useTranslation("dashboard");
  const [, navigate] = useLocation();
  const [legal, setLegal] = useState<LegalDisclosureResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void API.getLegalDisclosure()
      .then((value) => {
        if (active) setLegal(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const attributionPrefix = legal
    ? legal.attribution.replace(legal.repository_url, "").trimEnd()
    : "";

  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="sticky top-0 z-20 border-b border-hairline bg-bg/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-5 lg:px-8">
          <button
            type="button"
            onClick={() => navigate(`~${ROUTE_APP}`)}
            className="focus-ring grid h-8 w-8 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
            aria-label={t("about_back_home")}
            title={t("about_back_home")}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </button>
          <div className="h-5 w-px bg-hairline" aria-hidden />
          <span className="text-[13px] font-semibold">MatrixSpooll</span>
          <span className="text-[12px] text-text-4">/ {t("about")}</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-5 py-10 lg:px-8 lg:py-14">
        <div className="max-w-2xl">
          <p className="num text-[10px] font-semibold uppercase text-text-4">{t("about_kicker")}</p>
          <h1 className="mt-2 text-2xl font-semibold">{t("about_title")}</h1>
          <p className="mt-3 text-[13px] leading-6 text-text-3">{t("about_intro")}</p>
        </div>

        {failed ? (
          <p role="alert" className="mt-10 text-[13px] text-danger">
            {t("about_attribution_unavailable")}
          </p>
        ) : !legal ? (
          <div role="status" className="mt-10 flex items-center gap-2 text-[13px] text-text-4">
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
            {t("about_loading")}
          </div>
        ) : (
          <div className="mt-10 divide-y divide-hairline border-y border-hairline">
            <section className="grid gap-4 py-7 md:grid-cols-[180px_1fr]">
              <h2 className="text-[13px] font-semibold">{t("about_origin_title")}</h2>
              <div className="space-y-3 text-[13px] leading-6 text-text-3">
                <p>{t("about_origin_description")}</p>
                <p>
                  <span className="font-medium text-text">{attributionPrefix} </span>
                  <a className={LINK_CLASS} href={legal.repository_url} target="_blank" rel="noreferrer">
                    {legal.repository_url}
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  </a>
                </p>
              </div>
            </section>

            <section className="grid gap-4 py-7 md:grid-cols-[180px_1fr]">
              <h2 className="text-[13px] font-semibold">{t("about_modified_title")}</h2>
              <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
                <div>
                  <dt className="text-text-4">{t("about_product")}</dt>
                  <dd className="mt-1 text-text-2">{legal.modified_product}</dd>
                </div>
                <div>
                  <dt className="text-text-4">{t("about_modified_by")}</dt>
                  <dd className="mt-1 text-text-2">{legal.modified_by}</dd>
                </div>
                <div>
                  <dt className="text-text-4">{t("about_modification_date")}</dt>
                  <dd className="num mt-1 text-text-2">{legal.modification_date}</dd>
                </div>
              </dl>
            </section>

            <section className="grid gap-4 py-7 md:grid-cols-[180px_1fr]">
              <h2 className="text-[13px] font-semibold">{t("about_license_title")}</h2>
              <div className="space-y-3 text-[13px] leading-6 text-text-3">
                <p>{t("about_license_description")}</p>
                <a className={LINK_CLASS} href={legal.license_download_url}>
                  <FileText className="h-3.5 w-3.5" aria-hidden />
                  {legal.license_name}
                </a>
              </div>
            </section>

            <section className="grid gap-4 py-7 md:grid-cols-[180px_1fr]">
              <h2 className="text-[13px] font-semibold">{t("about_source_title")}</h2>
              <div className="min-w-0 text-[13px] leading-6 text-text-3">
                {legal.source_release.available && legal.source_release.download_url ? (
                  <>
                    <p>{t("about_source_available", { version: legal.source_release.version })}</p>
                    {legal.source_release.sha256 && (
                      <p className="num mt-2 break-all text-[11px] text-text-4">
                        SHA-256 {legal.source_release.sha256}
                      </p>
                    )}
                    <a className={`${LINK_CLASS} mt-4`} href={legal.source_release.download_url}>
                      <Download className="h-3.5 w-3.5" aria-hidden />
                      {t("about_source_download")}
                    </a>
                  </>
                ) : (
                  <p className="text-warning">{t("about_source_unavailable")}</p>
                )}
              </div>
            </section>

            <section className="grid gap-4 py-7 md:grid-cols-[180px_1fr]">
              <h2 className="text-[13px] font-semibold">{t("about_resources_title")}</h2>
              <div className="flex flex-wrap gap-x-5 gap-y-3 text-[13px]">
                <a className={LINK_CLASS} href="/docs/" target="_blank" rel="noreferrer">
                  <BookOpen className="h-3.5 w-3.5" aria-hidden />
                  {t("documentation_site")}
                </a>
                <a
                  className={LINK_CLASS}
                  href="/docs/legal/disclaimer"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("about_disclaimer")}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
