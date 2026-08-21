import { ExternalLink } from "lucide-react";

const ORIGINAL_REPOSITORY = "https://github.com/ArcReel/ArcReel";

const LINK_CLASS =
  "inline-flex items-center gap-1.5 break-all text-accent-2 transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function AboutSection() {
  return (
    <section className="space-y-4">
      <p className="text-[12.5px] leading-6 text-text-2">
        <span className="font-medium text-text">Powered by ArcReel — </span>
        <a className={LINK_CLASS} href={ORIGINAL_REPOSITORY} target="_blank" rel="noreferrer">
          {ORIGINAL_REPOSITORY}
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        </a>
      </p>
    </section>
  );
}
