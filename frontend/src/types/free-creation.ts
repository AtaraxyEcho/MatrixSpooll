export type FreeCreationOutputType = "image" | "video" | "edit";
export type FreeCreationMediaType = "image" | "video";

export interface FreeCreation {
  creation_id: string;
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  output_type: FreeCreationOutputType;
  media_type?: FreeCreationMediaType;
  prompt?: string;
  prompt_mode?: "original";
  references?: string[];
  aspect_ratio?: string;
  resolution?: string;
  size?: string;
  model?: string;
  quantity?: number;
  duration_seconds?: number | null;
  parent_creation_id?: string | null;
  media_path?: string;
  version?: number;
  task_id?: string | null;
  error_code?: string;
  error?: string;
  updated_at?: string;
}

export interface FreeCreationCapabilities {
  output_type: "image" | "video";
  model: string;
  ratios: string[];
  resolutions: string[];
  durations: number[];
  max_reference_images: number | null;
  max_reference_videos: number | null;
  max_reference_media_count: number | null;
}

export interface CreateFreeCreationRequest {
  output_type: FreeCreationOutputType;
  prompt: string;
  references?: string[];
  aspect_ratio?: string;
  resolution?: string;
  size?: string;
  model?: string;
  quantity?: number;
  duration_seconds?: number;
  parent_creation_id?: string;
  prompt_mode?: "original";
}
