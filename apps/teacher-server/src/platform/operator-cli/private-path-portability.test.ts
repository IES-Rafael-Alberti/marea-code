import * as paths from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isInside } from "./private-path.js";

vi.mock("node:path", async (load) => {
  const original = await load<typeof import("node:path")>();
  return {
    ...original,
    relative: vi.fn(original.relative),
    isAbsolute: vi.fn(original.isAbsolute),
  };
});
afterEach(() => {
  vi.mocked(paths.relative).mockReset();
  vi.mocked(paths.isAbsolute).mockReset();
});
it("rejects another Windows drive while accepting actual descendants", () => {
  vi.mocked(paths.relative).mockImplementation(paths.win32.relative);
  vi.mocked(paths.isAbsolute).mockImplementation(paths.win32.isAbsolute);
  expect(isInside("D:\\state", "C:\\state")).toBe(false);
  expect(isInside("C:\\state\\child", "C:\\state")).toBe(true);
  expect(isInside("C:\\state", "C:\\state\\child")).toBe(false);
  expect(isInside("C:\\state", "C:\\state")).toBe(true);
});
it("does not confuse dot-prefixed names with parent traversal", () => {
  const native = process.platform === "win32" ? paths.win32 : paths.posix;
  vi.mocked(paths.relative).mockImplementation(native.relative);
  vi.mocked(paths.isAbsolute).mockImplementation(native.isAbsolute);
  const root = native.resolve("private-root");
  expect(isInside(native.join(root, "..data"), root)).toBe(true);
  expect(isInside(native.join(root, "..", "other"), root)).toBe(false);
  expect(isInside(native.dirname(root), root)).toBe(false);
});
