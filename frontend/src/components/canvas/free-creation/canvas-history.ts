interface CanvasCommandHistoryOptions {
  maxCommands: number;
  maxBytes: number;
}

export interface CanvasHistoryCommand<T> {
  before: T;
  after: T;
}

interface StoredCommand<T> {
  command: CanvasHistoryCommand<T>;
  bytes: number;
}

export class CanvasCommandHistory<T> {
  private undoStack: StoredCommand<T>[] = [];
  private redoStack: StoredCommand<T>[] = [];
  private undoBytes = 0;

  constructor(private readonly options: CanvasCommandHistoryOptions) {}

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.undoBytes = 0;
  }

  push(command: CanvasHistoryCommand<T>): void {
    const stored = { command, bytes: JSON.stringify(command).length };
    this.undoStack.push(stored);
    this.undoBytes += stored.bytes;
    this.redoStack = [];
    while (
      this.undoStack.length > 1
      && (this.undoStack.length > this.options.maxCommands || this.undoBytes > this.options.maxBytes)
    ) {
      this.undoBytes -= this.undoStack.shift()!.bytes;
    }
  }

  undo(): CanvasHistoryCommand<T> | null {
    const stored = this.undoStack.pop();
    if (!stored) return null;
    this.undoBytes -= stored.bytes;
    this.redoStack.push(stored);
    return stored.command;
  }

  redo(): CanvasHistoryCommand<T> | null {
    const stored = this.redoStack.pop();
    if (!stored) return null;
    this.undoStack.push(stored);
    this.undoBytes += stored.bytes;
    return stored.command;
  }
}
