export type FreeCreationOutputType = "image" | "video" | "edit";
export type FreeCreationMediaType = "image" | "video";
export type FreeCreationReferenceRole =
  | "first_frame"
  | "last_frame"
  | "reference_image"
  | "reference_video"
  | "reference_audio"
  | "prompt_context";

export type FreeCreationReferenceClaim =
  | { type: "upload"; reference_id: string; role?: FreeCreationReferenceRole }
  | { type: "creation"; creation_id: string; version?: number; role?: FreeCreationReferenceRole };

export interface FreeCreationUpload {
  reference_id: string;
  type: "upload";
  original_filename: string;
  media_type: "image" | "video" | "audio";
  path: string;
  size_bytes: number;
  created_at: string;
}

export interface FreeCreationCanvasState {
  revision: number;
  viewport: { x: number; y: number; scale: number };
  positions: Record<string, { x: number; y: number }>;
  hidden_creation_ids: string[];
  hidden_reference_ids?: string[];
  updated_at: string | null;
}

export interface FreeCreation {
  creation_id: string;
  request_id?: string;
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  output_type: FreeCreationOutputType;
  media_type?: FreeCreationMediaType;
  prompt?: string;
  prompt_mode?: "original";
  references?: string[];
  reference_claims?: FreeCreationReferenceClaim[];
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
  modes?: string[];
  input_slots?: Array<{ role: FreeCreationReferenceRole; accepted_types: string[]; max_count: number }>;
  combinations?: string[][];
  quantity?: { min: number; max: number };
}

export interface CreateFreeCreationRequest {
  output_type: FreeCreationOutputType;
  prompt: string;
  references?: Array<string | FreeCreationReferenceClaim>;
  aspect_ratio?: string;
  resolution?: string;
  size?: string;
  model?: string;
  quantity?: number;
  duration_seconds?: number;
  parent_creation_id?: string;
  prompt_mode?: "original";
  context?: Array<{ type: string; resource_id: string; role: "prompt_context" }>;
}
