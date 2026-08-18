export type FreeCreationOutputType = "image" | "video" | "edit";

export interface FreeCreation {
  creation_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  output_type: FreeCreationOutputType;
  prompt?: string;
  prompt_mode?: "original";
  references?: string[];
  aspect_ratio?: string;
  duration_seconds?: number | null;
  parent_creation_id?: string | null;
  media_path?: string;
  task_id?: string | null;
  error?: string;
  updated_at?: string;
}

export interface CreateFreeCreationRequest {
  output_type: FreeCreationOutputType;
  prompt: string;
  references?: string[];
  aspect_ratio?: string;
  resolution?: string;
  duration_seconds?: number;
  parent_creation_id?: string;
  prompt_mode?: "original";
}
