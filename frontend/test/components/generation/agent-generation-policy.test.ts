import { describe, expect, it } from "vitest";
import { buildAgentGenerationPolicy } from "@/components/generation/agentGenerationPolicy";
import {
  FREE_CREATION_COMPOSER_PREFERENCES_KEY,
  defaultFreeCreationComposerPreferences,
  readFreeCreationComposerPreferences,
} from "@/components/generation/freeCreationComposerPreference";

describe("buildAgentGenerationPolicy", () => {
  it("keeps automatic mode free of stale manual overrides", () => {
    const references = [{
      type: "upload" as const,
      reference_id: "r_0123456789abcdef0123",
      role: "reference_image" as const,
    }];

    expect(buildAgentGenerationPolicy({
      controlMode: "auto",
      preference: "video",
      aspectRatio: "21:9",
      model: "provider/video-model",
      resolution: "1080p",
      references,
    })).toEqual({
      schema_version: 1,
      mode: "auto",
      references,
    });
  });

  it("sends only explicit custom constraints", () => {
    expect(buildAgentGenerationPolicy({
      controlMode: "custom",
      preference: "image",
      aspectRatio: "smart",
      model: "auto",
      resolution: "2K",
    })).toEqual({
      schema_version: 1,
      mode: "custom",
      output_type: "image",
      resolution: "2K",
    });
  });
});

describe("free creation Agent preference migration", () => {
  it("defaults new projects to automatic generation control", () => {
    expect(defaultFreeCreationComposerPreferences().agentControlMode).toBe("auto");
  });

  it("migrates legacy preference records to custom control", () => {
    const projectName = "legacy agent project";
    window.localStorage.setItem(
      `${FREE_CREATION_COMPOSER_PREFERENCES_KEY}:${encodeURIComponent(projectName)}`,
      JSON.stringify({ agentPreference: "image", agentAspectRatio: "1:1" }),
    );

    expect(readFreeCreationComposerPreferences(projectName)).toEqual(expect.objectContaining({
      version: 2,
      agentControlMode: "custom",
      agentPreference: "image",
      agentAspectRatio: "1:1",
    }));
  });
});
