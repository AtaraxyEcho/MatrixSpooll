import { describe, expect, it } from "vitest";
import { CanvasCommandHistory } from "@/components/canvas/free-creation/canvas-history";

describe("CanvasCommandHistory", () => {
  it("keeps 50 content commands and clears redo after a new command", () => {
    const history = new CanvasCommandHistory<number>({ maxCommands: 50, maxBytes: 16 * 1024 * 1024 });
    for (let index = 0; index < 60; index += 1) {
      history.push({ before: index, after: index + 1 });
    }

    expect(history.undoDepth).toBe(50);
    expect(history.undo()?.before).toBe(59);
    expect(history.redoDepth).toBe(1);
    history.push({ before: 60, after: 61 });
    expect(history.redoDepth).toBe(0);
  });

  it("evicts oldest commands when the serialized byte budget is exceeded", () => {
    const history = new CanvasCommandHistory<string>({ maxCommands: 50, maxBytes: 80 });
    history.push({ before: "a".repeat(30), after: "b".repeat(30) });
    history.push({ before: "c".repeat(30), after: "d".repeat(30) });

    expect(history.undoDepth).toBe(1);
    expect(history.undo()).toEqual({ before: "c".repeat(30), after: "d".repeat(30) });
  });
});
