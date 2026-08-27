export type FreeCreationOutputType = "image" | "video" | "audio" | "edit";
export type FreeCreationMediaType = "image" | "video";
export type FreeCreationArtifactMediaType = FreeCreationMediaType | "audio";
export type FreeCreationUploadMediaType = "image" | "video" | "audio" | "text";
export type FreeCreationReferenceRole =
  | "first_frame"
  | "last_frame"
  | "reference_image"
  | "reference_video"
  | "reference_audio"
  | "prompt_context";

export function freeCreationUploadRole(mediaType: FreeCreationUploadMediaType): FreeCreationReferenceRole {
  if (mediaType === "video") return "reference_video";
  if (mediaType === "audio") return "reference_audio";
  if (mediaType === "text") return "prompt_context";
  return "reference_image";
}

export type FreeCreationReferenceClaim =
  | { type: "upload"; reference_id: string; role?: FreeCreationReferenceRole }
  | { type: "creation"; creation_id: string; version?: number; role?: FreeCreationReferenceRole };

export type AgentGenerationControlMode = "auto" | "custom";
export type AgentGenerationPreference = "image" | "video";

/**
 * Server-authored context for one Agent turn. It is transported separately
 * from the user's text so UI preferences never appear as user-written copy.
 */
export interface AgentGenerationPolicy {
  schema_version: 1;
  mode: AgentGenerationControlMode;
  output_type?: AgentGenerationPreference;
  aspect_ratio?: string;
  model?: string;
  resolution?: string;
  references?: FreeCreationReferenceClaim[];
}

export interface FreeCreationUpload {
  reference_id: string;
  type: "upload";
  original_filename: string;
  media_type: FreeCreationUploadMediaType;
  path: string;
  url?: string;
  size_bytes: number;
  created_at: string;
}

export interface FreeCreationCanvasState {
  revision: number;
  viewport: { x: number; y: number; scale: number };
  positions: Record<string, { x: number; y: number }>;
  hidden_creation_ids: string[];
  hidden_reference_ids?: string[];
  groups?: Array<{ group_id: string; member_ids: string[] }>;
  show_relations?: boolean;
  node_revisions?: Record<string, number>;
  recent_patch_ids?: string[];
  last_patch?: FreeCreationCanvasAppliedPatch | null;
  updated_at: string | null;
}

export interface FreeCreationCanvasAppliedPatch {
  patch_id: string;
  actor_id: string;
  base_revision: number;
  revision: number;
  changes: Omit<FreeCreationCanvasPatch, "patch_id" | "base_revision" | "target_revisions">;
}

export interface FreeCreationCanvasPatch {
  patch_id: string;
  base_revision: number;
  target_revisions: Record<string, number>;
  position_updates?: Record<string, { x: number; y: number }>;
  hidden_creation_updates?: Record<string, boolean>;
  hidden_reference_updates?: Record<string, boolean>;
  group_upserts?: Array<{ group_id: string; member_ids: string[] }>;
  group_deletes?: string[];
  show_relations?: boolean;
}

export interface FreeCreationCanvasIndex {
  version: number;
  creation_total: number;
  reference_total: number;
  total: number;
  creations: FreeCreation[];
  references: FreeCreationUpload[];
  built_at: string;
}

export interface FreeCreation {
  creation_id: string;
  request_id?: string;
  status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  output_type: FreeCreationOutputType;
  media_type?: FreeCreationArtifactMediaType;
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
  storyboard_plan_id?: string | null;
  storyboard_shot_id?: string | null;
  sequence_index?: number | null;
  media_path?: string;
  version?: number;
  task_id?: string | null;
  error_code?: string;
  error_params?: Record<string, unknown>;
  error?: string;
  updated_at?: string;
}

export type FreeCreationRequestStatus = FreeCreation["status"] | "partial";

export interface FreeCreationRequestSummary {
  request_id: string;
  prompt: string;
  output_type: FreeCreationOutputType;
  media_type: FreeCreationArtifactMediaType;
  effective_mode?: string | null;
  model?: string | null;
  reference_claims: FreeCreationReferenceClaim[];
  reference_count: number;
  aspect_ratio?: string | null;
  resolution?: string | null;
  size?: string | null;
  duration_seconds?: number | null;
  quantity: number;
  creation_ids: string[];
  result_count: number;
  status: FreeCreationRequestStatus;
  status_counts: Partial<Record<FreeCreation["status"], number>>;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FreeCreationCapabilities {
  output_type: "image" | "video";
  model: string;
  ratios: string[];
  resolutions: string[];
  durations: number[];
  max_reference_images: number | null;
  max_reference_videos: number | null;
  min_reference_video_seconds?: number | null;
  max_reference_video_seconds?: number | null;
  max_reference_video_total_seconds?: number | null;
  max_reference_audio_count?: number | null;
  max_reference_media_count: number | null;
  text_to_video?: boolean;
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
  storyboard_plan_id?: string;
  storyboard_shot_id?: string;
  sequence_index?: number;
}

export interface FreeStoryboardShot {
  shot_id: string;
  sequence_index: number;
  title: string;
  prompt: string;
  duration_seconds: number;
  image_creation_id?: string | null;
  video_creation_id?: string | null;
}

export interface FreeStoryboardPlan {
  plan_id: string;
  title: string;
  source?: { type: "upload"; reference_id: string } | { type: "prompt"; text: string } | null;
  revision: number;
  status: "draft" | "generating" | "partial" | "ready" | "failed";
  shots: FreeStoryboardShot[];
  created_at: string;
  updated_at: string;
}

export interface FreeStoryboardBatchResult {
  success: boolean;
  plan: FreeStoryboardPlan;
  request_ids: string[];
  task_ids: string[];
  creation_ids: string[];
}

export interface FreeSubtitleCue {
  start_seconds: number;
  end_seconds: number;
  text: string;
}

export interface FreeSubtitleTrack {
  subtitle_id: string;
  creation_id: string;
  revision: number;
  cues: FreeSubtitleCue[];
  created_at: string;
  updated_at: string;
}
