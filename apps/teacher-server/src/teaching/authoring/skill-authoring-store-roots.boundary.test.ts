import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SkillAuthoringError } from "./errors.js";
import { SkillAuthoringStore, type SkillOwnerIdentity } from "./skill-authoring-store.boundary.js";
import {
  newRoot,
  owner,
  roots,
  saveRequest,
  skill,
  symlinkedKindRoot,
} from "./authoring-test-support.fixture.js";

describe("SkillAuthoringStore input and root boundaries", () => {
  it("rejects malformed owner identities and a slug length exactly at the boundary", async () => {
    const root = await newRoot();
    for (const identity of [
      { source: "teacher", id: "../unsafe" },
      { source: "center", id: "bad id" },
    ] as const) {
      expect(() => new SkillAuthoringStore(root, identity)).toThrow();
    }
    const store = new SkillAuthoringStore(root, owner);
    const maximum = "a".repeat(64);
    await store.create(saveRequest("didactic", maximum, skill(maximum)));
    expect((await store.list("didactic")).map((summary) => summary.name)).toEqual([maximum]);
  });

  it("rejects unsafe owner input and file-shape violations before filesystem writes", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    type OwnerCandidate = { source?: string | undefined; id?: string | undefined } | number | null;
    const ownerFailure = (input: OwnerCandidate): SkillAuthoringError => {
      try {
        new SkillAuthoringStore(root, input as SkillOwnerIdentity);
      } catch (error) {
        return error as SkillAuthoringError;
      }
      throw new Error("Expected owner validation to fail.");
    };
    expect(ownerFailure(null)).toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "owner-identity",
      message: "Provide an explicit teacher or center owner identity.",
    });
    expect(ownerFailure(42)).toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "owner-identity",
      message: "Provide an explicit teacher or center owner identity.",
    });
    expect(ownerFailure({ source: "\ud800", id: "owner" })).toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "owner-identity",
      message: "Provide well-formed UTF-8 text without orphan surrogates.",
    });
    expect(ownerFailure({ source: undefined, id: "owner" })).toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "owner-identity",
      message: "Provide string owner source and id values.",
    });
    expect(ownerFailure({ source: "teacher", id: undefined })).toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "owner-identity",
      message: "Provide string owner source and id values.",
    });
    expect(ownerFailure({ source: "teacher", id: "\ud800" })).toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "owner-identity",
      message: "Provide well-formed UTF-8 text without orphan surrogates.",
    });
    await expect(new SkillAuthoringStore(root, owner).list("didactic")).resolves.toEqual([]);
    await expect(store.create(saveRequest("didactic", "Bad", skill("Bad")))).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(
      store.create(saveRequest("didactic", "a".repeat(65), skill("testing"))),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      store.create(
        saveRequest(
          "didactic",
          "many",
          Array.from({ length: 257 }, (_, index) => ({
            path: `resources/file-${String(index)}.txt`,
            content: "text",
          })),
        ),
      ),
    ).rejects.toMatchObject({ code: "AUTHORING_LIMIT" });
    await expect(store.create(saveRequest("didactic", "empty", []))).rejects.toMatchObject({
      code: "AUTHORING_LIMIT",
      location: "didactic/empty",
      message: "Provide between 1 and 256 complete skill files.",
    });
    await expect(
      store.create(
        saveRequest("didactic", "shape", [{ path: undefined as never, content: "text" }]),
      ),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "didactic/shape",
      message: "Provide path and text content for every skill file.",
    });
    await expect(
      store.create(
        saveRequest("didactic", "shape", [{ path: "SKILL.md", content: undefined as never }]),
      ),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "didactic/shape",
      message: "Provide path and text content for every skill file.",
    });
  });

  it("initializes a missing root and rejects unsafe roots or kind entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-authoring-"));
    roots.push(root);
    await new SkillAuthoringStore(join(root, "fresh"), owner).initialize();
    await symlink(join(root, "fresh"), join(root, "root-link"));
    await expect(
      new SkillAuthoringStore(join(root, "root-link"), owner).initialize(),
    ).rejects.toMatchObject({
      code: "ROOT_NOT_EXCLUSIVE",
      message: "Use a real exclusive owner skill root directory instead of a symbolic link.",
    });
    const unsafeRoot = await mkdtemp(join(tmpdir(), "marea-authoring-"));
    roots.push(unsafeRoot);
    const outside = await mkdtemp(join(tmpdir(), "marea-outside-"));
    roots.push(outside);
    await symlink(outside, join(outside, "root-link"));
    await expect(
      new SkillAuthoringStore(join(outside, "root-link"), owner).initialize(),
    ).rejects.toMatchObject({
      code: "ROOT_NOT_EXCLUSIVE",
      message: "Use a real exclusive owner skill root directory instead of a symbolic link.",
    });
    await writeFile(join(unsafeRoot, "didactic"), "not-a-directory");
    await expect(new SkillAuthoringStore(unsafeRoot, owner).initialize()).rejects.toMatchObject({
      code: "ROOT_NOT_EXCLUSIVE",
      location: "didactic",
      message: "Use a directory for this skill kind.",
    });
    await chmod(unsafeRoot, 0o000);
    try {
      await expect(new SkillAuthoringStore(unsafeRoot, owner).initialize()).rejects.toMatchObject({
        code: "AUTHORING_RECOVERY_FAILED",
        message: "The exclusive filesystem could not inspect the skill state.",
      });
    } finally {
      await chmod(unsafeRoot, 0o700);
    }
  });

  it("rejects symlinked kind, skill and transaction components and never publishes through them", async () => {
    const { outside, root, store } = await symlinkedKindRoot();
    await expect(
      store.create(saveRequest("evaluation", "testing", skill("testing"))),
    ).rejects.toMatchObject({
      code: "UNSAFE_SYMLINK",
      location: "evaluation",
      message: "Use a real kind directory instead of a symbolic link.",
    });
    const nested = join(root, "didactic", "testing");
    await mkdir(nested, { recursive: true });
    await symlink(outside, join(nested, "resources"));
    await expect(store.list("didactic")).rejects.toMatchObject({ code: "UNSAFE_SYMLINK" });
    const transaction = join(root, ".authoring-transactions", "didactic", "linked");
    await mkdir(transaction, { recursive: true });
    await symlink(outside, join(transaction, "journal"));
    await expect(store.recover()).rejects.toMatchObject({
      code: "UNSAFE_SYMLINK",
      location: "didactic/linked",
      message: "Replace the transaction journal with a real directory.",
    });
  });
});
