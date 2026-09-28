import { vi } from "vitest";

/** Retention tests run on node:sqlite; constructing the Bun driver is a test defect. */
export const Database = vi.fn(() => {
  throw new Error("bun:sqlite is not used by Node SQLite retention tests");
});
