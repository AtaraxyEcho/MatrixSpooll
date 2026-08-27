import { describe, expect, it } from "vitest";
import { createContinuationDraft } from "@/components/generation/continuation-draft";
import type { FreeCreation } from "@/types";

describe("continuation draft", () => {
  it("turns a successful image into a versioned, single-output draft", () => {
    const creation: FreeCreation = {
      creation_id: "c_image",
      output_type: "image",
      media_type: "image",
      status: "succeeded",
      prompt: "quiet street at night",
      media_path: "creations/c_image.png",
      version: 4,
      aspect_ratio: "16:9",
      resolution: "2k",
      size: "2048x1152",
      quantity: 4,
      model: "provider/image-model",
    };

    expect(createContinuationDraft(creation)).toEqual({
      mediaType: "image",
      prompt: "quiet street at night",
      reference: {
        type: "creation",
        creation_id: "c_image",
        version: 4,
        role: "reference_image",
      },
      aspectRatio: "16:9",
      resolution: "2k",
      model: "provider/image-model",
      quantity: 1,
      imageSize: { width: 2048, height: 1152 },
    });
  });

  it("preserves supported video settings without copying the old quantity", () => {
    const creation: FreeCreation = {
      creation_id: "c_video",
      output_type: "video",
      media_type: "video",
      status: "succeeded",
      prompt: "camera follows the runner",
      media_path: "creations/c_video.mp4",
      version: 3,
      aspect_ratio: "9:16",
      resolution: "1080p",
      duration_seconds: 12,
      quantity: 3,
      model: "provider/video-model",
    };

    expect(createContinuationDraft(creation)).toMatchObject({
      mediaType: "video",
      prompt: creation.prompt,
      duration: 12,
      quantity: 1,
      reference: {
        type: "creation",
        creation_id: creation.creation_id,
        version: 3,
        role: "reference_video",
      },
    });
  });

  it("rejects unfinished, missing-media, and audio artifacts", () => {
    const base: FreeCreation = {
      creation_id: "c_invalid",
      output_type: "image",
      media_type: "image",
      status: "failed",
      media_path: "creations/c_invalid.png",
    };

    expect(createContinuationDraft(base)).toBeNull();
    expect(createContinuationDraft({ ...base, status: "succeeded", media_path: undefined })).toBeNull();
    expect(createContinuationDraft({
      ...base,
      status: "succeeded",
      output_type: "audio",
      media_type: "audio",
    })).toBeNull();
  });
});
