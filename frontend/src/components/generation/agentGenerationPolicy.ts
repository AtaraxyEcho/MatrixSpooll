import type {
  AgentGenerationControlMode,
  AgentGenerationPolicy,
  AgentGenerationPreference,
  FreeCreationReferenceClaim,
} from "@/types";

interface AgentGenerationPolicyDraft {
  controlMode: AgentGenerationControlMode;
  preference: AgentGenerationPreference;
  aspectRatio: string;
  model: string;
  resolution: string;
  references?: FreeCreationReferenceClaim[];
}

export function buildAgentGenerationPolicy({
  controlMode,
  preference,
  aspectRatio,
  model,
  resolution,
  references = [],
}: AgentGenerationPolicyDraft): AgentGenerationPolicy {
  const shared = {
    schema_version: 1 as const,
    mode: controlMode,
    ...(references.length > 0 ? { references } : {}),
  };
  if (controlMode === "auto") return shared;

  return {
    ...shared,
    output_type: preference,
    ...(aspectRatio !== "smart" ? { aspect_ratio: aspectRatio } : {}),
    ...(model !== "auto" ? { model } : {}),
    ...(resolution !== "auto" ? { resolution } : {}),
  };
}
