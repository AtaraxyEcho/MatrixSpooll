import type {
  AgentGenerationControlMode,
  AgentGenerationPreference,
  FreeCreationMediaType,
} from "@/types";
import type { FreeCreationReferenceMode } from "./FreeCreationReferenceInput";
import type { GenerationModelPreferences } from "./generationModelPreference";

export const FREE_CREATION_COMPOSER_PREFERENCES_KEY = "matrixspooll:freeCreationComposerPreferences";

export interface FreeCreationComposerPreferences {
  version?: 2;
  composerMode?: "agent" | FreeCreationMediaType;
  mediaType?: FreeCreationMediaType;
  agentControlMode?: AgentGenerationControlMode;
  agentPreference?: AgentGenerationPreference;
  agentAspectRatio?: string;
  agentModel?: string;
  agentResolution?: string;
  referenceMode?: FreeCreationReferenceMode;
  aspectRatio?: string;
  resolution?: string;
  imageWidth?: number;
  imageHeight?: number;
  customSize?: boolean;
  quantity?: number;
  duration?: number;
  collapsed?: boolean;
  modelPreferences?: GenerationModelPreferences;
}

const DEFAULT_PREFERENCES: FreeCreationComposerPreferences = {
  version: 2,
  composerMode: "video",
  mediaType: "video",
  agentControlMode: "auto",
  agentPreference: "video",
  agentAspectRatio: "smart",
  agentModel: "auto",
  agentResolution: "auto",
  referenceMode: "omni",
  aspectRatio: "16:9",
  resolution: "1080p",
  imageWidth: 1536,
  imageHeight: 864,
  customSize: false,
  quantity: 1,
  duration: 4,
  collapsed: false,
};

function storageKey(projectName: string): string {
  return `${FREE_CREATION_COMPOSER_PREFERENCES_KEY}:${encodeURIComponent(projectName)}`;
}

function isMediaType(value: unknown): value is FreeCreationMediaType {
  return value === "image" || value === "video";
}

function isComposerMode(value: unknown): value is FreeCreationComposerPreferences["composerMode"] {
  return value === "agent" || isMediaType(value);
}

function isAgentPreference(value: unknown): value is AgentGenerationPreference {
  return value === "image" || value === "video";
}

function isAgentControlMode(value: unknown): value is AgentGenerationControlMode {
  return value === "auto" || value === "custom";
}

function isReferenceMode(value: unknown): value is FreeCreationReferenceMode {
  return value === "omni" || value === "frames";
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function integerInRange(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= minimum && value <= maximum ? value : undefined;
}

function parsePreferences(value: unknown): FreeCreationComposerPreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const modelValue = record.modelPreferences;
  const modelPreferences = modelValue && typeof modelValue === "object" && !Array.isArray(modelValue)
    ? {
        image: typeof (modelValue as Record<string, unknown>).image === "string"
          ? (modelValue as Record<string, string>).image
          : "auto",
        video: typeof (modelValue as Record<string, unknown>).video === "string"
          ? (modelValue as Record<string, string>).video
          : "auto",
      }
    : undefined;
  return {
    version: 2,
    composerMode: isComposerMode(record.composerMode) ? record.composerMode : undefined,
    mediaType: isMediaType(record.mediaType) ? record.mediaType : undefined,
    agentControlMode: isAgentControlMode(record.agentControlMode)
      ? record.agentControlMode
      : isAgentPreference(record.agentPreference)
        ? "custom"
        : undefined,
    agentPreference: isAgentPreference(record.agentPreference) ? record.agentPreference : undefined,
    agentAspectRatio: typeof record.agentAspectRatio === "string" ? record.agentAspectRatio : undefined,
    agentModel: typeof record.agentModel === "string" ? record.agentModel : undefined,
    agentResolution: typeof record.agentResolution === "string" ? record.agentResolution : undefined,
    referenceMode: isReferenceMode(record.referenceMode) ? record.referenceMode : undefined,
    aspectRatio: typeof record.aspectRatio === "string" ? record.aspectRatio : undefined,
    resolution: typeof record.resolution === "string" ? record.resolution : undefined,
    imageWidth: positiveNumber(record.imageWidth),
    imageHeight: positiveNumber(record.imageHeight),
    customSize: typeof record.customSize === "boolean" ? record.customSize : undefined,
    quantity: integerInRange(record.quantity, 1, 4),
    duration: positiveNumber(record.duration),
    collapsed: typeof record.collapsed === "boolean" ? record.collapsed : undefined,
    modelPreferences,
  };
}

export function readFreeCreationComposerPreferences(projectName: string): FreeCreationComposerPreferences | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(projectName));
    return raw ? parsePreferences(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeFreeCreationComposerPreferences(
  projectName: string,
  preferences: FreeCreationComposerPreferences,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(projectName), JSON.stringify(preferences));
  } catch {
    // Keep the in-memory state when browser storage is unavailable.
  }
}

export function defaultFreeCreationComposerPreferences(): FreeCreationComposerPreferences {
  return { ...DEFAULT_PREFERENCES };
}
