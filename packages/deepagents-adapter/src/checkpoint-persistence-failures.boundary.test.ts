import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { useTemporaryDirectories } from "./adapter.fixture.js";
import { DurableFileSaver, type CheckpointFileOperations } from "./durable-checkpoint.boundary.js";

const temporaryRoot = useTemporaryDirectories("marea-checkpoint-cleanup-");

describe("checkpoint persistence failure cleanup", () => {
  it.each(["open", "write", "replace"] as const)(
    "closes only an acquired, still-open descriptor after %s fails",
    async (stage) => {
      const failure = new Error(`Failed ${stage}`);
      const close = vi.fn();
      const operations: CheckpointFileOperations = {
        close,
        flush: vi.fn(),
        open: () => {
          if (stage === "open") throw failure;
          return 41;
        },
        remove: vi.fn(),
        replace: () => {
          if (stage === "replace") throw failure;
        },
        write: () => {
          if (stage === "write") throw failure;
        },
      };
      const saver = new DurableFileSaver(join(temporaryRoot(), "checkpoint.bin"), operations);

      await expect(
        saver.recordTurn("session", "message", { state: "completed", events: [] }),
      ).rejects.toBe(failure);

      if (stage === "open") expect(close).not.toHaveBeenCalled();
      else {
        expect(close).toHaveBeenCalledExactlyOnceWith(41);
      }
      expect(operations.remove).toHaveBeenCalledOnce();
    },
  );

  it("preserves the write failure even if both cleanup operations fail", async () => {
    const failure = new Error("original checkpoint write failure");
    const close = vi.fn(() => {
      throw new Error("cleanup close failed");
    });
    const remove = vi.fn(() => {
      throw new Error("cleanup unlink failed");
    });
    const saver = new DurableFileSaver(join(temporaryRoot(), "checkpoint.bin"), {
      close,
      flush: vi.fn(),
      open: () => 41,
      remove,
      replace: vi.fn(),
      write: () => {
        throw failure;
      },
    });

    await expect(
      saver.recordTurn("session", "message", { state: "in-progress", events: [] }),
    ).rejects.toBe(failure);

    expect(close).toHaveBeenCalledExactlyOnceWith(41);
    expect(remove).toHaveBeenCalledOnce();
  });
});
