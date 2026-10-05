import { constants } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { useTemporaryDirectories } from "./adapter.fixture.js";
import {
  DurableFileSaver,
  flushCheckpointReplacement,
  type CheckpointFileOperations,
} from "./durable-checkpoint.boundary.js";

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

describe("checkpoint replacement synchronization", () => {
  it.each(["win32", "linux", "darwin"] as const)(
    "flushes the supported handle on %s and closes it even when flushing fails",
    (platform) => {
      const failure = new Error("disk flush failed");
      const operations: CheckpointFileOperations = {
        open: vi.fn(() => 73),
        flush: vi.fn(),
        close: vi.fn(),
        remove: vi.fn(),
        replace: vi.fn(),
        write: vi.fn(),
      };
      const root = temporaryRoot();
      const statePath = join(root, "checkpoint.bin");
      flushCheckpointReplacement(statePath, operations, platform);
      expect(operations.open).toHaveBeenCalledExactlyOnceWith(
        platform === "win32" ? statePath : root,
        platform === "win32" ? constants.O_RDWR : constants.O_RDONLY,
      );
      expect(operations.flush).toHaveBeenCalledExactlyOnceWith(73);
      expect(operations.close).toHaveBeenCalledExactlyOnceWith(73);
      vi.mocked(operations.flush).mockImplementation(() => {
        throw failure;
      });
      expect(() => {
        flushCheckpointReplacement(statePath, operations, platform);
      }).toThrow(failure);
      expect(operations.close).toHaveBeenCalledTimes(2);
      expect(operations.close).toHaveBeenLastCalledWith(73);
    },
  );
});
