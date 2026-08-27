import { describe, expect, it } from "vitest";
import {
  imageDimensionsForManualInput,
  imageDimensionsForPreset,
  selectableImageResolutionOptions,
} from "@/components/generation/image-parameters";

describe("imageDimensionsForPreset", () => {
  it("uses the backend image tier short-edge rules", () => {
    expect(imageDimensionsForPreset("1K", "16:9")).toEqual({ width: 1792, height: 1008 });
    expect(imageDimensionsForPreset("2K", "16:9")).toEqual({ width: 2560, height: 1440 });
    expect(imageDimensionsForPreset("4K", "9:16")).toEqual({ width: 2160, height: 3840 });
  });

  it("derives the ratio from an explicit capability size instead of keeping its embedded ratio", () => {
    expect(imageDimensionsForPreset("2048*1152", "1:1")).toEqual({ width: 1152, height: 1152 });
  });

  it("keeps only model-declared image tiers above the removed 512px preset", () => {
    expect(selectableImageResolutionOptions(["512px", "1K", "2K", "2k", "auto"])).toEqual(["1K", "2K"]);
    expect(selectableImageResolutionOptions(["1K", "2K"])).not.toContain("4K");
  });

  it("links a manual edge to the selected ratio and clamps it to the selected tier", () => {
    expect(imageDimensionsForManualInput(1600, "width", "2K", "16:9")).toEqual({
      width: 1536,
      height: 864,
    });
    expect(imageDimensionsForManualInput(9999, "height", "2K", "16:9")).toEqual({
      width: 2560,
      height: 1440,
    });
  });
});
