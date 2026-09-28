import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { SkillAuthoringStore } from "./skill-authoring-store.boundary.js";
import { owner, roots } from "./authoring-test-support.fixture.js";

const fault = { path: "", denied: false };
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (args[0] === fault.path) {
        if (fault.denied)
          throw Object.assign(new Error("private OS diagnostic"), { code: "EACCES" });
        return { isDirectory: () => false };
      }
      return actual.statSync(...args);
    },
  };
});

describe("authoring missing-root parent inspection", () => {
  it("rejects a parent that becomes unavailable or non-directory without creating state", () => {
    const root = mkdtempSync(join(tmpdir(), "marea-root-inspection-"));
    roots.push(root);
    writeFileSync(join(root, "sentinel.txt"), "preserve");
    fault.path = root;
    for (const denied of [false, true]) {
      fault.denied = denied;
      expect(() => new SkillAuthoringStore(join(root, "missing"), owner)).toThrow(
        expect.objectContaining({
          code: "ROOT_NOT_EXCLUSIVE",
          location: root,
          message: "The exclusive filesystem could not inspect the skill state.",
        }),
      );
      expect(existsSync(join(root, "missing"))).toBe(false);
      expect(readFileSync(join(root, "sentinel.txt"), "utf8")).toBe("preserve");
    }
    fault.path = "";
    const store = new SkillAuthoringStore(join(root, "safe"), owner);
    expect(store).toBeInstanceOf(SkillAuthoringStore);
  });
});
