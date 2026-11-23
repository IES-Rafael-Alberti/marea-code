import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isVerifiedPrivateDirectory,
  markVerifiedPrivateDirectory,
} from "./verified-private-directories.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("verified private directories", () => {
  it("remembers a directory by its resolved realpath", () => {
    const root = mkdtempSync(join(tmpdir(), "marea-verified-"));
    roots.push(root);
    expect(isVerifiedPrivateDirectory(root)).toBe(false);
    markVerifiedPrivateDirectory(root);
    expect(isVerifiedPrivateDirectory(root)).toBe(true);
    expect(isVerifiedPrivateDirectory(join(root, "missing"))).toBe(false);
  });

  it("does not remember or report paths that cannot be resolved", () => {
    const absent = join(tmpdir(), "marea-verified-absent");
    expect(isVerifiedPrivateDirectory(absent)).toBe(false);
    markVerifiedPrivateDirectory(absent);
    expect(isVerifiedPrivateDirectory(absent)).toBe(false);
  });
});
