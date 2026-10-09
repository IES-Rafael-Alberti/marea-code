import * as fs from "node:fs";
vi.mock("node:fs", { spy: true });
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sha256 } from "./manifest.js";
import { verifiedCachedFile } from "./preview-cache.boundary.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("treats missing, changed, linked, nonregular and oversized cached files as misses", () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "marea-cache-")));
  roots.push(root);
  const path = join(root, "program");
  const bytes = Buffer.from("verified program");
  const file = { path: "program", executable: true, sha256: sha256(bytes) };
  const realpaths = vi.spyOn(fs, "realpathSync").mockClear();
  expect(verifiedCachedFile(undefined, file)).toBeUndefined();
  expect(realpaths).not.toHaveBeenCalled();
  expect(verifiedCachedFile(root, file)).toBeUndefined();
  fs.mkdirSync(path);
  expect(verifiedCachedFile(root, file)).toBeUndefined();
  fs.rmdirSync(path);
  fs.writeFileSync(path, bytes);
  expect(verifiedCachedFile(root, file)).toEqual(bytes);
  expect(verifiedCachedFile(root, { ...file, sha256: "0".repeat(64) })).toBeUndefined();
  fs.linkSync(path, join(root, "hardlink"));
  expect(verifiedCachedFile(root, file)).toBeUndefined();
  fs.unlinkSync(join(root, "hardlink"));
  fs.symlinkSync(path, join(root, "link"));
  expect(verifiedCachedFile(root, { ...file, path: "link" })).toBeUndefined();
  fs.symlinkSync(root, join(root, "linked-directory"), "dir");
  expect(verifiedCachedFile(join(root, "linked-directory"), file)).toEqual(bytes);
  expect(verifiedCachedFile(root, { ...file, path: "linked-directory/program" })).toBeUndefined();
  const status = fs.lstatSync(path);
  const stat = vi.spyOn(fs, "lstatSync");
  stat.mockReturnValueOnce(Object.assign(status, { size: 512_000_000 }));
  expect(verifiedCachedFile(root, file)).toEqual(bytes);
  stat.mockReturnValueOnce(Object.assign(status, { size: 512_000_001 }));
  expect(verifiedCachedFile(root, file)).toBeUndefined();
  const reads = vi.spyOn(fs, "readFileSync").mockClear();
  expect(verifiedCachedFile(root, file)).toEqual(bytes);
  expect(reads).toHaveBeenCalledWith(path);
});
