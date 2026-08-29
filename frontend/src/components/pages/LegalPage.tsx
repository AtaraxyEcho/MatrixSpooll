import { useEffect, useState } from "react";
import { BookOpen, ChevronLeft, Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { API, type LegalDisclosureResponse } from "@/api";
import { ROUTE_APP } from "@/app-routes";

const LINK_CLASS =
  "focus-ring inline-flex items-center gap-1.5 break-all text-accent-2 transition-colors hover:text-accent";

export function LegalPage() {
  const { t } = useTranslation(["dashboard", "common"]);
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
      <header className="app-topbar-surface">
        <div className="app-topbar-content app-topbar-content--wide app-topbar-inner flex items-center">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href={ROUTE_APP}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-hairline-soft bg-bg-grad-a/45 px-2.5 py-1.5 text-[12px] text-text-3 transition-colors hover:border-hairline hover:bg-bg-grad-a hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={t("common:back")}
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">{t("common:back")}</span>
            </Link>
            <span aria-hidden className="h-7 w-px shrink-0 bg-hairline-soft" />
            <h1 className="font-editorial truncate text-[21px] font-normal leading-none tracking-[-0.012em] text-text sm:text-[24px]">
              {t("about_title")}
            </h1>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-5 py-8 lg:px-8 lg:py-12">
        <p className="max-w-2xl text-[13px] leading-6 text-text-3">{t("about_intro")}</p>

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
                {!legal.source_release.enabled ? (
                  <p className="text-warning">{t("about_source_disabled")}</p>
                ) : legal.source_release.available && legal.source_release.download_url ? (
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
