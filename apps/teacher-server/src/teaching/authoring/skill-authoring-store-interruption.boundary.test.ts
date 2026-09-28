import { access, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SkillAuthoringStore } from "./skill-authoring-store.boundary.js";
import type { SkillBundle } from "../skills/skill-source.js";
import { newRoot, owner, saveRequest, skill } from "./authoring-test-support.fixture.js";

describe("SkillAuthoringStore interrupted transactions", () => {
  async function journalSample(
    store: SkillAuthoringStore,
    root: string,
  ): Promise<{ transaction: string; original: SkillBundle }> {
    const original = await store.create(
      saveRequest("didactic", "sample", skill("sample", "Original")),
    );
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(transaction, { recursive: true });
    await rename(join(root, "didactic", "sample"), join(transaction, "journal"));
    return { transaction, original };
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
    } catch {
      return false;
    }
    return true;
  }

  it("rejects interrupted create after restoring the journaled skill under the same gate", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const { original, transaction } = await journalSample(store, root);
    await expect(
      store.create(saveRequest("didactic", "sample", skill("sample", "Replacement"))),
    ).rejects.toMatchObject({
      code: "SKILL_EXISTS",
      location: "didactic/sample",
      message: "Another committed skill already uses slug 'sample'.",
    });
    const restored = await store.read("teacher/owner-1/sample");
    expect(restored?.description).toBe("Original");
    expect(restored?.digest).toBe(original.digest);
    await expect(readFile(join(root, "didactic", "sample", "SKILL.md"), "utf8")).resolves.toContain(
      "Original",
    );
    await expect(exists(transaction)).resolves.toBe(false);
  });

  it("recovers interrupted replace before digest checks and preserves the prior bundle", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const original = await store.create(
      saveRequest("didactic", "sample", skill("sample", "Original")),
    );
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(transaction, { recursive: true });
    await rename(join(root, "didactic", "sample"), join(transaction, "journal"));
    await expect(
      store.replace(saveRequest("didactic", "sample", skill("sample", "Lost"), null)),
    ).rejects.toMatchObject({
      code: "STALE_SKILL_DIGEST",
      location: "didactic/sample",
      message: "Refresh the saved skill digest before writing.",
    });
    expect((await store.read("teacher/owner-1/sample"))?.digest).toBe(original.digest);
    const updated = await store.replace(
      saveRequest("didactic", "sample", skill("sample", "Updated"), original.digest),
    );
    expect(updated.description).toBe("Updated");
    await expect(exists(transaction)).resolves.toBe(false);
  });

  it("discards stale pending stages instead of importing their resources", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    const stage = join(transaction, "didactic", "sample");
    await mkdir(join(stage, "resources"), { recursive: true });
    await writeFile(join(stage, "SKILL.md"), "---\nname: sample\ndescription: Stale\n---\n");
    await writeFile(join(stage, "resources", "stale.txt"), "stale bytes");
    const created = await store.create(saveRequest("didactic", "sample", skill("sample", "Fresh")));
    expect(created.description).toBe("Fresh");
    expect(created.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    await expect(exists(transaction)).resolves.toBe(false);
    expect((await store.read("teacher/owner-1/sample"))?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
    ]);
  });
});
