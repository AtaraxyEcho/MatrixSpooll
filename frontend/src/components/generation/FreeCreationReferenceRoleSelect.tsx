import { useTranslation } from "react-i18next";
import type {
  FreeCreationCapabilities,
  FreeCreationOutputType,
  FreeCreationReferenceRole,
  FreeCreationUploadMediaType,
} from "@/types";

export interface ReferenceRoleBinding {
  mediaType: FreeCreationUploadMediaType;
  role?: FreeCreationReferenceRole;
}

export type ReferenceCompatibilityIssue = "missing_role" | "unsupported_role" | "slot_limit" | null;

const ROLE_BY_MEDIA: Record<FreeCreationUploadMediaType, FreeCreationReferenceRole[]> = {
  image: ["first_frame", "last_frame", "reference_image"],
  video: ["reference_video"],
  audio: ["reference_audio"],
  text: ["prompt_context"],
};

function candidateRoles(
  mediaType: FreeCreationUploadMediaType,
  outputType: FreeCreationOutputType,
): FreeCreationReferenceRole[] {
  if (outputType === "image" || outputType === "edit") {
    if (mediaType === "image") return ["reference_image"];
    return mediaType === "text" ? ["prompt_context"] : [];
  }
  return ROLE_BY_MEDIA[mediaType];
}

function supportsRole(
  role: FreeCreationReferenceRole,
  mediaType: FreeCreationUploadMediaType,
  capabilities: FreeCreationCapabilities | null,
  outputType?: FreeCreationOutputType,
): boolean {
  if (!capabilities) return true;
  if (outputType !== "video" && role === "reference_image" && mediaType === "image") return true;
  return Boolean(capabilities.input_slots?.some(
        (slot) => slot.role === role && slot.accepted_types.includes(mediaType),
  ));
}

export function referenceCompatibilityIssue(
  bindings: ReferenceRoleBinding[],
  capabilities: FreeCreationCapabilities | null,
): ReferenceCompatibilityIssue {
  if (bindings.some((binding) => !binding.role)) return "missing_role";
  if (!capabilities) return null;
  const counts = new Map<FreeCreationReferenceRole, number>();
  for (const binding of bindings) {
    const role = binding.role;
    if (!role || !supportsRole(role, binding.mediaType, capabilities)) return "unsupported_role";
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  for (const [role, count] of counts) {
    const slot = capabilities.input_slots?.find((item) => item.role === role);
    if (!slot || count > slot.max_count) return "slot_limit";
  }
  if ((counts.get("last_frame") ?? 0) > 0 && (counts.get("first_frame") ?? 0) === 0) {
    return "unsupported_role";
  }
  return null;
}

interface FreeCreationReferenceRoleSelectProps {
  name: string;
  mediaType: FreeCreationUploadMediaType;
  outputType: FreeCreationOutputType;
  capabilities: FreeCreationCapabilities | null;
  value?: FreeCreationReferenceRole;
  onChange: (role: FreeCreationReferenceRole) => void;
}

export function FreeCreationReferenceRoleSelect({
  name,
  mediaType,
  outputType,
  capabilities,
  value,
  onChange,
}: FreeCreationReferenceRoleSelectProps) {
  const { t } = useTranslation("dashboard");
  const roles = candidateRoles(mediaType, outputType);

  return (
    <select
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value as FreeCreationReferenceRole)}
      aria-label={t("free_creation_reference_role_label", { name })}
      className="focus-ring h-7 min-w-0 rounded border border-[var(--color-hairline-strong)] bg-[var(--color-surface-2)] px-1.5 text-[10px] text-[var(--color-text-2)]"
    >
      <option value="" disabled>{t("free_creation_reference_role_choose")}</option>
      {roles.map((role) => {
        const supported = supportsRole(role, mediaType, capabilities, outputType);
        if (!supported && value !== role) return null;
        return (
          <option key={role} value={role} disabled={!supported}>
            {t(`free_creation_reference_role_${role}`)}
            {!supported ? ` (${t("free_creation_reference_role_incompatible")})` : ""}
          </option>
        );
      })}
    </select>
  );
}
