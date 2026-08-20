export type GenerationModelMediaType = "image" | "video";

export interface GenerationModelPreferences {
  image: string;
  video: string;
}

export const GENERATION_MODEL_PREFERENCES_STORAGE_KEY = "arcreel:generationModelPreferences";

const DEFAULT_PREFERENCES: GenerationModelPreferences = {
  image: "auto",
  video: "auto",
};

export function readGenerationModelPreferences(): GenerationModelPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_PREFERENCES };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GENERATION_MODEL_PREFERENCES_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return {
      image: typeof parsed.image === "string" && parsed.image ? parsed.image : "auto",
      video: typeof parsed.video === "string" && parsed.video ? parsed.video : "auto",
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writeGenerationModelPreference(
  current: GenerationModelPreferences,
  mediaType: GenerationModelMediaType,
  model: string,
): GenerationModelPreferences {
  const next = { ...current, [mediaType]: model || "auto" };
  try {
    window.localStorage.setItem(GENERATION_MODEL_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
  return next;
}
