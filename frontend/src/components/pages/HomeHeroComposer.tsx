import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Crop,
  FileText,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Monitor,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { ASPECT_RATIO_OPTIONS } from "@/components/shared/AspectRatioPicker";
import type {
  CreateFreeCreationRequest,
  FreeCreationCapabilities,
  FreeCreationReferenceClaim,
  FreeCreationReferenceRole,
} from "@/types";
import { errMsg } from "@/utils/async";
import { useAppStore } from "@/stores/app-store";
import { useAssistantStore } from "@/stores/assistant-store";

interface HomeHeroComposerProps {
  onCreated: (projectName: string, mode: HomeComposerMode) => void;
}

type HomeComposerMode = "agent" | "image" | "video";
export type AgentGenerationPreference = "image" | "video";
type ModelOptions = { image: string[]; video: string[] };
type CapabilityResult = {
  key: string;
  value: FreeCreationCapabilities | null;
  error: string | null;
};

const EMPTY_MODEL_OPTIONS: ModelOptions = { image: [], video: [] };
const IMAGE_RESOLUTIONS = ["1.5k", "2k", "4k"] as const;
const IMAGE_RESOLUTION_PIXELS: Record<(typeof IMAGE_RESOLUTIONS)[number], number> = {
  "1.5k": 1536,
  "2k": 2048,
  "4k": 4096,
};
const QUANTITIES = [1, 2, 3, 4] as const;
const MIN_IMAGE_DIMENSION = 256;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_HOME_REFERENCES = 9;
const HOME_REFERENCE_ACCEPT = "image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/wav,audio/mpeg,text/plain,text/markdown,application/pdf,.txt,.md,.markdown,.pdf";

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function shortProjectTitle(prompt: string): string {
  const normalized = prompt.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const withoutPunctuation = normalized.replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, "");
  return withoutPunctuation.slice(0, 32) || "Untitled creation";
}

export function modelLabel(model: string, autoLabel: string): string {
  if (model === "auto") return autoLabel;
  const separator = model.indexOf("/");
  return separator >= 0 ? model.slice(separator + 1) : model;
}

function dimensionsForPreset(resolution: string, ratio: string) {
  const edge = IMAGE_RESOLUTION_PIXELS[resolution as (typeof IMAGE_RESOLUTIONS)[number]] ?? 1536;
  const [ratioWidth = 1, ratioHeight = 1] = ratio.split(":").map(Number);
  if (!Number.isFinite(ratioWidth) || !Number.isFinite(ratioHeight) || ratioWidth <= 0 || ratioHeight <= 0) {
    return { width: edge, height: edge };
  }

  const align = (value: number) => Math.max(16, Math.round(value / 16) * 16);
  return ratioWidth >= ratioHeight
    ? { width: edge, height: align((edge * ratioHeight) / ratioWidth) }
    : { width: align((edge * ratioWidth) / ratioHeight), height: edge };
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function ratioForDimensions(width: number, height: number): string {
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function normalizeDimension(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_IMAGE_DIMENSION, Math.max(MIN_IMAGE_DIMENSION, parsed));
}

type HomeSelectValue = string | number;

interface HomeSelectOption<T extends HomeSelectValue> {
  value: T;
  label: string;
}

interface HomeSelectProps<T extends HomeSelectValue> {
  label: string;
  value: T;
  options: readonly HomeSelectOption<T>[];
  icon: typeof Settings2;
  onChange: (value: T) => void;
  align?: "left" | "right";
  className?: string;
  hint?: string;
  hideLabel?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  placement?: "auto" | "top";
}

function referenceRoleForFile(file: File): FreeCreationReferenceRole {
  if (file.type.startsWith("video/")) return "reference_video";
  if (file.type.startsWith("audio/")) return "reference_audio";
  if (file.type.startsWith("text/") || /\.(?:txt|md|markdown|pdf)$/i.test(file.name)) return "prompt_context";
  return "reference_image";
}

export function HomeSelect<T extends HomeSelectValue>({
  label,
  value,
  options,
  icon: Icon,
  onChange,
  align = "left",
  className = "",
  hint,
  hideLabel = false,
  searchable = false,
  searchPlaceholder,
  emptyLabel,
  placement = "auto",
}: HomeSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popoverLayout, setPopoverLayout] = useState<{ left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listboxId = useId();
  const hintId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex] ?? options[0];
  const visibleOptions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return options;
    return options.filter((option) => `${option.label} ${String(option.value)}`.toLocaleLowerCase().includes(normalized));
  }, [options, query]);
  const visibleSelectedIndex = Math.max(0, visibleOptions.findIndex((option) => option.value === value));
  const longestOptionLength = useMemo(
    () => Math.max(...options.map((option) => option.label.length), label.length),
    [label, options],
  );

  useLayoutEffect(() => {
    if (!open || !searchable || !triggerRef.current) {
      setPopoverLayout(null);
      return;
    }
    const updateLayout = () => {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      if (!triggerRect) return;
      const viewportPadding = 16;
      const preferredWidth = Math.max(420, longestOptionLength * 8 + 72);
      const width = Math.min(preferredWidth, window.innerWidth - viewportPadding * 2);
      const absoluteLeft = Math.min(
        Math.max(viewportPadding, triggerRect.left),
        Math.max(viewportPadding, window.innerWidth - viewportPadding - width),
      );
      setPopoverLayout({ left: absoluteLeft - triggerRect.left, width });
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, [longestOptionLength, open, searchable]);

  const clearTypeahead = () => {
    typeaheadRef.current = "";
    if (typeaheadTimerRef.current) {
      clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = null;
    }
  };

  const focusByTypeahead = (key: string) => {
    const normalizedKey = key.toLocaleLowerCase();
    const nextQuery = typeaheadRef.current ? `${typeaheadRef.current}${normalizedKey}` : normalizedKey;
    const findMatch = (query: string) => options.findIndex((option) => {
      const searchText = `${option.label} ${String(option.value)}`.toLocaleLowerCase();
      return searchText.includes(query);
    });
    let matchIndex = findMatch(nextQuery);
    if (matchIndex < 0) {
      typeaheadRef.current = normalizedKey;
      matchIndex = findMatch(normalizedKey);
    } else {
      typeaheadRef.current = nextQuery;
    }
    if (matchIndex >= 0) {
      pendingFocusIndexRef.current = matchIndex;
      setOpen(true);
      if (open) optionRefs.current[matchIndex]?.focus();
    }
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = setTimeout(clearTypeahead, 700);
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (searchable) searchRef.current?.focus();
    else optionRefs.current[selectedIndex]?.focus();
  }, [open, searchable, selectedIndex]);

  useEffect(() => {
    if (!open || searchable || pendingFocusIndexRef.current === null) return;
    optionRefs.current[pendingFocusIndexRef.current]?.focus();
    pendingFocusIndexRef.current = null;
  }, [open, searchable]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
  }, []);

  const selectOption = (nextValue: T) => {
    onChange(nextValue);
    setOpen(false);
    setQuery("");
    clearTypeahead();
    triggerRef.current?.focus();
  };

  const moveFocus = (index: number) => {
    if (!visibleOptions.length) return;
    optionRefs.current[(index + visibleOptions.length) % visibleOptions.length]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={`home-param-control${align === "right" ? " home-param-control--right" : ""}${placement === "top" ? " home-param-control--top" : ""}${className ? ` ${className}` : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className={hideLabel ? "sr-only" : "home-param-label"}>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="home-param-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-haspopup={searchable ? "dialog" : "listbox"}
        aria-describedby={hint ? hintId : undefined}
        onClick={() => setOpen((current) => {
          if (current) setQuery("");
          return !current;
        })}
        onKeyDown={(event) => {
          if (event.key.length === 1 && event.key !== " " && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            focusByTypeahead(event.key);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="home-param-trigger__value">
          <Icon className="home-param-trigger__icon" aria-hidden />
          <span className="truncate">{selectedOption?.label ?? ""}</span>
        </span>
        <ChevronDown
          className={`home-param-trigger__chevron${open ? " is-open" : ""}`}
          aria-hidden
        />
      </button>
      {open ? (
        <div
          id={listboxId}
          className="home-param-popover"
          role={searchable ? "dialog" : "listbox"}
          aria-label={label}
          style={searchable && popoverLayout ? {
            left: popoverLayout.left,
            width: popoverLayout.width,
          } : undefined}
        >
          {searchable ? (
            <label className="home-param-search">
              <Search className="h-3.5 w-3.5" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    optionRefs.current[visibleSelectedIndex]?.focus();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setOpen(false);
                    setQuery("");
                    triggerRef.current?.focus();
                  }
                }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder || label}
              />
            </label>
          ) : null}
          <div
            className="home-param-options"
            role={searchable ? "listbox" : undefined}
            aria-label={searchable ? label : undefined}
          >
            {visibleOptions.map((option, index) => {
              const selected = option.value === value;
              return (
                <button
                  key={String(option.value)}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="home-param-option"
                  onClick={() => selectOption(option.value)}
                  onKeyDown={(event) => {
                    if (event.key.length === 1 && event.key !== " " && !event.altKey && !event.ctrlKey && !event.metaKey) {
                      event.preventDefault();
                      focusByTypeahead(event.key);
                    } else if (event.key === "ArrowDown") {
                      event.preventDefault();
                      moveFocus(index + 1);
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      moveFocus(index - 1);
                    } else if (event.key === "Home") {
                      event.preventDefault();
                      moveFocus(0);
                    } else if (event.key === "End") {
                      event.preventDefault();
                      moveFocus(visibleOptions.length - 1);
                    } else if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectOption(option.value);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setOpen(false);
                      triggerRef.current?.focus();
                    }
                  }}
                >
                  <span className={searchable ? "home-param-option__label" : "truncate"}>{option.label}</span>
                  {selected ? <Check className="home-param-option__check" aria-hidden /> : null}
                </button>
              );
            })}
            {visibleOptions.length === 0 ? <p className="home-param-empty">{emptyLabel}</p> : null}
          </div>
        </div>
      ) : null}
      {hint ? <span id={hintId} className="home-param-hint">{hint}</span> : null}
    </div>
  );
}

export interface ImageParameterControlProps {
  label: string;
  ratioLabel: string;
  resolutionLabel: string;
  quantityLabel: string;
  sizeLabel: string;
  widthLabel: string;
  heightLabel: string;
  sizeHint: string;
  ratio: string;
  resolution: string;
  quantity: number;
  width: number;
  height: number;
  ratioOptions: ReadonlyArray<{ value: string; label: string }>;
  resolutionOptions: readonly string[];
  onRatioChange: (value: string) => void;
  onResolutionChange: (value: string) => void;
  onQuantityChange: (value: number) => void;
  onDimensionsCommit: (width: number, height: number) => void;
  hideLabel?: boolean;
}

export function ImageParameterControl({
  label,
  ratioLabel,
  resolutionLabel,
  quantityLabel,
  sizeLabel,
  widthLabel,
  heightLabel,
  sizeHint,
  ratio,
  resolution,
  quantity,
  width,
  height,
  ratioOptions,
  resolutionOptions,
  onRatioChange,
  onResolutionChange,
  onQuantityChange,
  onDimensionsCommit,
  hideLabel = false,
}: ImageParameterControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const widthInputRef = useRef<HTMLInputElement>(null);
  const heightInputRef = useRef<HTMLInputElement>(null);
  const panelId = useId();

  const commitDimensions = useCallback(() => {
    const nextWidth = normalizeDimension(widthInputRef.current?.value ?? "", width);
    const nextHeight = normalizeDimension(heightInputRef.current?.value ?? "", height);
    onDimensionsCommit(nextWidth, nextHeight);
  }, [height, onDimensionsCommit, width]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        commitDimensions();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [commitDimensions, open]);

  const toggleOpen = () => {
    if (open) {
      commitDimensions();
    }
    setOpen((current) => !current);
  };

  return (
    <div
      ref={rootRef}
      className="home-param-control home-generation-parameters home-generation-parameters--image"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          commitDimensions();
          setOpen(false);
        }
      }}
    >
      <span className={hideLabel ? "sr-only" : "home-param-label"}>{label}</span>
      <button
        type="button"
        className="home-combined-trigger home-combined-trigger--image"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={toggleOpen}
      >
        <span className="home-combined-trigger__segment">
          <Crop aria-hidden />
          <span>{ratio}</span>
        </span>
        <span className="home-combined-trigger__segment">
          <Monitor aria-hidden />
          <span>{resolution.toUpperCase()}</span>
        </span>
        <span className="home-combined-trigger__segment">
          <Copy aria-hidden />
          <span>{quantity}</span>
        </span>
        <span className="home-combined-trigger__segment home-combined-trigger__segment--size">
          <Maximize2 aria-hidden />
          <span>{width} &times; {height}</span>
        </span>
        <ChevronDown className={`home-param-trigger__chevron${open ? " is-open" : ""}`} aria-hidden />
      </button>

      {open ? (
        <div id={panelId} className="home-param-popover home-image-parameters__popover" role="dialog" aria-label={label}>
          <fieldset className="home-popover-section">
            <legend>{ratioLabel}</legend>
            <div className="home-ratio-options">
              {ratioOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="home-detail-option home-ratio-option"
                  aria-pressed={ratio === option.value}
                  onClick={() => onRatioChange(option.value)}
                >
                  <span className="home-ratio-option__shape" style={{ aspectRatio: option.value.replace(":", " / ") }} aria-hidden />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="home-popover-section">
            <legend>{resolutionLabel}</legend>
            <div className="home-detail-options home-detail-options--three">
              {resolutionOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="home-detail-option"
                  aria-pressed={resolution === value}
                  onClick={() => onResolutionChange(value)}
                >
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="home-popover-section">
            <legend>{quantityLabel}</legend>
            <div className="home-detail-options home-detail-options--four">
              {QUANTITIES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="home-detail-option"
                  aria-pressed={quantity === value}
                  onClick={() => onQuantityChange(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset key={`${width}x${height}`} className="home-popover-section">
            <legend>{sizeLabel}</legend>
            <div className="home-size-inputs">
              <label>
                <span>{widthLabel}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={MIN_IMAGE_DIMENSION}
                  max={MAX_IMAGE_DIMENSION}
                  step={16}
                  defaultValue={width}
                  ref={widthInputRef}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitDimensions();
                  }}
                />
              </label>
              <span className="home-size-inputs__separator" aria-hidden>&times;</span>
              <label>
                <span>{heightLabel}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={MIN_IMAGE_DIMENSION}
                  max={MAX_IMAGE_DIMENSION}
                  step={16}
                  defaultValue={height}
                  ref={heightInputRef}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitDimensions();
                  }}
                />
              </label>
            </div>
            <p className="home-popover-hint">{sizeHint}</p>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

export interface VideoParameterControlProps {
  label: string;
  ratioLabel: string;
  resolutionLabel: string;
  quantityLabel: string;
  autoLabel: string;
  ratio: string;
  resolution: string;
  quantity: number;
  ratioOptions: ReadonlyArray<{ value: string; label: string }>;
  resolutionOptions: readonly string[];
  onRatioChange: (value: string) => void;
  onResolutionChange: (value: string) => void;
  onQuantityChange: (value: number) => void;
  hideLabel?: boolean;
}

export function VideoParameterControl({
  label,
  ratioLabel,
  resolutionLabel,
  quantityLabel,
  autoLabel,
  ratio,
  resolution,
  quantity,
  ratioOptions,
  resolutionOptions,
  onRatioChange,
  onResolutionChange,
  onQuantityChange,
  hideLabel = false,
}: VideoParameterControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const resolutionText = resolution === "auto" ? autoLabel : resolution.toUpperCase();

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="home-param-control home-generation-parameters home-generation-parameters--video"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className={hideLabel ? "sr-only" : "home-param-label"}>{label}</span>
      <button
        type="button"
        className="home-combined-trigger home-combined-trigger--video"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="home-combined-trigger__segment">
          <Crop aria-hidden />
          <span>{ratio}</span>
        </span>
        <span className="home-combined-trigger__segment">
          <Monitor aria-hidden />
          <span>{resolutionText}</span>
        </span>
        <span className="home-combined-trigger__segment">
          <Copy aria-hidden />
          <span>{quantity}</span>
        </span>
        <ChevronDown className={`home-param-trigger__chevron${open ? " is-open" : ""}`} aria-hidden />
      </button>

      {open ? (
        <div id={panelId} className="home-param-popover home-video-parameters__popover" role="dialog" aria-label={label}>
          <fieldset className="home-popover-section">
            <legend>{ratioLabel}</legend>
            <div className="home-ratio-options">
              {ratioOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="home-detail-option home-ratio-option"
                  aria-pressed={ratio === option.value}
                  onClick={() => onRatioChange(option.value)}
                >
                  <span className="home-ratio-option__shape" style={{ aspectRatio: option.value.replace(":", " / ") }} aria-hidden />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="home-popover-section">
            <legend>{resolutionLabel}</legend>
            <div className="home-detail-options home-detail-options--video-resolution">
              {resolutionOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="home-detail-option"
                  aria-pressed={resolution === value}
                  onClick={() => onResolutionChange(value)}
                >
                  {value === "auto" ? autoLabel : value.toUpperCase()}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="home-popover-section">
            <legend>{quantityLabel}</legend>
            <div className="home-detail-options home-detail-options--four">
              {QUANTITIES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="home-detail-option"
                  aria-pressed={quantity === value}
                  onClick={() => onQuantityChange(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

export interface DurationControlProps {
  label: string;
  minimumLabel: string;
  value: number;
  durations?: readonly number[];
  onChange: (value: number) => void;
  ariaLabel?: string;
  hideLabel?: boolean;
}

export interface AgentParameterControlProps {
  label: string;
  preferenceLabel: string;
  imageLabel: string;
  videoLabel: string;
  ratioLabel: string;
  preference: AgentGenerationPreference;
  ratio: string;
  ratioOptions: ReadonlyArray<{ value: string; label: string }>;
  onPreferenceChange: (value: AgentGenerationPreference) => void;
  onRatioChange: (value: string) => void;
  hideLabel?: boolean;
  placement?: "auto" | "top";
}

export function AgentParameterControl({
  label,
  preferenceLabel,
  imageLabel,
  videoLabel,
  ratioLabel,
  preference,
  ratio,
  ratioOptions,
  onPreferenceChange,
  onRatioChange,
  hideLabel = false,
  placement = "auto",
}: AgentParameterControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`home-param-control home-agent-parameters${placement === "top" ? " home-param-control--top" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className={hideLabel ? "sr-only" : "home-param-label"}>{label}</span>
      <button
        type="button"
        className="home-param-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="home-param-trigger__value">
          <SlidersHorizontal className="home-param-trigger__icon" aria-hidden />
          <span className="truncate">{preference === "image" ? imageLabel : videoLabel} · {ratio}</span>
        </span>
        <ChevronDown className={`home-param-trigger__chevron${open ? " is-open" : ""}`} aria-hidden />
      </button>
      {open ? (
        <div id={panelId} className="home-param-popover home-agent-parameters__popover" role="dialog" aria-label={label}>
          <fieldset className="home-popover-section">
            <legend>{preferenceLabel}</legend>
            <div className="home-detail-options home-detail-options--two">
              {([
                ["image", imageLabel, ImageIcon],
                ["video", videoLabel, Video],
              ] as const).map(([value, optionLabel, OptionIcon]) => (
                <button
                  key={value}
                  type="button"
                  className="home-detail-option inline-flex items-center justify-center gap-1.5"
                  aria-pressed={preference === value}
                  onClick={() => onPreferenceChange(value)}
                >
                  <OptionIcon className="h-3.5 w-3.5" aria-hidden />
                  {optionLabel}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="home-popover-section">
            <legend>{ratioLabel}</legend>
            <div className="home-ratio-options">
              {ratioOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="home-detail-option home-ratio-option"
                  aria-pressed={ratio === option.value}
                  onClick={() => onRatioChange(option.value)}
                >
                  <span className="home-ratio-option__shape" style={{ aspectRatio: option.value.replace(":", " / ") }} aria-hidden />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

export function DurationControl({
  label,
  minimumLabel,
  value,
  durations,
  onChange,
  ariaLabel = label,
  hideLabel = false,
}: DurationControlProps) {
  const supported = useMemo(
    () => (durations?.length ? [...durations].sort((left, right) => left - right) : [value]),
    [durations, value],
  );
  const minimum = supported[0] ?? value;
  const maximum = supported[supported.length - 1] ?? value;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const safeValue = supported.includes(value) ? value : supported.reduce((closest, candidate) => (
    Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest
  ), supported[0] ?? 4);
  const minimumProgress = `${(minimum / Math.max(1, maximum)) * 100}%`;
  const progress = `${(safeValue / Math.max(1, maximum)) * 100}%`;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="home-param-control home-param-control--right home-duration-control"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className={hideLabel ? "sr-only" : "home-param-label"}>{label}</span>
      <button
        type="button"
        className="home-param-trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="home-param-trigger__value">
          <Clock3 className="home-param-trigger__icon" aria-hidden />
          <span>{value}s</span>
        </span>
        <ChevronDown className={`home-param-trigger__chevron${open ? " is-open" : ""}`} aria-hidden />
      </button>

      {open ? (
        <div id={panelId} className="home-param-popover home-duration-popover" role="dialog" aria-label={label}>
          <div className="home-duration-popover__header">
            <span>{minimumLabel}</span>
            <strong>{safeValue}s</strong>
          </div>
          <div className="home-duration-track">
            <input
              className="home-duration-slider"
              type="range"
              min={0}
              max={maximum}
              step={1}
              value={safeValue}
              aria-label={ariaLabel}
              aria-valuemin={minimum}
              aria-valuetext={`${value}s`}
              style={{
                background: `linear-gradient(90deg, oklch(0.34 0.006 265) 0 ${minimumProgress}, var(--color-accent) ${minimumProgress} ${progress}, oklch(0.27 0.012 265) ${progress} 100%)`,
              }}
              onChange={(event) => {
                const requested = event.currentTarget.valueAsNumber;
                const next = supported.reduce((closest, candidate) => (
                  Math.abs(candidate - requested) < Math.abs(closest - requested) ? candidate : closest
                ), minimum);
                onChange(next);
              }}
            />
            <span className="home-duration-minimum-marker" style={{ left: minimumProgress }} aria-hidden>
              <span>{minimum}s</span>
            </span>
          </div>
          <div className="home-duration-ticks" aria-hidden>
            {[...new Set([0, minimum, ...supported.filter((_, index) => index % Math.max(1, Math.ceil(supported.length / 3)) === 0), maximum])].map((tick) => (
              <span key={tick}>{tick}s</span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function HomeHeroComposer({ onCreated }: HomeHeroComposerProps) {
  const { t } = useTranslation("dashboard");
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [composerMode, setComposerMode] = useState<HomeComposerMode>("video");
  const [agentPreference, setAgentPreference] = useState<AgentGenerationPreference>("video");
  const [agentAspectRatio, setAgentAspectRatio] = useState("16:9");
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [outputType, setOutputType] = useState<"image" | "video">("video");
  const [prompt, setPrompt] = useState("");
  const [videoAspectRatio, setVideoAspectRatio] = useState("16:9");
  const [imageAspectRatio, setImageAspectRatio] = useState("16:9");
  const [videoResolution, setVideoResolution] = useState<string>("1080p");
  const [imageResolution, setImageResolution] = useState<string>("1.5k");
  const initialImageDimensions = dimensionsForPreset("1.5k", "16:9");
  const [imageWidth, setImageWidth] = useState(initialImageDimensions.width);
  const [imageHeight, setImageHeight] = useState(initialImageDimensions.height);
  const [quantity, setQuantity] = useState(1);
  const [duration, setDuration] = useState(4);
  const [model, setModel] = useState("auto");
  const [modelOptions, setModelOptions] = useState<ModelOptions>(EMPTY_MODEL_OPTIONS);
  const [capabilityResult, setCapabilityResult] = useState<CapabilityResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([API.getModelCandidates(), API.getSystemConfig()])
      .then(([candidates, config]) => {
        if (!active) return;
        setModelOptions({
          image: unique([config.settings.default_image_backend, ...candidates.image.default]),
          video: unique([config.settings.default_video_backend, ...candidates.video.default]),
        });
      })
      .catch(() => {
        // The composer can still use the project's automatic model fallback.
      });
    return () => {
      active = false;
    };
  }, []);

  const models = outputType === "video" ? modelOptions.video : modelOptions.image;
  const selectedModel = useMemo(
    () => (model === "auto" || models.includes(model) ? model : "auto"),
    [model, models],
  );
  const capabilityRequestKey = `${outputType}:${selectedModel}`;
  const capabilities = capabilityResult?.key === capabilityRequestKey ? capabilityResult.value : null;
  const capabilityError = capabilityResult?.key === capabilityRequestKey ? capabilityResult.error : null;

  useEffect(() => {
    const controller = new AbortController();
    void API.getFreeCreationCapabilities({
      outputType,
      model: selectedModel === "auto" ? undefined : selectedModel,
      signal: controller.signal,
    })
      .then((next) => {
        setCapabilityResult({ key: capabilityRequestKey, value: next, error: null });
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setCapabilityResult({
            key: capabilityRequestKey,
            value: null,
            error: outputType === "video" ? errMsg(err) : null,
          });
        }
      });
    return () => controller.abort();
  }, [capabilityRequestKey, outputType, selectedModel]);
  const ratioValues = useMemo(
    () => capabilities?.output_type === outputType && capabilities.ratios.length
      ? capabilities.ratios
      : outputType === "image"
        ? ASPECT_RATIO_OPTIONS.map(({ value }) => value)
        : [],
    [capabilities, outputType],
  );
  const ratioOptions = useMemo(() => ratioValues.map((value) => {
    const known = ASPECT_RATIO_OPTIONS.find((option) => option.value === value);
    return { value, label: known ? t(known.labelKey) : value };
  }), [ratioValues, t]);
  const imageResolutionOptions = useMemo(
    () => capabilities?.output_type === "image" && capabilities.resolutions.length
      ? capabilities.resolutions
      : [...IMAGE_RESOLUTIONS],
    [capabilities],
  );
  const videoResolutionOptions = useMemo(
    () => capabilities?.output_type === "video" && capabilities.resolutions.length
      ? capabilities.resolutions
      : [],
    [capabilities],
  );
  const videoCapabilitiesReady = outputType !== "video"
    || (capabilities?.output_type === "video" && capabilities.ratios.length > 0 && capabilities.durations.length > 0);
  const effectiveVideoAspectRatio = ratioValues.includes(videoAspectRatio) ? videoAspectRatio : ratioValues[0] ?? "16:9";
  const effectiveImageAspectRatio = ratioValues.includes(imageAspectRatio) ? imageAspectRatio : ratioValues[0] ?? "16:9";
  const effectiveVideoResolution = videoResolutionOptions.includes(videoResolution)
    ? videoResolution
    : videoResolutionOptions[0] ?? "auto";
  const effectiveImageResolution = imageResolutionOptions.includes(imageResolution)
    ? imageResolution
    : imageResolutionOptions[0] ?? "1.5k";
  const videoDurations = capabilities?.output_type === "video" ? capabilities.durations : [];
  const effectiveDuration = videoDurations.includes(duration) ? duration : videoDurations[0] ?? 4;
  const aspectRatio = outputType === "image" ? effectiveImageAspectRatio : effectiveVideoAspectRatio;
  const agentRatioOptions = useMemo(() => ASPECT_RATIO_OPTIONS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  })), [t]);

  const addReferenceFiles = (files: FileList | null) => {
    if (!files?.length) return;
    setReferenceFiles((current) => {
      const next = [...current];
      for (const file of Array.from(files)) {
        const duplicate = next.some((item) => (
          item.name === file.name && item.size === file.size && item.lastModified === file.lastModified
        ));
        if (!duplicate && next.length < MAX_HOME_REFERENCES) next.push(file);
      }
      return next;
    });
  };

  const changeImageAspectRatio = (nextRatio: string) => {
    setImageAspectRatio(nextRatio);
    const dimensions = dimensionsForPreset(effectiveImageResolution, nextRatio);
    setImageWidth(dimensions.width);
    setImageHeight(dimensions.height);
  };

  const changeImageResolution = (nextResolution: string) => {
    setImageResolution(nextResolution);
    const dimensions = dimensionsForPreset(nextResolution, effectiveImageAspectRatio);
    setImageWidth(dimensions.width);
    setImageHeight(dimensions.height);
  };

  const commitImageDimensions = (width: number, height: number) => {
    setImageWidth(width);
    setImageHeight(height);
    setImageAspectRatio(ratioForDimensions(width, height));
  };

  const handleSubmit = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || submitting || (composerMode !== "agent" && !videoCapabilitiesReady)) return;
    setSubmitting(true);
    setError(null);

    let rollbackProjectName: string | null = null;
    try {
      const createProjectShell = async (projectAspectRatio: string) => {
        const project = await API.createProject({
          title: shortProjectTitle(cleanPrompt),
          content_mode: "free",
          generation_mode: null,
          aspect_ratio: projectAspectRatio,
        });
        rollbackProjectName = project.name;
        return project;
      };
      const uploadReferences = async (projectName: string): Promise<FreeCreationReferenceClaim[]> => {
        const claims: FreeCreationReferenceClaim[] = [];
        for (const file of referenceFiles) {
          const uploaded = await API.uploadFreeCreationReference(projectName, file);
          claims.push({
            type: "upload",
            reference_id: uploaded.reference.reference_id,
            role: referenceRoleForFile(file),
          });
        }
        return claims;
      };

      if (composerMode === "agent") {
        const project = await createProjectShell(agentAspectRatio);
        await uploadReferences(project.name);
        const preferenceLabel = agentPreference === "image"
          ? t("free_creation_agent_preference_image")
          : t("free_creation_agent_preference_video");
        const agentContext = t("free_creation_agent_prompt_context", {
          preference: preferenceLabel,
          ratio: agentAspectRatio,
        });
        const referenceContext = referenceFiles.length
          ? `\n${t("free_creation_agent_reference_context", { files: referenceFiles.map((file) => file.name).join(", ") })}`
          : "";
        useAssistantStore.getState().setInput(`${cleanPrompt}\n\n${agentContext}${referenceContext}`);
        setPrompt("");
        setReferenceFiles([]);
        rollbackProjectName = null;
        onCreated(project.name, "agent");
        return;
      }
      const payload: CreateFreeCreationRequest = {
        output_type: outputType,
        prompt: cleanPrompt,
        aspect_ratio: aspectRatio,
        resolution: outputType === "image"
          ? effectiveImageResolution
          : effectiveVideoResolution === "auto" ? undefined : effectiveVideoResolution,
        size: outputType === "image" ? `${imageWidth}x${imageHeight}` : undefined,
        quantity,
        model: selectedModel === "auto" ? undefined : selectedModel,
        ...(outputType === "video" ? { duration_seconds: effectiveDuration } : {}),
      };
      const project = referenceFiles.length
        ? await (async () => {
            const created = await createProjectShell(aspectRatio);
            const references = await uploadReferences(created.name);
            await API.createFreeCreation(created.name, { ...payload, references });
            return created;
          })()
        : await API.createFreeProject({ title: shortProjectTitle(cleanPrompt), creation: payload });
      setPrompt("");
      setReferenceFiles([]);
      rollbackProjectName = null;
      onCreated(project.name, composerMode);
    } catch (err) {
      if (rollbackProjectName) {
        try {
          await API.deleteProject(rollbackProjectName);
        } catch {
          // Preserve the original creation error; project cleanup is best effort.
        }
      }
      const message = errMsg(err);
      setError(message);
      useAppStore.getState().pushToast(message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="home-hero-composer mx-auto w-full max-w-[980px] px-4 pb-8 pt-12 sm:px-6 lg:pt-16">
      <div className="mb-7 text-center">
        <div className="mb-3 inline-flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-accent-2">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          {t("home_hero_eyebrow")}
        </div>
        <h1 className="m-0 font-editorial text-[42px] font-normal leading-[0.95] tracking-[-0.035em] text-text sm:text-[56px] lg:text-[72px]">
          {t("home_hero_title")}
        </h1>
        <p className="mx-auto mt-4 max-w-[600px] text-[13px] leading-6 text-text-3">
          {t("home_hero_subtitle")}
        </p>
      </div>

      <div className="home-composer-shell rounded-[14px] p-3 sm:p-5">
        <div className="home-composer-input-row">
          <div className="home-reference-tray" aria-label={t("free_creation_reference_content")}>
            {referenceFiles.map((file) => {
              const isImage = file.type.startsWith("image/");
              const isVideo = file.type.startsWith("video/");
              const ReferenceIcon = isImage ? ImageIcon : isVideo ? Video : FileText;
              return (
                <div key={`${file.name}:${file.size}:${file.lastModified}`} className="home-reference-card">
                  <ReferenceIcon className="h-5 w-5 text-accent-2" aria-hidden />
                  <span title={file.name}>{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setReferenceFiles((current) => current.filter((item) => item !== file))}
                    aria-label={`${t("free_creation_remove_reference")}: ${file.name}`}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              );
            })}
            {referenceFiles.length < MAX_HOME_REFERENCES ? (
              <button
                type="button"
                className="home-reference-card home-reference-card--add"
                onClick={() => referenceInputRef.current?.click()}
                aria-label={t("free_creation_upload_reference")}
                title={t("free_creation_upload_reference")}
              >
                <Plus className="h-5 w-5" aria-hidden />
                <span>{t("free_creation_reference_content")}</span>
              </button>
            ) : null}
            <input
              ref={referenceInputRef}
              type="file"
              multiple
              accept={HOME_REFERENCE_ACCEPT}
              className="sr-only"
              aria-label={t("free_creation_upload_reference")}
              onChange={(event) => {
                addReferenceFiles(event.target.files);
                event.currentTarget.value = "";
              }}
            />
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void handleSubmit();
              }
            }}
            rows={4}
            maxLength={10000}
            aria-label={t("home_prompt_label")}
            placeholder={t("home_prompt_placeholder")}
            className="home-prompt-input min-h-[130px] min-w-0 flex-1 resize-y px-3 py-3 text-[15px] leading-7 text-text outline-none placeholder:text-text-4"
          />
        </div>

        <div className="home-param-grid composer-param-strip home-composer-param-strip border-t border-hairline-soft pt-3">
          <HomeSelect
            label={t("free_creation_mode")}
            value={composerMode}
            icon={composerMode === "agent" ? Bot : composerMode === "image" ? ImageIcon : Video}
            hideLabel
            className="home-composer-mode-control"
            options={[
              { value: "agent", label: t("free_creation_mode_agent") },
              { value: "image", label: t("free_creation_mode_image") },
              { value: "video", label: t("free_creation_mode_video") },
            ]}
            onChange={(nextMode) => {
              setComposerMode(nextMode);
              if (nextMode !== "agent") {
                setOutputType(nextMode);
                setModel("auto");
              }
            }}
          />
          {composerMode === "agent" ? (
            <AgentParameterControl
              label={t("free_creation_agent_parameters")}
              preferenceLabel={t("free_creation_agent_generation_preference")}
              imageLabel={t("free_creation_agent_preference_image")}
              videoLabel={t("free_creation_agent_preference_video")}
              ratioLabel={t("free_creation_aspect_ratio")}
              preference={agentPreference}
              ratio={agentAspectRatio}
              ratioOptions={agentRatioOptions}
              onPreferenceChange={setAgentPreference}
              onRatioChange={setAgentAspectRatio}
              hideLabel
            />
          ) : (
          <>
          <HomeSelect
            label={t("home_model")}
            value={selectedModel}
            icon={Settings2}
            hideLabel
            className="home-model-control"
            searchable
            searchPlaceholder={t("home_model_search")}
            emptyLabel={t("home_model_no_results")}
            options={[
              { value: "auto", label: t("home_model_auto") },
              ...models.map((item) => ({ value: item, label: modelLabel(item, t("home_model_auto")) })),
            ]}
            onChange={setModel}
          />
          {outputType === "image" ? (
            <ImageParameterControl
              label={t("home_image_settings")}
              ratioLabel={t("home_ratio")}
              resolutionLabel={t("home_resolution")}
              quantityLabel={t("home_quantity")}
              sizeLabel={t("home_size")}
              widthLabel={t("home_width")}
              heightLabel={t("home_height")}
              sizeHint={t("home_size_hint")}
              ratio={effectiveImageAspectRatio}
              resolution={effectiveImageResolution}
              quantity={quantity}
              width={imageWidth}
              height={imageHeight}
              ratioOptions={ratioOptions}
              resolutionOptions={imageResolutionOptions}
              onRatioChange={changeImageAspectRatio}
              onResolutionChange={changeImageResolution}
              onQuantityChange={setQuantity}
              onDimensionsCommit={commitImageDimensions}
              hideLabel
            />
          ) : (
            <VideoParameterControl
              label={t("home_video_settings")}
              ratioLabel={t("home_ratio")}
              resolutionLabel={t("home_resolution")}
              quantityLabel={t("home_quantity")}
              autoLabel={t("home_auto")}
              ratio={effectiveVideoAspectRatio}
              resolution={effectiveVideoResolution}
              quantity={quantity}
              ratioOptions={ratioOptions}
              resolutionOptions={videoResolutionOptions}
              onRatioChange={setVideoAspectRatio}
              onResolutionChange={setVideoResolution}
              onQuantityChange={setQuantity}
              hideLabel
            />
          )}
          {outputType === "video" ? (
            <DurationControl
              label={t("home_duration")}
              value={effectiveDuration}
              durations={videoDurations}
              onChange={setDuration}
              minimumLabel={t("home_duration_minimum", { value: videoDurations[0] ?? effectiveDuration })}
              hideLabel
            />
          ) : null}
          </>
          )}
        </div>

        <div className="mt-3 flex flex-col gap-3 border-t border-hairline-soft pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-h-5 text-[11px] text-danger-2" role="status" aria-live="polite">
            {error ?? (composerMode === "agent" ? null : capabilityError)}
          </div>
          <button
            type="button"
            disabled={!prompt.trim() || submitting || (composerMode !== "agent" && !videoCapabilitiesReady)}
            onClick={() => void handleSubmit()}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] px-5 text-[13px] font-semibold transition-transform motion-safe:hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-45"
            style={{ color: "oklch(0.14 0 0)", background: "linear-gradient(135deg, var(--color-accent-2), var(--color-accent))" }}
          >
            {submitting ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <WandSparkles className="h-4 w-4" aria-hidden />}
            {submitting ? t("home_generating") : t("home_generate")}
          </button>
        </div>
      </div>
    </section>
  );
}
