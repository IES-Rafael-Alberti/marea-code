import { describe, expect, it } from "vitest";

import { SkillAuthoringStore } from "./skill-authoring-store.boundary.js";
import { newRoot, owner, saveRequest } from "./authoring-test-support.fixture.js";

describe("SkillAuthoringStore input boundaries", () => {
  it("accepts every exact input boundary and rejects one byte or one file beyond it", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const fileLimit = 512 * 1_024;
    const filePrefix = "---\nname: file-boundary\ndescription: Boundary\n---\n";
    await store.create(
      saveRequest("didactic", "file-boundary", [
        { path: "SKILL.md", content: filePrefix + "a".repeat(fileLimit - filePrefix.length) },
      ]),
    );
    await expect(
      store.create(
        saveRequest("didactic", "file-over", [
          { path: "SKILL.md", content: filePrefix + "a".repeat(fileLimit - filePrefix.length + 1) },
        ]),
      ),
    ).rejects.toMatchObject({
      code: "AUTHORING_LIMIT",
      location: "didactic/file-over/SKILL.md",
      message: "Reduce the file below 524288 bytes.",
    });
    const exactCount = Array.from({ length: 256 }, (_, index) => ({
      path: index === 0 ? "SKILL.md" : `resources/file-${String(index)}.txt`,
      content: index === 0 ? "---\nname: count-boundary\ndescription: Count\n---\n" : "a",
    }));
    await store.create(saveRequest("didactic", "count-boundary", exactCount));
    const exactBundle = [
      { path: "SKILL.md", content: "---\nname: bundle-boundary\ndescription: Bundle\n---\n" },
      ...Array.from({ length: 15 }, (_, index) => ({
        path: `resources/large-${String(index)}.txt`,
        content: "a".repeat(512 * 1_024),
      })),
      { path: "resources/large-final.txt", content: "a".repeat(512 * 1_024 - 50) },
    ];
    const bundleBoundary = await store.create(
      saveRequest("didactic", "bundle-boundary", exactBundle),
    );
    await expect(
      store.replace(
        saveRequest(
          "didactic",
          "bundle-boundary",
          [...exactBundle, { path: "resources/over.txt", content: "a".repeat(1000) }],
          bundleBoundary.digest,
        ),
      ),
    ).rejects.toMatchObject({
      code: "AUTHORING_LIMIT",
      location: "didactic/bundle-boundary",
      message: "Reduce the complete bundle below 8388608 bytes.",
    });
    await expect(
      store.create(
        saveRequest("didactic", "bundle-over", [
          ...exactBundle,
          { path: "resources/over.txt", content: "a" },
        ]),
      ),
    ).rejects.toMatchObject({
      code: "AUTHORING_LIMIT",
      location: "didactic/bundle-over",
      message: "Reduce the complete bundle below 8388608 bytes.",
    });
  });
});
