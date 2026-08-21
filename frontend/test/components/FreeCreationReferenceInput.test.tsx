import { describe, expect, it } from "vitest";
import {
  referenceAdmissionIssue,
  type FreeCreationReferenceItem,
} from "@/components/generation/FreeCreationReferenceInput";
import type { FreeCreationCapabilities } from "@/types";

const capabilities: FreeCreationCapabilities = {
  output_type: "video",
  model: "test/video",
  modes: ["t2v", "first_frame", "first_last_frame", "reference_image", "reference_video"],
  input_slots: [
    { role: "first_frame", accepted_types: ["image"], max_count: 1 },
    { role: "last_frame", accepted_types: ["image"], max_count: 1 },
    { role: "reference_image", accepted_types: ["image"], max_count: 4 },
    { role: "reference_video", accepted_types: ["video"], max_count: 1 },
  ],
  ratios: ["16:9"],
  resolutions: ["720p"],
  durations: [4],
  max_reference_images: 4,
  max_reference_videos: 1,
  max_reference_media_count: 4,
};

const emptyItems: FreeCreationReferenceItem[] = [];

describe("referenceAdmissionIssue", () => {
  it("asks users to switch to omni reference when a video is added to frame mode", () => {
    expect(referenceAdmissionIssue({
      items: emptyItems,
      mediaType: "video",
      role: "first_frame",
      capabilities,
      outputType: "video",
      mode: "frames",
    })).toBe("frames_require_omni");
  });

  it("keeps image frame slots valid", () => {
    expect(referenceAdmissionIssue({
      items: emptyItems,
      mediaType: "image",
      role: "first_frame",
      capabilities,
      outputType: "video",
      mode: "frames",
    })).toBeNull();
  });
});
