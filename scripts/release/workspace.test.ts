import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sha256 } from "./manifest.js";
import { withBuildWorkspace } from "./workspace.boundary.js";
const sources: string[] = [];
function source() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-source-")));
  sources.push(root);
  mkdirSync(join(root, "nested/deep"), { recursive: true });
  writeFileSync(join(root, "nested/deep/file"), "source bytes");
  writeFileSync(join(root, "stale-package"), "not in snapshot");
  return root;
}
afterEach(() => {
  for (const root of sources.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("copies only hashed source records into a fresh workspace and cleans it after returning the result", () => {
  const root = source();
  let observed = "";
  const result = withBuildWorkspace(
    root,
    [
      { path: "nested/deep/file", sha256: sha256(Buffer.from("source bytes")) },
      { path: "deleted", sha256: null },
    ],
    (workspace) => {
      observed = workspace;
      expect(isAbsolute(workspace)).toBe(true);
      expect(basename(workspace)).toMatch(/^marea-build-/u);
      expect(workspace).not.toBe(root);
      expect(readFileSync(join(workspace, "nested/deep/file"), "utf8")).toBe("source bytes");
      expect(existsSync(join(workspace, "stale-package"))).toBe(false);
      expect(existsSync(join(workspace, "deleted"))).toBe(false);
      return "built-and-scanned";
    },
  );
  expect(result).toBe("built-and-scanned");
  expect(existsSync(observed)).toBe(false);
});
it("rejects changed source bytes and escaping paths before running any build", () => {
  const root = source();
  for (const path of ["../outside", "..", join(root, "nested/deep/file")])
    expect(() =>
      withBuildWorkspace(root, [{ path, sha256: null }], () => {
        throw new Error("must not run");
      }),
    ).toThrow("escapes");
  expect(() =>
    withBuildWorkspace(root, [{ path: "nested/deep/file", sha256: "0".repeat(64) }], () => {
      throw new Error("must not run");
    }),
  ).toThrow("Source changed");
});
it("cleans the isolated workspace when dependency installation or compilation fails", () => {
  let observed = "";
  expect(() =>
    withBuildWorkspace(source(), [], (workspace) => {
      observed = workspace;
      throw new Error("build failed");
    }),
  ).toThrow("build failed");
  expect(existsSync(observed)).toBe(false);
});

it("allows a completed build to remove its temporary tree before final cleanup", () => {
  expect(
    withBuildWorkspace(source(), [], (workspace) => {
      rmSync(workspace, { recursive: true });
      return "already cleaned";
    }),
  ).toBe("already cleaned");
});
