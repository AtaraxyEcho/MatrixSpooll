import { describe, expect, it } from "vitest";
import { createCanvasRelationGraph } from "@/components/canvas/free-creation/canvas-relations";
import type { FreeCreation, FreeSubtitleTrack } from "@/types";

const parent: FreeCreation = {
  creation_id: "c_parent",
  output_type: "image",
  media_type: "image",
  status: "succeeded",
};

const child: FreeCreation = {
  creation_id: "c_child",
  output_type: "video",
  media_type: "video",
  status: "succeeded",
  parent_creation_id: parent.creation_id,
  reference_claims: [
    { type: "creation", creation_id: parent.creation_id, version: 2, role: "first_frame" },
    { type: "creation", creation_id: parent.creation_id, version: 2, role: "reference_image" },
    { type: "upload", reference_id: "r_script", role: "prompt_context" },
  ],
};

const descendant: FreeCreation = {
  creation_id: "c_descendant",
  output_type: "video",
  media_type: "video",
  status: "succeeded",
  reference_claims: [
    { type: "creation", creation_id: child.creation_id, version: 1, role: "reference_video" },
  ],
};

describe("canvas relation graph", () => {
  it("deduplicates geometry while preserving every source role", () => {
    const graph = createCanvasRelationGraph([parent, child]);

    expect(graph.relations).toEqual([
      {
        id: "c_parent->c_child",
        sourceId: "c_parent",
        sourceType: "creation",
        targetId: "c_child",
        roles: ["first_frame", "reference_image"],
      },
      {
        id: "r_script->c_child",
        sourceId: "r_script",
        sourceType: "upload",
        targetId: "c_child",
        roles: ["prompt_context"],
      },
    ]);
  });

  it("uses the parent as a fallback relation when no matching claim exists", () => {
    const graph = createCanvasRelationGraph([parent, {
      ...child,
      reference_claims: [{ type: "upload", reference_id: "r_script", role: "prompt_context" }],
    }]);

    expect(graph.upstream(child.creation_id).map((relation) => relation.roles)).toEqual([
      ["edit_source"],
      ["prompt_context"],
    ]);
  });

  it("shows incident relations for one selection and only internal relations for a multi-selection", () => {
    const graph = createCanvasRelationGraph([parent, child, descendant]);
    const visibleIds = new Set([parent.creation_id, child.creation_id, descendant.creation_id, "r_script"]);

    expect(graph.query({
      mode: "selected",
      selectedIds: new Set([child.creation_id]),
      visibleIds,
    }).relations.map((relation) => relation.id)).toEqual([
      "c_child->c_descendant",
      "c_parent->c_child",
      "r_script->c_child",
    ]);

    expect(graph.query({
      mode: "selected",
      selectedIds: new Set([parent.creation_id, child.creation_id]),
      visibleIds,
    }).relations.map((relation) => relation.id)).toEqual(["c_parent->c_child"]);
  });

  it("never returns dangling relations and enforces the all-mode render budget", () => {
    const graph = createCanvasRelationGraph([parent, child, descendant]);
    const result = graph.query({
      mode: "all",
      selectedIds: new Set(),
      visibleIds: new Set([parent.creation_id, child.creation_id, descendant.creation_id]),
      maxRelations: 1,
    });

    expect(result.relations).toHaveLength(1);
    expect(result.total).toBe(2);
    expect(result.omitted).toBe(1);
    expect(graph.query({
      mode: "off",
      selectedIds: new Set([child.creation_id]),
      visibleIds: new Set([parent.creation_id, child.creation_id]),
    }).relations).toEqual([]);
  });

  it("connects an unrendered subtitle track to its source video", () => {
    const sourceVideo: FreeCreation = {
      ...child,
      parent_creation_id: null,
      reference_claims: [],
    };
    const track: FreeSubtitleTrack = {
      subtitle_id: "sub_track",
      creation_id: sourceVideo.creation_id,
      revision: 2,
      cues: [{ start_seconds: 0, end_seconds: 4, text: "The train arrives." }],
      created_at: "2026-08-28T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
    };

    const graph = createCanvasRelationGraph([sourceVideo], [track]);

    expect(graph.relations).toEqual([{
      id: "c_child->sub_track",
      sourceId: "c_child",
      sourceType: "creation",
      targetId: "sub_track",
      roles: ["subtitle_source"],
    }]);
  });

  it("connects both the source video and subtitle track to a rendered video", () => {
    const sourceVideo: FreeCreation = {
      ...child,
      parent_creation_id: null,
      reference_claims: [],
    };
    const track: FreeSubtitleTrack = {
      subtitle_id: "sub_track",
      creation_id: sourceVideo.creation_id,
      revision: 2,
      cues: [{ start_seconds: 0, end_seconds: 4, text: "The train arrives." }],
      created_at: "2026-08-28T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
    };
    const rendered: FreeCreation = {
      ...child,
      creation_id: "c_subtitled",
      effective_mode: "subtitle_burn",
      subtitle_id: track.subtitle_id,
      parent_creation_id: sourceVideo.creation_id,
      reference_claims: [
        { type: "creation", creation_id: sourceVideo.creation_id, role: "reference_video" },
      ],
    };

    const graph = createCanvasRelationGraph([sourceVideo, rendered], [track]);

    expect(graph.relations).toEqual([
      {
        id: "c_child->c_subtitled",
        sourceId: "c_child",
        sourceType: "creation",
        targetId: "c_subtitled",
        roles: ["reference_video"],
      },
      {
        id: "sub_track->c_subtitled",
        sourceId: "sub_track",
        sourceType: "subtitle",
        targetId: "c_subtitled",
        roles: ["subtitle_render"],
      },
    ]);
  });

  it("keeps both source relations for an audio-composited video", () => {
    const audio: FreeCreation = {
      creation_id: "c_audio",
      output_type: "audio",
      media_type: "audio",
      status: "succeeded",
    };
    const composited: FreeCreation = {
      ...child,
      creation_id: "c_composited",
      effective_mode: "audio_composite",
      parent_creation_id: child.creation_id,
      reference_claims: [
        { type: "creation", creation_id: child.creation_id, role: "reference_video" },
        { type: "creation", creation_id: audio.creation_id, role: "reference_audio" },
      ],
    };

    const graph = createCanvasRelationGraph([child, audio, composited]);

    expect(graph.upstream(composited.creation_id).map((relation) => relation.sourceId)).toEqual([
      audio.creation_id,
      child.creation_id,
    ]);
  });
});
