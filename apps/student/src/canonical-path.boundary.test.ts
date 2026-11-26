import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalPath, canonicalPathOrSelf, comparablePath } from "./canonical-path.boundary.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("compares paths case-insensitively only on Windows", () => {
  expect(comparablePath("C:\\Proj")).toBe("C:\\Proj");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  expect(comparablePath("C:\\Proj")).toBe("c:\\proj");
});

it("resolves links to the real folder and keeps unresolvable spellings", async () => {
  const base = await mkdtemp(join(tmpdir(), "marea-canonical-"));
  try {
    await mkdir(join(base, "real"));
    await symlink(join(base, "real"), join(base, "link"), "junction");
    const real = await canonicalPath(join(base, "real"));
    expect(await canonicalPath(join(base, "link"))).toBe(real);
    expect(canonicalPathOrSelf(join(base, "link"))).toBe(real);
    expect(canonicalPathOrSelf(join(base, "missing"))).toBe(join(base, "missing"));
    await expect(canonicalPath(join(base, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
