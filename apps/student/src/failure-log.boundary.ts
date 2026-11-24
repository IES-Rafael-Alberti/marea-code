import { readFile } from "node:fs/promises";

/** A private, size-bounded JSON-lines record of failed turn attempts on this computer. */
export interface FailureLog {
  readonly path: string;
  append(record: Readonly<Record<string, unknown>>): Promise<void>;
}

const DEFAULT_MAX_BYTES = 262_144;
/** Beside session.json in the student's state directory. */
export const FAILURE_LOG_FILE = "turn-failures.jsonl";

async function existingLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Keeps the newest records within `maxBytes`, dropping the oldest first. It covers failures that
 * never reach the teacher, offline or with an older server; a single oversized record is kept.
 */
export function createFailureLog(
  path: string,
  write: (path: string, value: string) => Promise<void>,
  maxBytes = DEFAULT_MAX_BYTES,
): FailureLog {
  return Object.freeze({
    path,
    async append(record: Readonly<Record<string, unknown>>): Promise<void> {
      const lines = [...(await existingLines(path)), JSON.stringify(record)];
      const sizes = lines.map((line) => Buffer.byteLength(line) + 1);
      let size = sizes.reduce((total, bytes) => total + bytes, 0);
      let first = 0;
      for (const bytes of sizes) {
        if (first === lines.length - 1 || size <= maxBytes) break;
        size -= bytes;
        first += 1;
      }
      await write(path, `${lines.slice(first).join("\n")}\n`);
    },
  });
}
