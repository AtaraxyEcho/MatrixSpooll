import type {
  FreeCreation,
  FreeCreationMediaType,
  FreeCreationReferenceClaim,
} from "@/types";

export interface ContinuationDraft {
  mediaType: FreeCreationMediaType;
  prompt: string;
  reference: Extract<FreeCreationReferenceClaim, { type: "creation" }>;
  aspectRatio?: string;
  resolution?: string;
  model?: string;
  duration?: number;
  quantity: 1;
  imageSize?: { width: number; height: number };
}

function artifactMediaType(creation: FreeCreation): FreeCreation["media_type"] {
  if (creation.media_type) return creation.media_type;
  if (creation.output_type === "edit") return "image";
  return creation.output_type;
}

function parseImageSize(value: string | undefined): ContinuationDraft["imageSize"] {
  const match = value?.trim().match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

export function createContinuationDraft(creation: FreeCreation): ContinuationDraft | null {
  const mediaType = artifactMediaType(creation);
  if (creation.status !== "succeeded" || !creation.media_path || (mediaType !== "image" && mediaType !== "video")) {
    return null;
  }
  return {
    mediaType,
    prompt: creation.prompt ?? "",
    reference: {
      type: "creation",
      creation_id: creation.creation_id,
      ...(creation.version === undefined ? {} : { version: creation.version }),
      role: mediaType === "video" ? "reference_video" : "reference_image",
    },
    ...(creation.aspect_ratio ? { aspectRatio: creation.aspect_ratio } : {}),
    ...(creation.resolution ? { resolution: creation.resolution } : {}),
    ...(creation.model ? { model: creation.model } : {}),
    ...(mediaType === "video" && creation.duration_seconds
      ? { duration: creation.duration_seconds }
      : {}),
    quantity: 1,
    ...(mediaType === "image" && parseImageSize(creation.size)
      ? { imageSize: parseImageSize(creation.size) }
      : {}),
  };
}
