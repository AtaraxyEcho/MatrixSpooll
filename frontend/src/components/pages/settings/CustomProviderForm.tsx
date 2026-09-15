import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import { memo } from "react";
import { Loader2, Plus, Trash2, Eye, EyeOff, CheckCircle2, XCircle, Search, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { useCapabilitiesStore } from "@/stores/capabilities-store";
import { useEndpointCatalogStore } from "@/stores/endpoint-catalog-store";
import { uid } from "@/utils/id";
import { errMsg } from "@/utils/async";
import type {
  CapabilityOverrides,
  ImageCap,
  MediaType,
  CustomProviderInfo,
  CustomProviderModelInput,
  DiscoveredModel,
  EndpointKey,
  VideoCapabilityFlags,
} from "@/types";
import {
  priceLabel,
  urlPreviewFor,
  toggleDefaultReducer,
  mergeDiscoveredModels,
  withCapabilityOverride,
  capabilityFieldsFor,
  globalBucketRefsFor,
  mergeDeclaredOptions,
  type DiscoveryFormat,
} from "./customProviderHelpers";
import { EndpointSelect } from "./EndpointSelect";
import { CapabilityOverrideRow } from "./CapabilityOverrideRow";
import { ResolutionPicker } from "@/components/shared/ResolutionPicker";
import { ASPECT_RATIO_OPTIONS } from "@/components/shared/AspectRatioPicker";
import { IMAGE_STANDARD_RESOLUTIONS, VIDEO_STANDARD_RESOLUTIONS } from "@/utils/provider-models";
import {
  compactRangeFormat,
  parseDurationInput,
  DurationParseError,
  type DurationParseErrorCode,
} from "@/utils/duration_format";

import {
  ACCENT_BTN_CLS,
  ACCENT_BUTTON_STYLE,
  CARD_STYLE,
  GHOST_BTN_CLS,
  INPUT_CLS,
} from "@/components/ui/darkroom-tokens";
import { FieldLabel } from "@/components/ui/FieldLabel";

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const COMPACT_INPUT_CLS =
  "min-w-0 rounded-[6px] border border-hairline bg-bg-grad-a/55 px-2 py-1 text-[12.5px] text-text placeholder:text-text-4 transition-colors hover:border-hairline-strong focus:border-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

const DISCOVERY_FORMAT_OPTIONS: { value: DiscoveryFormat; labelKey: string }[] = [
  { value: "openai", labelKey: "discovery_format_openai" },
  { value: "google", labelKey: "discovery_format_google" },
];

interface ModelRow {
  key: string; // unique key for React
  model_id: string;
  display_name: string;
  endpoint: EndpointKey;
  is_default: boolean;
  is_enabled: boolean;
  price_unit: string;
  price_input: string;
  price_output: string;
  currency: string;
  resolution: string; // 空串 = null
  supported_durations_text: string; // 用户原始文本，提交前 parse；空串 = 让后端按 preset 兜底
  capability_overrides: CapabilityOverrides | null;
  // 供应商文档拉取的能力声明（机器写入，随 DB 行读取）；null = 从未拉取/未落库。
  // 不参与行内快照失效与提交 payload（不是用户可编辑状态），仅用于展示声明生效值。
  vendor_capabilities: CapabilityOverrides | null;
  // 系统按 (endpoint, model_id) 判定的能力，只读展示用；null = 非视频模型，或该行尚未落库
  // （新增/改过 model_id 的行判定要后端算，前端不猜），此时控件只显示「待判定」。
  system_capabilities: VideoCapabilityFlags | null;
  // 正在引用该模型的全局 system_settings 键名，只读展示用；新增/未落库的行恒为空数组。
  global_bucket_refs: string[];
  // 行创建时的快照，之后不再变化：model_id/endpoint 的清除判断须对齐这份原始值而非上一次
  // 的中间态——逐字符编辑 model_id 时若拿"上一次的值"作基准，第一次改动即清空覆盖，之后就
  // 算把输入改回原值也已丢失、无法通过继续编辑恢复；改回原值时应从这份快照原样取回覆盖。
  original_model_id: string;
  original_endpoint: EndpointKey;
  original_capability_overrides: CapabilityOverrides | null;
  original_system_capabilities: VideoCapabilityFlags | null;
  original_global_bucket_refs: string[];
}

function newModelRow(partial?: Partial<ModelRow>): ModelRow {
  const base = {
    key: uid(),
    model_id: "",
    display_name: "",
    endpoint: "openai-chat" as EndpointKey,
    is_default: false,
    is_enabled: true,
    price_unit: "",
    price_input: "",
    price_output: "",
    currency: "USD",
    resolution: "",
    supported_durations_text: "",
    capability_overrides: null,
    vendor_capabilities: null,
    system_capabilities: null,
    global_bucket_refs: [],
    ...partial,
  };
  return {
    ...base,
    original_model_id: base.model_id,
    original_endpoint: base.endpoint,
    original_capability_overrides: base.capability_overrides,
    original_system_capabilities: base.system_capabilities,
    original_global_bucket_refs: base.global_bucket_refs,
  };
}

function discoveredToRow(m: DiscoveredModel): ModelRow {
  return newModelRow({
    model_id: m.model_id,
    display_name: m.display_name,
    endpoint: m.endpoint,
    is_default: m.is_default,
    is_enabled: m.is_enabled,
  });
}

function existingToRow(m: CustomProviderInfo["models"][number]): ModelRow {
  return newModelRow({
    model_id: m.model_id,
    display_name: m.display_name,
    endpoint: m.endpoint,
    is_default: m.is_default,
    is_enabled: m.is_enabled,
    price_unit: m.price_unit ?? "",
    price_input: m.price_input != null ? String(m.price_input) : "",
    price_output: m.price_output != null ? String(m.price_output) : "",
    currency: m.currency ?? "",
    resolution: m.resolution ?? "",
    supported_durations_text: m.supported_durations ? compactRangeFormat(m.supported_durations) : "",
    capability_overrides: m.capability_overrides,
    vendor_capabilities: m.vendor_capabilities ?? null,
    system_capabilities: m.system_capabilities,
    global_bucket_refs: m.global_bucket_refs ?? [],
  });
}

function rowToInput(r: ModelRow): CustomProviderModelInput {
  const trimmed = r.supported_durations_text.trim();
  // 失败时直接抛 DurationParseError；handleSave 在调用前应已通过 validateModelDurations 拦截，
  // 故此处只负责诚实地把字符串转成 list[int] 而不静默降级（避免无效输入被改成 null
  // 后被后端 preset 自动推断覆盖，造成静默数据偏移）
  const supported_durations = trimmed ? parseDurationInput(trimmed) : null;
  return {
    model_id: r.model_id,
    display_name: r.display_name || r.model_id,
    endpoint: r.endpoint,
    is_default: r.is_default,
    is_enabled: r.is_enabled,
    ...(r.price_unit ? { price_unit: r.price_unit } : {}),
    ...(r.price_input ? { price_input: parseFloat(r.price_input) } : {}),
    ...(r.price_output ? { price_output: parseFloat(r.price_output) } : {}),
    ...(r.currency ? { currency: r.currency } : {}),
    ...(r.resolution ? { resolution: r.resolution } : { resolution: null }),
    ...(supported_durations ? { supported_durations } : { supported_durations: null }),
    capability_overrides: r.capability_overrides,
  };
}

// 并发上限：number 输入用受控字符串存储；空串 = 未设置（null，走全局默认）。
function workersToStr(n?: number | null): string {
  return n != null ? String(n) : "";
}

// 空串 = 未设置（null，走全局默认）；否则必须是正整数（≥1）。返回 undefined 表示非法
// 输入（0、小数、科学计数、负号、含非数字字符），由 handleSave 拦截并提示——不再用 parseInt
// 静默截断（"1.5"→1、"1e3"→1）把非法值写成错误配置。0 不是合法用户输入。
function parseWorkers(s: string): number | null | undefined {
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

function WorkersInput({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="min-w-[110px]">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${INPUT_CLS} max-w-[120px]`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DurationsInputRow — 视频模型行内的 supported_durations 输入
// ---------------------------------------------------------------------------

const DURATION_ERROR_KEY: Record<DurationParseErrorCode, string> = {
  empty_after_split: "supported_durations_err_empty_after_split",
  non_positive: "supported_durations_err_non_positive",
  exceeds_max: "supported_durations_err_exceeds_max",
  range_too_large: "supported_durations_err_range_too_large",
  range_inverted: "supported_durations_err_range_inverted",
  unparseable: "supported_durations_err_unparseable",
};

function DurationsInputRow({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation("dashboard");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleChange = (next: string) => {
    onChange(next);
    if (!next.trim()) {
      setErrorMsg(null);
      return;
    }
    try {
      parseDurationInput(next);
      setErrorMsg(null);
    } catch (e) {
      if (e instanceof DurationParseError) {
        setErrorMsg(t(DURATION_ERROR_KEY[e.code], e.params));
      } else {
        setErrorMsg(t(DURATION_ERROR_KEY.unparseable, { seg: "" }));
      }
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-1 pl-6">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3 whitespace-nowrap">
          {t("supported_durations_label")}
        </span>
        <input
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={t("supported_durations_placeholder")}
          aria-label={t("supported_durations_label")}
          className={`${COMPACT_INPUT_CLS} flex-1`}
        />
      </div>
      {errorMsg ? (
        <p className="text-[11px] text-warm-bright">
          {t("supported_durations_invalid", { message: errorMsg })}
        </p>
      ) : (
        <p className="text-[11px] text-text-4">{t("supported_durations_help")}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CapabilityTogglesRow — 视频模型行内的档位/比例多选覆盖（supported_resolutions /
// supported_aspect_ratios）。chips 全不选 = 覆盖键整体移除（跟随端点判定），与三态控件的
// 「跟随判定」共用 withCapabilityOverride 的收敛语义。标准档位之外支持手动输入自定义值：
// 输入后回车或点添加即成为选中 chip；已选中的自定义值一直显示，取消勾选即移除。
// ---------------------------------------------------------------------------

const RATIO_PATTERN = /^\d{1,4}:\d{1,4}$/;

export function CapabilityTogglesRow({
  label,
  help,
  options,
  userValues,
  vendorValues,
  systemValues,
  validateCustom,
  onChange,
}: {
  label: string;
  help: string;
  options: readonly string[];
  /** 用户覆盖（稀疏键的值）；null/undefined = 用户未手动过。最高优先。 */
  userValues: string[] | null | undefined;
  /** 供应商文档声明的生效值；null/undefined = 无声明。优先级居中。 */
  vendorValues?: string[] | null;
  /** 系统判定值；null/undefined = 尚未判定（新增或改过 model_id 的行）。最低优先。 */
  systemValues?: string[] | null | undefined;
  /** 自定义值校验：null = 合法；返回已翻译的错误文案 = 拒绝添加。 */
  validateCustom?: (raw: string) => string | null;
  onChange: (next: string[] | undefined) => void;
}) {
  const { t } = useTranslation("dashboard");
  const [customDraft, setCustomDraft] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  // 生效值与来源：用户覆盖 > 文档声明 > 端点判定，chips 勾选态与来源徽章据此渲染。
  const effective = userValues ?? vendorValues ?? systemValues ?? [];
  const source: "user" | "vendor" | "system" | "none" =
    userValues != null ? "user" : vendorValues != null ? "vendor" : systemValues != null ? "system" : "none";

  const active = new Set(effective);
  // 渲染集 = 标准档位 + 已选中的自定义值（未选中的自定义值不占位，取消勾选即消失）
  const customSelected = effective.filter((value) => !options.includes(value));
  const renderOptions = [...options, ...customSelected];

  const toggle = (value: string) => {
    const next = new Set(active);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    // 声明顺序与 renderOptions 对齐，回显顺序稳定；空数组由 withCapabilityOverride 收敛成键移除
    onChange(renderOptions.filter((option) => next.has(option)));
  };

  const addCustom = () => {
    const raw = customDraft.trim();
    if (!raw) return;
    if (renderOptions.includes(raw)) {
      // 与既有 chip 重复：直接收起输入视为已添加
      setCustomDraft("");
      setCustomError(null);
      return;
    }
    const error = validateCustom?.(raw) ?? null;
    if (error) {
      setCustomError(error);
      return;
    }
    // 只把新值追加进当前生效集；renderOptions 是含未勾选标准档位的完整渲染集，
    // 不能整体当作选中集写入，否则回车后所有标准档位都会被勾上
    onChange([...effective, raw]);
    setCustomDraft("");
    setCustomError(null);
  };

  // 来源徽章：让「这些参数是谁定的」一眼可辨——用户改动琥珀、文档声明强调色、端点判定绿色。
  const SOURCE_BADGES: Record<string, { text: string; style: CSSProperties } | null> = {
    user: {
      text: t("capability_source_user_badge"),
      style: {
        color: "var(--color-warm-bright)",
        background: "var(--color-warm-tint)",
        border: "1px solid var(--color-warm-ring)",
      },
    },
    vendor: {
      text: t("vendor_declaration_active"),
      style: {
        color: "var(--color-accent-2)",
        background: "var(--color-accent-dim)",
        border: "1px solid var(--color-accent-soft)",
      },
    },
    system: {
      text: t("capability_source_endpoint_badge"),
      style: {
        color: "var(--color-good)",
        background: "oklch(0.30 0.10 155 / 0.18)",
        border: "1px solid oklch(0.45 0.10 155 / 0.40)",
      },
    },
    none: null,
  };
  const sourceBadge = SOURCE_BADGES[source];

  return (
    <div className="mt-2 flex flex-col gap-1 pl-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3 whitespace-nowrap">
          {label}
        </span>
        {sourceBadge && (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.05em]"
            style={sourceBadge.style}
          >
            {sourceBadge.text}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
          {renderOptions.map((option) => {
            const isActive = active.has(option);
            return (
              <button
                key={option}
                type="button"
                aria-pressed={isActive}
                onClick={() => toggle(option)}
                title={option}
                className="rounded-[6px] px-2 py-1 font-mono text-[10.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                style={
                  isActive
                    ? {
                        color: "var(--color-accent-2)",
                        background: "var(--color-accent-dim)",
                        border: "1px solid var(--color-accent-soft)",
                      }
                    : {
                        color: "var(--color-text-3)",
                        background: "var(--color-bg-grad-a)",
                        border: "1px solid var(--color-hairline)",
                      }
                }
              >
                {option}
              </button>
            );
          })}
          <input
            type="text"
            value={customDraft}
            onChange={(e) => {
              setCustomDraft(e.target.value);
              setCustomError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
            placeholder={t("capability_custom_value_placeholder")}
            aria-label={t("capability_custom_add")}
            className={`${COMPACT_INPUT_CLS} w-28`}
          />
          <button
            type="button"
            onClick={addCustom}
            aria-label={t("capability_custom_add")}
            title={t("capability_custom_add")}
            className="rounded-[6px] p-1.5 text-text-4 transition-colors hover:text-accent-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>
      {customError ? (
        <p className="text-[11px] text-warm-bright">{customError}</p>
      ) : (
        <p className="text-[11px] text-text-4">{help}</p>
      )}
      {source === "vendor" && <p className="text-[11px] text-text-4">{t("vendor_declaration_active_hint")}</p>}
      {userValues != null && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="self-start rounded-[6px] border px-2 py-0.5 text-[11px] font-semibold transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={{
            color: "var(--color-accent-2)",
            background: "var(--color-accent-dim)",
            border: "1px solid var(--color-accent-soft)",
          }}
        >
          {t("capability_clear_override")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModelCard —— 单个模型行（memo 化）。表单可能有一百多行重型模型行，任何一次行内
// 编辑都只应重渲染被编辑的那一行：updateModel/removeModel/setModels 均为稳定引用，
// m 在未编辑行上保持对象身份，memo 浅比较即可跳过其余行。行来源徽章/档位 chips/
// 声明合并等逻辑随行迁移，父组件只管列表状态。
// ---------------------------------------------------------------------------

const ModelCard = memo(function ModelCard({
  m,
  updateModel,
  removeModel,
  setModels,
  endpointToMediaType,
  endpointToImageCapabilities,
  endpointToEndImageCapable,
}: {
  m: ModelRow;
  updateModel: (key: string, patch: Partial<ModelRow>) => void;
  removeModel: (key: string) => void;
  setModels: Dispatch<SetStateAction<ModelRow[]>>;
  endpointToMediaType: Record<string, MediaType>;
  endpointToImageCapabilities: Record<string, ImageCap[] | undefined>;
  endpointToEndImageCapable: Record<string, boolean>;
}) {
  const { t } = useTranslation("dashboard");
  const pl = priceLabel(m.endpoint, endpointToMediaType, t);
  const media = endpointToMediaType[m.endpoint];
  // 文档声明的生效值：绑定同步时的 model_id（改过 id 即视为过期，等下次同步刷新）。
  const vendorFresh = m.model_id === m.original_model_id;
  const vendorRes = vendorFresh ? (m.vendor_capabilities?.supported_resolutions ?? null) : null;
  const vendorRatios = vendorFresh ? (m.vendor_capabilities?.supported_aspect_ratios ?? null) : null;
  return (
                  <div
                    key={m.key}
                    className="rounded-[10px] border border-hairline p-3 [content-visibility:auto] [contain-intrinsic-size:auto_150px]"
                    style={CARD_STYLE}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Enable toggle */}
                      <label className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={m.is_enabled}
                          onChange={(e) => updateModel(m.key, { is_enabled: e.target.checked })}
                          className="h-3.5 w-3.5 cursor-pointer rounded border-hairline bg-bg-grad-a accent-[var(--color-accent)]"
                          aria-label={t("enable_model")}
                        />
                      </label>

                      {/* Model ID —— 包裹层给最小宽度：输入框本体是 flex-1 + min-w-0，
                          空间不足时会被右侧控件挤压到不可见；有了最小宽度，flex-wrap 会把
                          右侧控件折行而不是把名称压没 */}
                      <div className="min-w-[160px] flex-1">
                        <input
                          type="text"
                          value={m.model_id}
                          onChange={(e) => {
                            const nextId = e.target.value;
                            updateModel(m.key, {
                              model_id: nextId,
                              // 覆盖与判定都随 (endpoint, model_id) 作废/恢复，见 capabilityFieldsFor
                              ...capabilityFieldsFor(m, nextId, m.endpoint),
                              // 引用事实只绑 model_id，见 globalBucketRefsFor
                              global_bucket_refs: globalBucketRefsFor(m, nextId),
                            });
                          }}
                          placeholder="model-id…"
                          aria-label={t("model_id_label")}
                          className={`${COMPACT_INPUT_CLS} w-full`}
                        />
                      </div>

                      {/* Endpoint select (custom dropdown showing real API path) */}
                      <EndpointSelect
                        value={m.endpoint}
                        onChange={(next) =>
                          updateModel(m.key, {
                            endpoint: next,
                            is_default: false,
                            // 覆盖的合法性本身随 endpoint 变化（last_frame 要求目标 endpoint 支持
                            // 尾帧），切走即作废；切回原 endpoint 且 model_id 未变则原样取回。
                            // 用户改动后控件会可见地弹回「跟随判定」，作废行为在界面上有反馈。
                            ...capabilityFieldsFor(m, m.model_id, next),
                          })
                        }
                        ariaLabel={t("endpoint_label")}
                      />

                      {/* Default toggle */}
                      <button
                        type="button"
                        onClick={() =>
                          setModels((prev) =>
                            toggleDefaultReducer(prev, m.key, endpointToMediaType, endpointToImageCapabilities),
                          )
                        }
                        className="rounded-[6px] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        style={
                          m.is_default
                            ? {
                                background: "var(--color-accent-dim)",
                                color: "var(--color-accent-2)",
                                border: "1px solid var(--color-accent-soft)",
                                boxShadow: "0 0 12px -6px var(--color-accent-glow)",
                              }
                            : {
                                background: "var(--color-bg-grad-a)",
                                color: "var(--color-text-3)",
                                border: "1px solid var(--color-hairline)",
                              }
                        }
                      >
                        {t("default_label")}
                      </button>

                      {/* Remove */}
                      <button
                        type="button"
                        onClick={() => removeModel(m.key)}
                        className="rounded p-1 text-text-4 transition-colors hover:text-warm-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        aria-label={t("delete_model")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* 全局桶引用提示（非阻塞展示，不影响保存） */}
                    {m.global_bucket_refs.length > 0 && (
                      <p className="mt-2 flex items-center gap-1.5 pl-6 text-[11px] text-text-4">
                        <Link2 className="h-3 w-3 shrink-0" />
                        {t("global_bucket_ref_hint", {
                          buckets: m.global_bucket_refs.map((key) => t(`global_bucket_label_${key}`)).join(t("global_bucket_ref_separator")),
                        })}
                      </p>
                    )}

                    {/* Pricing row */}
                    <div className="mt-2 flex flex-wrap items-center gap-2 pl-6 text-[11px] text-text-4">
                      <select
                        value={m.currency}
                        onChange={(e) => updateModel(m.key, { currency: e.target.value })}
                        aria-label={t("currency_label")}
                        className="rounded-[5px] border border-hairline bg-bg-grad-a/55 px-1 py-0.5 text-[11px] text-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <option value="USD">$</option>
                        <option value="CNY">&yen;</option>
                      </select>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={m.price_input}
                        onChange={(e) => updateModel(m.key, { price_input: e.target.value })}
                        placeholder="0.00"
                        aria-label={t("input_price")}
                        className={`${COMPACT_INPUT_CLS} w-16`}
                      />
                      <span>{pl.input}</span>
                      {pl.output && (
                        <>
                          <span className="text-text-4">|</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={m.price_output}
                            onChange={(e) => updateModel(m.key, { price_output: e.target.value })}
                            placeholder="0.00"
                            aria-label={t("output_price")}
                            className={`${COMPACT_INPUT_CLS} w-16`}
                          />
                          <span>{pl.output}</span>
                        </>
                      )}
                    </div>

                    {/* Resolution row（仅 image/video，audio 无分辨率维度） */}
                    {(media === "image" || media === "video") && (
                      <div className="mt-2 flex flex-col gap-1 pl-6">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3 whitespace-nowrap">
                            {t("resolution_default_label")}
                          </span>
                          {/* INPUT_CLS 自带 w-full，不限定宽度会横向撑满整行；档位值只有
                              "1920x1080" 这类短 token，固定宽度即可 */}
                          <div className="w-40">
                            <ResolutionPicker
                              mode="combobox"
                              options={media === "image" ? IMAGE_STANDARD_RESOLUTIONS : VIDEO_STANDARD_RESOLUTIONS}
                              value={m.resolution || null}
                              onChange={(v) => updateModel(m.key, { resolution: v ?? "" })}
                              placeholder={t("resolution_default_placeholder")}
                              aria-label={t("resolution_default_label")}
                            />
                          </div>
                        </div>
                        <p className="text-[11px] text-text-4">{t("resolution_default_help")}</p>
                      </div>
                    )}

                    {/* Supported durations row（仅 video endpoint） */}
                    {media === "video" && (
                      <DurationsInputRow
                        value={m.supported_durations_text}
                        onChange={(v) => updateModel(m.key, { supported_durations_text: v })}
                      />
                    )}

                    {/* 分辨率档位 / 宽高比覆盖（仅 video endpoint）：生成页对应下拉的选项来源。
                        自定义模型没有注册表档位，端点未声明时全靠这里手动配置。 */}
                    {media === "video" && (
                      <>
                        <CapabilityTogglesRow
                          label={t("supported_resolutions_label")}
                          help={t("supported_resolutions_help")}
                          options={mergeDeclaredOptions(
                            m.system_capabilities?.supported_resolutions ?? [],
                            VIDEO_STANDARD_RESOLUTIONS,
                          )}
                          userValues={m.capability_overrides?.supported_resolutions}
                          vendorValues={vendorRes}
                          systemValues={m.system_capabilities?.supported_resolutions}
                          onChange={(next) =>
                            updateModel(m.key, {
                              capability_overrides: withCapabilityOverride(
                                m.capability_overrides,
                                "supported_resolutions",
                                next,
                              ),
                            })
                          }
                        />
                        <CapabilityTogglesRow
                          label={t("supported_ratios_label")}
                          help={t("supported_ratios_help")}
                          options={mergeDeclaredOptions(
                            m.system_capabilities?.supported_aspect_ratios ?? [],
                            ASPECT_RATIO_OPTIONS.map((option) => option.value),
                          )}
                          userValues={m.capability_overrides?.supported_aspect_ratios}
                          vendorValues={vendorRatios}
                          systemValues={m.system_capabilities?.supported_aspect_ratios}
                          validateCustom={(raw) =>
                            RATIO_PATTERN.test(raw) ? null : t("capability_custom_ratio_invalid")
                          }
                          onChange={(next) =>
                            updateModel(m.key, {
                              capability_overrides: withCapabilityOverride(
                                m.capability_overrides,
                                "supported_aspect_ratios",
                                next,
                              ),
                            })
                          }
                        />
                      </>
                    )}

                    {/* 能力覆盖行（仅 video endpoint；布尔维度现开放 last_frame） */}
                    {media === "video" && (
                      <CapabilityOverrideRow
                        override={m.capability_overrides?.last_frame}
                        systemValue={m.system_capabilities?.last_frame ?? null}
                        endImageCapable={endpointToEndImageCapable[m.endpoint] ?? false}
                        onChange={(next) =>
                          updateModel(m.key, {
                            capability_overrides: withCapabilityOverride(
                              m.capability_overrides,
                              "last_frame",
                              next,
                            ),
                          })
                        }
                      />
                    )}
                  </div>

  );
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CustomProviderFormProps {
  existing?: CustomProviderInfo | null;
  onSaved: () => void;
  onCancel: () => void;
}

export function CustomProviderForm({ existing, onSaved, onCancel }: CustomProviderFormProps) {
  const { t } = useTranslation("dashboard");
  const isEdit = !!existing;

  // Endpoint catalog（后端单一真相源）：mediaType 推断、price/default 互斥分组都从这里读。
  const endpointToMediaType = useEndpointCatalogStore((s) => s.endpointToMediaType);
  const endpointToImageCapabilities = useEndpointCatalogStore((s) => s.endpointToImageCapabilities);
  const endpointToEndImageCapable = useEndpointCatalogStore((s) => s.endpointToEndImageCapable);
  const fetchEndpointCatalog = useEndpointCatalogStore((s) => s.fetch);
  useEffect(() => {
    void fetchEndpointCatalog();
  }, [fetchEndpointCatalog]);

  // --- Form state ---
  const [displayName, setDisplayName] = useState(existing?.display_name ?? "");
  const [discoveryFormat, setDiscoveryFormat] = useState<DiscoveryFormat>(existing?.discovery_format ?? "openai");
  const [baseUrl, setBaseUrl] = useState(existing?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState<ModelRow[]>(
    existing ? existing.models.map(existingToRow) : [],
  );
  const [imageMaxWorkers, setImageMaxWorkers] = useState(workersToStr(existing?.image_max_workers));
  const [videoMaxWorkers, setVideoMaxWorkers] = useState(workersToStr(existing?.video_max_workers));
  const [audioMaxWorkers, setAudioMaxWorkers] = useState(workersToStr(existing?.audio_max_workers));

  // --- Loading / status ---
  const [discovering, setDiscovering] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const showError = useCallback((msg: string) => useAppStore.getState().pushToast(msg, "error"), []);
  const [modelFilter, setModelFilter] = useState("");
  // 渐进渲染：中转商模型可能上百个，全量挂载会冻结主线程数秒。首屏只挂
  // VISIBLE_BATCH 行，滚动接近列表尾（哨兵进入视口）再追加一批。
  const [visibleCount, setVisibleCount] = useState(40);
  const listSentinelRef = useRef<HTMLDivElement | null>(null);

  const filteredModels = useMemo(() => {
    if (!modelFilter.trim()) return models;
    const q = modelFilter.toLowerCase();
    return models.filter((m) => m.model_id.toLowerCase().includes(q));
  }, [models, modelFilter]);

  const allFilteredEnabled = useMemo(
    () => filteredModels.length > 0 && filteredModels.every((m) => m.is_enabled),
    [filteredModels],
  );
  const visibleModels = useMemo(
    () => filteredModels.slice(0, visibleCount),
    [filteredModels, visibleCount],
  );

  // 哨兵进入视口（含预留 600px）→ 追加一批；筛选结果比已渲染数还少时无需追加。
  useEffect(() => {
    const el = listSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => Math.min(count + 40, filteredModels.length));
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [filteredModels.length]);

  // base_url 相对存储值是否变更：变更后必须用 UI 上的新地址 + 新 key 走明文路径，
  // 否则 by-id 端点会用 DB 中的旧 base_url，与保存的新地址错位。
  const baseUrlChanged = !!existing && baseUrl.trim() !== existing.base_url.trim();
  // 编辑模式下若用户未输入新 key 且 base_url 未变更，则用已存储凭证（by-id 端点）；
  // 创建模式或 base_url 变更时必须明文 api_key。发现模型与测试连接共用此判断。
  const useStoredCredential = !!existing && !apiKey && !baseUrlChanged;

  // --- Discover models ---
  const handleDiscover = useCallback(async () => {
    if (!baseUrl) {
      showError(t("fill_base_url_first"));
      return;
    }
    if (!useStoredCredential && !apiKey) {
      showError(t(baseUrlChanged ? "base_url_changed_reenter_key" : "fill_api_key_first"));
      return;
    }
    setDiscovering(true);
    try {
      const res = useStoredCredential
        ? await API.discoverModelsForProvider(existing.id)
        : await API.discoverModels({ discovery_format: discoveryFormat, base_url: baseUrl, api_key: apiKey });
      const discovered = res.models.map(discoveredToRow);
      // 用 getState 读最新 catalog 映射，而非 handleDiscover 闭包捕获的渲染期值：catalog 在
      // mount 时异步拉取，若用户在其就绪前点「获取模型」，闭包里仍是空 map，合并会跳过默认
      // 消解，保存时可能 default_model_conflict。
      const { endpointToMediaType: mediaMap, endpointToImageCapabilities: capsMap } =
        useEndpointCatalogStore.getState();
      setModels((prev) => mergeDiscoveredModels(prev, discovered, mediaMap, capsMap));
      setModelFilter("");
    } catch (e) {
      showError(errMsg(e, t("fetch_models_failed")));
    } finally {
      setDiscovering(false);
    }
  }, [discoveryFormat, baseUrl, apiKey, useStoredCredential, baseUrlChanged, existing, showError, t]);

  // --- Test connection ---
  const handleTest = useCallback(async () => {
    // 清空上一次结果放在所有校验之前：校验失败直接 return 时也不残留旧的成功/失败提示。
    setTestResult(null);
    if (!baseUrl) {
      showError(t("fill_base_url_first"));
      return;
    }
    if (!useStoredCredential && !apiKey) {
      showError(t(baseUrlChanged ? "base_url_changed_reenter_key" : "fill_api_key_first"));
      return;
    }
    setTesting(true);
    try {
      const res = useStoredCredential
        ? await API.testCustomConnectionById(existing.id)
        : await API.testCustomConnection({ discovery_format: discoveryFormat, base_url: baseUrl, api_key: apiKey });
      setTestResult(res);
    } catch (e) {
      setTestResult({ success: false, message: errMsg(e, t("connection_test_failed")) });
    } finally {
      setTesting(false);
    }
  }, [discoveryFormat, baseUrl, apiKey, useStoredCredential, baseUrlChanged, existing, showError, t]);

  // --- Save ---
  const handleSave = useCallback(async () => {
    // Validation
    if (!displayName.trim()) {
      showError(t("fill_provider_name"));
      return;
    }
    if (!baseUrl.trim()) {
      showError(t("fill_base_url"));
      return;
    }
    if (!isEdit && !apiKey.trim()) {
      showError(t("fill_api_key"));
      return;
    }
    const enabledModels = models.filter((m) => m.is_enabled);
    if (enabledModels.length === 0) {
      showError(t("enable_one_model"));
      return;
    }
    const emptyId = enabledModels.find((m) => !m.model_id.trim());
    if (emptyId) {
      showError(t("enabled_model_needs_id"));
      return;
    }
    // 在拼装 payload 前显式校验所有行的 supported_durations 格式：失败则阻断保存，
    // 让用户回去修正标红字段；不再让 rowToInput 静默把非法降级为 null
    let payloadModels: CustomProviderModelInput[];
    try {
      payloadModels = models.map(rowToInput);
    } catch (e) {
      if (e instanceof DurationParseError) {
        const msg = t(DURATION_ERROR_KEY[e.code], e.params);
        showError(t("supported_durations_invalid", { message: msg }));
      } else {
        showError(t("save_failed", { message: errMsg(e) }));
      }
      return;
    }
    // 并发上限严格解析：非法（小数/科学计数/负号/非数字）→ undefined，阻断保存并提示
    const imageMax = parseWorkers(imageMaxWorkers);
    const videoMax = parseWorkers(videoMaxWorkers);
    const audioMax = parseWorkers(audioMaxWorkers);
    if (imageMax === undefined || videoMax === undefined || audioMax === undefined) {
      showError(t("max_workers_invalid"));
      return;
    }
    setSaving(true);
    try {
      if (isEdit && existing) {
        // 单个事务原子更新 provider + models
        await API.fullUpdateCustomProvider(existing.id, {
          display_name: displayName,
          base_url: baseUrl,
          ...(apiKey ? { api_key: apiKey } : {}),
          models: payloadModels,
          image_max_workers: imageMax,
          video_max_workers: videoMax,
          audio_max_workers: audioMax,
        });
      } else {
        await API.createCustomProvider({
          display_name: displayName,
          discovery_format: discoveryFormat,
          base_url: baseUrl,
          api_key: apiKey,
          models: payloadModels,
          image_max_workers: imageMax,
          video_max_workers: videoMax,
          audio_max_workers: audioMax,
        });
      }
      // 能力覆盖随本次保存落库，但它不落任何项目字段，在用的能力查询不会因 props 变化而重取；
      // 显式作废，让常驻的能力警告无需重新挂载组件即随新覆盖增减。
      useCapabilitiesStore.getState().invalidate();
      onSaved();
    } catch (e) {
      showError(t("save_failed", { message: errMsg(e) }));
    } finally {
      setSaving(false);
    }
  }, [
    displayName,
    discoveryFormat,
    baseUrl,
    apiKey,
    models,
    imageMaxWorkers,
    videoMaxWorkers,
    audioMaxWorkers,
    isEdit,
    existing,
    onSaved,
    showError,
    t,
  ]);

  // --- Model row helpers ---
  // 稳定引用（配合 ModelCard 的 memo）：回调身份不变，未编辑的行才能跳过重渲染。
  const updateModel = useCallback((key: string, patch: Partial<ModelRow>) => {
    setModels((prev) => prev.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  }, []);

  const removeModel = useCallback((key: string) => {
    setModels((prev) => prev.filter((m) => m.key !== key));
  }, []);

  const addManualModel = useCallback(() => {
    setModels((prev) => [...prev, newModelRow()]);
    // 新行排在列表末尾：放开渐进渲染上限，避免新行落在未渲染区
    setVisibleCount(Number.MAX_SAFE_INTEGER);
  }, []);

  // --- Base URL preview (effective models endpoint) ---
  const urlPreview = urlPreviewFor(discoveryFormat, baseUrl);

  return (
    <div>
      {/* Form content */}
      <div className="p-6 pb-24">
      <div className="max-w-2xl">
      <div className="mb-6">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-accent-2">
          {isEdit ? "EDIT PROVIDER" : "NEW PROVIDER"}
        </div>
        <h3
          className="font-editorial mt-1"
          style={{
            fontWeight: 400,
            fontSize: 22,
            lineHeight: 1.1,
            letterSpacing: "-0.012em",
            color: "var(--color-text)",
          }}
        >
          {isEdit ? t("edit_custom_provider") : t("add_custom_provider_title")}
        </h3>
      </div>

      <div className="space-y-4">
        {/* Display name */}
        <div>
          <FieldLabel htmlFor="cp-name" required>
            {t("cp_name_label")}
          </FieldLabel>
          <input
            id="cp-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("cp_name_placeholder")}
            className={INPUT_CLS}
          />
        </div>

        {/* Base URL */}
        <div>
          <FieldLabel htmlFor="cp-url" required>
            {t("base_url")}
          </FieldLabel>
          <input
            id="cp-url"
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com"
            className={INPUT_CLS}
          />
          {urlPreview && (
            <div className="mt-1.5 truncate font-mono text-[10.5px] text-text-4">
              {t("preview_url")}
              {urlPreview}
            </div>
          )}
        </div>

        {/* API Key */}
        <div>
          <FieldLabel htmlFor="cp-key" required={!isEdit}>
            {t("api_key_label")}
          </FieldLabel>
          <div className="relative">
            <input
              id="cp-key"
              type={showApiKey ? "text" : "password"}
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isEdit ? existing?.api_key_masked ?? t("keep_existing_key_hint") : t("enter_api_key_placeholder")}
              className={`${INPUT_CLS} pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowApiKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded text-text-4 transition-colors hover:text-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={showApiKey ? t("common:hide") : t("common:show")}
            >
              {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {/* Discovery format (de-emphasized) */}
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="cp-discovery"
            className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-4"
          >
            {t("discovery_format_label")}
          </label>
          <select
            id="cp-discovery"
            value={discoveryFormat}
            onChange={(e) => setDiscoveryFormat(e.target.value as DiscoveryFormat)}
            disabled={isEdit}
            className="rounded-[6px] border border-hairline bg-bg-grad-a/55 px-2 py-1 text-[11.5px] text-text-2 hover:border-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            {DISCOVERY_FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
            ))}
          </select>
          <span className="font-mono text-[10.5px] text-text-4">{t("discovery_format_help")}</span>
        </div>

        {/* Discover button */}
        <div>
          <button
            type="button"
            onClick={() => void handleDiscover()}
            disabled={discovering}
            className={GHOST_BTN_CLS}
          >
            {discovering ? (
              <>
                <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
                {t("discovering_models")}
              </>
            ) : (
              t("discover_models")
            )}
          </button>
        </div>

        {/* Model list */}
        {models.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-3">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-accent-2">
                {t("model_list")}
              </span>
              {models.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    const targetKeys = new Set(filteredModels.map((m) => m.key));
                    setModels((prev) =>
                      prev.map((m) => (targetKeys.has(m.key) ? { ...m, is_enabled: !allFilteredEnabled } : m)),
                    );
                  }}
                  className="font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-text-3 transition-colors hover:text-accent-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {allFilteredEnabled ? t("deselect_all") : t("select_all")}
                </button>
              )}
            </div>
            {models.length > 5 && (
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-4" />
                <input
                  type="text"
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder={t("search_models")}
                  className={`${INPUT_CLS} py-1.5 pl-8 pr-3 text-[12px]`}
                />
              </div>
            )}
            <div className="space-y-2">
              {visibleModels.map((m) => (
                <ModelCard
                  key={m.key}
                  m={m}
                  updateModel={updateModel}
                  removeModel={removeModel}
                  setModels={setModels}
                  endpointToMediaType={endpointToMediaType}
                  endpointToImageCapabilities={endpointToImageCapabilities}
                  endpointToEndImageCapable={endpointToEndImageCapable}
                />
              ))}
              {visibleCount < filteredModels.length && (
                <div ref={listSentinelRef} className="h-6" aria-hidden />
              )}
            </div>

            {/* Add manual model */}
            <button
              type="button"
              onClick={addManualModel}
              className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-text-3 transition-colors hover:text-accent-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("add_model_manually")}
            </button>
          </div>
        )}

        {/* Empty model hint */}
        {models.length === 0 && (
          <div className="rounded-[10px] border border-dashed border-hairline-strong bg-bg-grad-a/45 p-4 text-center text-[12.5px] text-text-3">
            {t("discover_or_add_hint")}
            <button
              type="button"
              onClick={addManualModel}
              className="ml-1 font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-accent-2 transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("add_model_manually")}
            </button>
          </div>
        )}

        {/* Concurrency limits */}
        <div>
          <div className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-accent-2">
            {t("cp_concurrency_label")}
          </div>
          <p className="mb-3 text-[11px] text-text-4">{t("cp_concurrency_help")}</p>
          <div className="flex flex-wrap gap-4">
            <WorkersInput
              id="cp-image-workers"
              label={t("cp_image_max_workers_label")}
              value={imageMaxWorkers}
              onChange={setImageMaxWorkers}
              placeholder={t("cp_max_workers_placeholder")}
            />
            <WorkersInput
              id="cp-video-workers"
              label={t("cp_video_max_workers_label")}
              value={videoMaxWorkers}
              onChange={setVideoMaxWorkers}
              placeholder={t("cp_max_workers_placeholder")}
            />
            <WorkersInput
              id="cp-audio-workers"
              label={t("cp_audio_max_workers_label")}
              value={audioMaxWorkers}
              onChange={setAudioMaxWorkers}
              placeholder={t("cp_max_workers_placeholder")}
            />
          </div>
        </div>

        {/* Test result */}
        {testResult && (
          <div
            aria-live="polite"
            className="flex items-start gap-2 rounded-[8px] px-3 py-2 text-[12.5px]"
            style={
              testResult.success
                ? {
                    background: "oklch(0.30 0.10 155 / 0.15)",
                    color: "var(--color-good)",
                    border: "1px solid oklch(0.45 0.10 155 / 0.30)",
                  }
                : {
                    background: "var(--color-warm-tint)",
                    color: "var(--color-warm-bright)",
                    border: "1px solid var(--color-warm-ring)",
                  }
            }
          >
            {testResult.success ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span>{testResult.message}</span>
          </div>
        )}

      </div>
      </div>{/* end max-w-2xl */}
      </div>{/* end form content */}

      {/* Sticky actions bar */}
      <div
        className="sticky bottom-0 z-10 border-t border-hairline px-6 py-3 backdrop-blur"
        style={{
          background:
            "linear-gradient(180deg, oklch(0.20 0.011 265 / 0.65), oklch(0.15 0.010 265 / 0.85))",
        }}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className={ACCENT_BTN_CLS}
            style={ACCENT_BUTTON_STYLE}
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
                {t("common:saving")}
              </>
            ) : (
              t("common:save")
            )}
          </button>

          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing}
            className={GHOST_BTN_CLS}
          >
            {testing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
                {t("testing_connection")}
              </>
            ) : (
              t("test_connection")
            )}
          </button>

          <button
            type="button"
            onClick={onCancel}
            className="rounded-[8px] px-3 py-1.5 text-[12.5px] text-text-3 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("common:cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
