import { describe, expect, it } from "vitest";
import {
  applyCanvasPatch,
  buildCanvasPatch,
  rebaseCanvasState,
  type CanvasSharedState,
} from "@/components/canvas/free-creation/canvas-sync";

function sharedState(): CanvasSharedState {
  return {
    positions: { c_one: { x: 10, y: 20 }, c_two: { x: 30, y: 40 } },
    hiddenCreationIds: [],
    hiddenReferenceIds: [],
    groups: [],
    showRelations: true,
  };
}

describe("canvas synchronization", () => {
  it("creates a patch containing only changed targets", () => {
    const before = sharedState();
    const after = {
      ...before,
      positions: { ...before.positions, c_two: { x: 90, y: 80 } },
      hiddenCreationIds: ["c_one"],
    };

    expect(buildCanvasPatch(before, after, {
      patchId: "00000000-0000-4000-8000-000000000001",
      baseRevision: 7,
      nodeRevisions: { c_one: 2, c_two: 5 },
    })).toEqual({
      patch_id: "00000000-0000-4000-8000-000000000001",
      base_revision: 7,
      target_revisions: { c_one: 2, c_two: 5 },
      position_updates: { c_two: { x: 90, y: 80 } },
      hidden_creation_updates: { c_one: true },
    });
  });

  it("returns null when shared state is unchanged", () => {
    const state = sharedState();
    expect(buildCanvasPatch(state, state, {
      patchId: "00000000-0000-4000-8000-000000000001",
      baseRevision: 0,
      nodeRevisions: {},
    })).toBeNull();
  });

  it("applies a remote patch without replacing unrelated local state", () => {
    const current = sharedState();
    current.positions.c_three = { x: 70, y: 60 };
    const result = applyCanvasPatch(current, {
      patch_id: "00000000-0000-4000-8000-000000000002",
      actor_id: "user-two",
      base_revision: 7,
      revision: 8,
      changes: {
        position_updates: { c_two: { x: 100, y: 120 } },
        hidden_creation_updates: { c_one: true },
      },
    });

    expect(result.positions).toEqual({
      c_one: { x: 10, y: 20 },
      c_two: { x: 100, y: 120 },
      c_three: { x: 70, y: 60 },
    });
    expect(result.hiddenCreationIds).toEqual(["c_one"]);
  });

  it("keeps disjoint local changes and yields conflicting targets to the server", () => {
    const remote = sharedState();
    remote.positions.c_one = { x: 400, y: 500 };
    const desired = sharedState();
    desired.positions.c_one = { x: 200, y: 300 };
    desired.positions.c_two = { x: 600, y: 700 };
    const patch = buildCanvasPatch(sharedState(), desired, {
      patchId: "00000000-0000-4000-8000-000000000003",
      baseRevision: 7,
      nodeRevisions: { c_one: 2, c_two: 5 },
    })!;

    const result = rebaseCanvasState(remote, desired, patch, { c_one: 8, c_two: 5 });

    expect(result.state.positions.c_one).toEqual({ x: 400, y: 500 });
    expect(result.state.positions.c_two).toEqual({ x: 600, y: 700 });
    expect(result.conflictIds).toEqual(["c_one"]);
  });
});
