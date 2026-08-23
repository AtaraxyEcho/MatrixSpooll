import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API, type LegalAttributionResponse } from "@/api";

const LINK_CLASS =
  "inline-flex items-center gap-1.5 break-all text-accent-2 transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function AboutSection() {
  const { t } = useTranslation("dashboard");
  const [legal, setLegal] = useState<LegalAttributionResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void API.getLegalAttribution()
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

  if (failed) {
    return <p className="text-[12.5px] leading-6 text-danger">{t("about_attribution_unavailable")}</p>;
  }

  if (!legal) return <div className="h-6" aria-hidden />;

  const attributionPrefix = legal.attribution.replace(legal.repository_url, "").trimEnd();
  return (
    <section className="space-y-4">
      <p className="text-[12.5px] leading-6 text-text-2">
        <span className="font-medium text-text">{attributionPrefix} </span>
        <a className={LINK_CLASS} href={legal.repository_url} target="_blank" rel="noreferrer">
          {legal.repository_url}
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        </a>
      </p>
    </section>
  );
}
