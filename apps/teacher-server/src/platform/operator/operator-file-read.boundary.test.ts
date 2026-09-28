import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

import { readOperatorFile } from "./operator-file-read.boundary.js";
import { assertPostReadBounds, loadOperatorConfiguration } from "./operator-filesystem-loader.js";

const roots: string[] = [];

function file(content: string): string {
  const root = fs.mkdtempSync(join(tmpdir(), "marea-operator-review-"));
  roots.push(root);
  const path = join(root, "configuration.json");
  fs.writeFileSync(path, content);
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

it("reads empty and multi-chunk files without allocating the configured maximum", () => {
  expect(readOperatorFile(file(""), 1)).toEqual(Buffer.alloc(0));
  const bytes = `${" ".repeat(70_000)}{"version":1,"classes":[]}`;
  const path = file(bytes);
  const read = vi.spyOn(fs, "readSync");
  expect(loadOperatorConfiguration(path, Number.MAX_SAFE_INTEGER).forClass("unknown")).toBeNull();
  expect(read.mock.calls.map((call) => call[1].byteLength)).toEqual([
    65_536,
    bytes.length + 1 - 65_536,
    1,
  ]);
});

it("rejects an oversized opened file and closes its descriptor", () => {
  const path = file("{}");
  const close = vi.spyOn(fs, "closeSync");
  expect(() => readOperatorFile(path, 1)).toThrow(
    expect.objectContaining({
      code: "too-large",
      message: "Operator configuration exceeds its byte bound.",
    }),
  );
  expect(close).toHaveBeenCalledTimes(1);
});

it("rejects a directory and refuses a symbolic link at open", () => {
  const path = file("{}");
  expect(() => readOperatorFile(dirname(path), 100)).toThrow(
    expect.objectContaining({
      code: "not-regular-file",
      message: "Operator configuration path must be a regular file.",
    }),
  );
  const link = join(dirname(path), "link.json");
  fs.symlinkSync(path, link);
  expect(() => readOperatorFile(link, 100)).toThrow();
});

it("stops after the growth-detection byte and rejects the inconsistent result", () => {
  const path = file("{}");
  const nativeRead = fs.readSync;
  const read = vi
    .spyOn(fs, "readSync")
    .mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      fs.appendFileSync(path, " ".repeat(100_000));
      return nativeRead(...args);
    });
  expect(() => loadOperatorConfiguration(path, 10)).toThrow(
    expect.objectContaining({ code: "changed-file" }),
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[1].byteLength).toBe(3);
});

it("keeps read errors sanitized and closes the owned descriptor", () => {
  const path = file("{}");
  const close = vi.spyOn(fs, "closeSync");
  vi.spyOn(fs, "readSync").mockImplementation(() => {
    throw new Error(`private:${path}`);
  });
  expect(() => loadOperatorConfiguration(path, 10)).toThrow(
    "Operator configuration file could not be read.",
  );
  expect(close).toHaveBeenCalledTimes(1);
});

it("propagates safe descriptor-bound errors through the loader", () => {
  const path = file("{}");
  const nativeOpen = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    fs.appendFileSync(path, "padding");
    return nativeOpen(...args);
  });
  expect(() => loadOperatorConfiguration(path, 2)).toThrow(
    expect.objectContaining({ code: "too-large" }),
  );
});

it("rejects same-size replacements, edits and short reads", () => {
  const before = { size: 2, ino: 1, dev: 1, mtimeMs: 1, ctimeMs: 1 };
  for (const field of ["ino", "dev", "mtimeMs", "ctimeMs"] as const) {
    expect(() => {
      assertPostReadBounds(
        before as fs.Stats,
        { ...before, [field]: 2 } as fs.Stats,
        Buffer.from("{}"),
        10,
      );
    }).toThrow(expect.objectContaining({ code: "changed-file" }));
  }
  expect(() => {
    assertPostReadBounds(before as fs.Stats, before as fs.Stats, Buffer.from("{"), 10);
  }).toThrow(expect.objectContaining({ code: "changed-file" }));
});
