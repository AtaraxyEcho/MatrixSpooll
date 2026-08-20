import { useEffect, useId, useMemo, useState } from "react";
import { Check, Landmark, Library, Package, Search, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { AssetThumb } from "@/components/assets/AssetThumb";
import { GlassModal } from "@/components/ui/GlassModal";
import { ModalCloseButton } from "@/components/ui/ModalCloseButton";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { SecondaryButton } from "@/components/ui/SecondaryButton";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { Asset, AssetType } from "@/types/asset";

const ASSET_TYPES: Array<{ type: AssetType; icon: typeof User }> = [
  { type: "character", icon: User },
  { type: "scene", icon: Landmark },
  { type: "prop", icon: Package },
];

interface FreeCreationAssetPickerModalProps {
  maxSelection: number | null;
  busy?: boolean;
  onClose: () => void;
  onImport: (assets: Asset[]) => void | Promise<void>;
}

export function FreeCreationAssetPickerModal({
  maxSelection,
  busy = false,
  onClose,
  onImport,
}: FreeCreationAssetPickerModalProps) {
  const { t } = useTranslation(["dashboard", "assets"]);
  const titleId = useId();
  const [type, setType] = useState<AssetType>("character");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 250);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Map<string, Asset>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void API.listAssets(
      { type, q: debouncedQuery || undefined, limit: 100 },
      { signal: controller.signal },
    ).then((result) => {
      if (!controller.signal.aborted) setAssets(result.items.filter((asset) => Boolean(asset.image_path)));
    }).catch(() => {
      if (!controller.signal.aborted) setAssets([]);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [debouncedQuery, type]);

  const selectedAssets = useMemo(() => [...selected.values()], [selected]);
  const selectionFull = maxSelection !== null && selected.size >= maxSelection;

  const toggleAsset = (asset: Asset) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(asset.id)) next.delete(asset.id);
      else if (maxSelection === null || next.size < maxSelection) next.set(asset.id, asset);
      return next;
    });
  };

  return (
    <GlassModal
      open
      onClose={onClose}
      labelledBy={titleId}
      widthClassName="w-[820px] max-w-[calc(100vw-24px)]"
      panelClassName="flex max-h-[min(760px,90vh)] flex-col"
    >
      <header className="flex items-center gap-3 border-b border-[var(--color-hairline)] px-5 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] text-[var(--color-accent-2)]" aria-hidden>
          <Library className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-[15px] font-semibold text-[var(--color-text)]">
            {t("dashboard:free_creation_asset_picker_title")}
          </h2>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
            {t("dashboard:free_creation_asset_picker_description")}
          </p>
        </div>
        <ModalCloseButton onClick={onClose} />
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-hairline)] px-4 py-3">
        <div className="flex items-center gap-1" role="tablist" aria-label={t("assets:library_tabs_label")}>
          {ASSET_TYPES.map(({ type: assetType, icon: Icon }) => (
            <button
              key={assetType}
              type="button"
              role="tab"
              aria-selected={type === assetType}
              onClick={() => {
                setLoading(true);
                setType(assetType);
              }}
              className={`focus-ring inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors ${type === assetType ? "bg-[var(--color-accent-dim)] text-[var(--color-accent-2)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"}`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {t(`assets:type.${assetType}`)}
            </button>
          ))}
        </div>
        <label className="ml-auto flex h-8 min-w-48 flex-1 items-center gap-2 rounded-md border border-[var(--color-hairline-strong)] bg-[var(--color-background)] px-2.5 sm:max-w-64">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setLoading(true);
              setQuery(event.target.value);
            }}
            placeholder={t("assets:search_placeholder")}
            aria-label={t("assets:search_placeholder")}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
          />
        </label>
      </div>

      <div className="grid min-h-56 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-3 sm:grid-cols-3 md:grid-cols-4" role="tabpanel">
        {!loading && assets.length === 0 ? (
          <p className="col-span-full py-14 text-center text-[12px] text-[var(--color-text-muted)]">
            {debouncedQuery ? t("assets:no_results") : t("dashboard:free_creation_asset_picker_empty")}
          </p>
        ) : null}
        {assets.map((asset) => {
          const isSelected = selected.has(asset.id);
          const disabled = busy || (!isSelected && selectionFull);
          return (
            <button
              key={asset.id}
              type="button"
              aria-pressed={isSelected}
              disabled={disabled}
              onClick={() => toggleAsset(asset)}
              title={disabled && maxSelection !== null ? t("dashboard:free_creation_reference_limit_reached", { count: maxSelection }) : asset.name}
              className={`focus-ring relative overflow-hidden rounded-md border p-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${isSelected ? "border-[var(--color-accent)] bg-[var(--color-accent-dim)]" : "border-[var(--color-hairline)] bg-[var(--color-surface-2)] hover:border-[var(--color-hairline-strong)]"}`}
            >
              <AssetThumb
                imageUrl={API.getGlobalAssetUrl(asset.image_path, asset.updated_at)}
                alt={asset.name}
                fallback={t(`assets:type.${asset.type}`)}
                variant="picker"
              />
              <span className="mt-2 block truncate text-[12px] font-medium text-[var(--color-text)]">{asset.name}</span>
              <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]">
                {t(`assets:type.${asset.type}`)}
              </span>
              {isSelected ? (
                <span className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-[var(--color-accent)] text-white" aria-hidden>
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <footer className="flex items-center gap-2 border-t border-[var(--color-hairline)] px-5 py-3">
        <span className="mr-auto text-[11px] tabular-nums text-[var(--color-text-muted)]">
          {maxSelection === null
            ? t("dashboard:free_creation_asset_selected", { count: selected.size })
            : t("dashboard:free_creation_reference_count", { count: selected.size, limit: maxSelection })}
        </span>
        <SecondaryButton size="sm" onClick={onClose} disabled={busy}>{t("assets:cancel")}</SecondaryButton>
        <PrimaryButton
          size="sm"
          leadingIcon={busy ? undefined : <Library className="h-3.5 w-3.5" aria-hidden />}
          disabled={!selected.size || busy}
          onClick={() => void onImport(selectedAssets)}
        >
          {busy ? t("assets:loading") : t("dashboard:free_creation_reference_assets")}
        </PrimaryButton>
      </footer>
    </GlassModal>
  );
}
