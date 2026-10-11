import { expect, it } from "vitest";
import { importSkillFiles } from "./import-files.js";
import { editSkillFields, newSkillDraft, skillEditorFields } from "./draft.boundary.js";

it("adds text resources to an unsaved skill without requiring SKILL.md", async () => {
  const draft = newSkillDraft("didactic");
  const imported = await importSkillFiles(draft, [
    { path: "example.py.txt", file: new Blob(["print(1)"]) },
  ]);
  expect(imported.files).toEqual([
    ...draft.files,
    { path: "resources/example.py.txt", content: "print(1)" },
  ]);
  expect(draft.files).toHaveLength(1);
});
it("merges replacements and new resources while preserving the draft identity", async () => {
  const draft = {
    ...newSkillDraft("didactic"),
    files: [
      { path: "SKILL.md", content: "---\nname: original\ndescription: Original\n---\nOriginal" },
      { path: "resources/keep.txt", content: "keep" },
      { path: "resources/replace.txt", content: "old" },
    ],
  };
  const imported = await importSkillFiles(draft, [
    {
      path: "SKILL.md",
      file: new Blob([
        "---\nname: imported\ndescription: Imported\nmetadata:\n  title: Imported title\n---\nImported body",
      ]),
    },
    { path: "resources/replace.txt", file: new Blob(["new"]) },
  ]);
  expect(imported.slug).toBe(draft.slug);
  expect(imported.files.find((file) => file.path === "SKILL.md")?.content).toContain(
    `name: ${draft.slug}`,
  );
  expect(imported.files.find((file) => file.path === "resources/keep.txt")?.content).toBe("keep");
  expect(imported.files.find((file) => file.path === "resources/replace.txt")?.content).toBe("new");
  expect(skillEditorFields(imported)).toMatchObject({
    title: "Imported title",
    instructions: "Imported body",
  });
});
it("rejects empty, invalid, duplicate, binary and escaping imports without modifying the draft", async () => {
  const draft = editSkillFields(newSkillDraft("didactic"), { title: "Testing" });
  const before = structuredClone(draft);
  await expect(importSkillFiles(draft, [])).rejects.toThrow();
  await expect(
    importSkillFiles({ ...draft, files: [] }, [{ path: "x.txt", file: new Blob(["ok"]) }]),
  ).rejects.toThrow();
  for (const path of ["../outside.txt", "/outside.txt", "x.exe", "resources/.hidden.txt"]) {
    await expect(importSkillFiles(draft, [{ path, file: new Blob(["test"]) }])).rejects.toThrow();
  }
  await expect(
    importSkillFiles(draft, [
      { path: "same.txt", file: new Blob(["a"]) },
      { path: "same.txt", file: new Blob(["b"]) },
    ]),
  ).rejects.toThrow();
  await expect(
    importSkillFiles(draft, [{ path: "bad.txt", file: new Blob([new Uint8Array([255])]) }]),
  ).rejects.toThrow();
  await expect(
    importSkillFiles(draft, [{ path: "SKILL.md", file: new Blob(["invalid"]) }]),
  ).rejects.toThrow();
  expect(draft).toEqual(before);
});

it("locates the main document regardless of file order and reports empty imports precisely", async () => {
  const draft = newSkillDraft("didactic");
  const reordered = {
    ...draft,
    files: [{ path: "resources/before.txt", content: "First resource" }, ...draft.files],
  };
  const imported = await importSkillFiles(reordered, [
    { path: "after.txt", file: new Blob(["After"]) },
  ]);
  expect(imported.files.find((file) => file.path === "SKILL.md")).toEqual(draft.files[0]);
  await expect(importSkillFiles(draft, [])).rejects.toThrow("invalid");
});
