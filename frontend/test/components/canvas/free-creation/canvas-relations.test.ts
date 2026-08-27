import { describe, expect, it } from "vitest";
import { createCanvasRelationGraph } from "@/components/canvas/free-creation/canvas-relations";
import type { FreeCreation } from "@/types";

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
});
