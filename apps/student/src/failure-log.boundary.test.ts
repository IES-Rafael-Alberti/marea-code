import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFailureLog, FAILURE_LOG_FILE } from "./failure-log.boundary.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function location(): string {
  const root = mkdtempSync(join(tmpdir(), "marea-failure-log-"));
  roots.push(root);
  return join(root, FAILURE_LOG_FILE);
}

const write = (path: string, value: string) => {
  writeFileSync(path, value, { mode: 0o600 });
  return Promise.resolve();
};

const lines = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly n: number });

describe("local failure log", () => {
  it("appends one JSON line per failed attempt, starting a missing file", async () => {
    const path = location();
    const log = createFailureLog(path, write);
    expect(log.path).toBe(path);
    await log.append({ n: 1 });
    await log.append({ n: 2 });
    expect(lines(path)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(FAILURE_LOG_FILE).toBe("turn-failures.jsonl");
  });

  it("drops the oldest records to stay within its size, keeping a single oversized one", async () => {
    const path = location();
    // Each record takes eight bytes with its newline, so three fit in twenty-four.
    const log = createFailureLog(path, write, 24);
    for (const n of [1, 2, 3, 4]) await log.append({ n });
    expect(lines(path)).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }]);
    const huge = createFailureLog(path, write, 4);
    await huge.append({ n: 5 });
    expect(lines(path)).toEqual([{ n: 5 }]);
  });

  it("propagates read failures other than a missing file", async () => {
    const directory = location();
    const notAFile = join(directory, "..");
    await expect(createFailureLog(notAFile, write).append({ n: 1 })).rejects.toThrow();
  });
});
