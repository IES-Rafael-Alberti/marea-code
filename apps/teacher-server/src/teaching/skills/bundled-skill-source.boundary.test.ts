import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findRepositorySkillRoot } from "./repository-catalog.fixture.js";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  BundledSkillSource,
  MAX_BUNDLED_SKILL_FILE_BYTES,
} from "./bundled-skill-source.boundary.js";
import { BundledSkillError, type BundledSkillErrorCode } from "./errors.js";
import { bundledSkillId } from "./skill-source.js";

const temporaryRoots: string[] = [];
const thisDirectory = dirname(fileURLToPath(import.meta.url));

const repositorySkillRoot = findRepositorySkillRoot(thisDirectory);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createRoot(): Promise<string> {
  const root = await temporaryDirectory();
  await mkdir(join(root, "didactic"));
  await mkdir(join(root, "evaluation"));
  return root;
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "marea-bundled-skills-"));
  temporaryRoots.push(root);
  return root;
}

function skillMarkdown(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: Guidance for ${name}\n${extra}---\n\n# ${name}\n`;
}

async function writeSkill(
  root: string,
  kind: "didactic" | "evaluation",
  name: string,
  content = skillMarkdown(name),
): Promise<string> {
  const directory = join(root, kind, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content);
  return directory;
}

async function createResources(skillDirectory: string): Promise<string> {
  const resources = join(skillDirectory, "resources");
  await mkdir(resources, { recursive: true });
  return resources;
}

async function expectSourceError(
  promise: Promise<object>,
  code: BundledSkillErrorCode,
  message: string,
  location?: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(BundledSkillError);
  await expect(promise).rejects.toMatchObject(
    location === undefined ? { code } : { code, location },
  );
  await expect(promise).rejects.toThrow(message);
}

describe("BundledSkillSource", () => {
  it("loads the repository's separated Spanish core skills", async () => {
    const source = new BundledSkillSource(repositorySkillRoot);

    const didactic = await source.list("didactic");
    const evaluation = await source.list("evaluation");
    const testing = await source.load(bundledSkillId("testing"));

    expect(didactic.map((skill) => skill.id)).toEqual(["marea/testing"]);
    expect(evaluation.map((skill) => skill.id)).toEqual([
      "marea/free-agent-review",
      "marea/session-review",
    ]);
    expect(testing).toMatchObject({
      kind: "didactic",
      source: "marea",
      license: "MIT",
      compatibility: "Marea Code",
    });
    expect(testing?.criteria.map((criterion) => criterion.code)).toEqual([
      "RA5.c",
      "RA5.d",
      "RA5.e",
    ]);
    expect(evaluation.every((skill) => skill.criteria.length === 0)).toBe(true);
  });

  it("returns immutable summaries and deterministic sorted bundle files", async () => {
    const root = await createRoot();
    const directory = await writeSkill(
      root,
      "didactic",
      "testing",
      skillMarkdown(
        "testing",
        "license: MIT\ncompatibility: Marea\ncriterios:\n  - codigo: RA5.c\n",
      ),
    );
    const resources = await createResources(directory);
    await writeFile(join(resources, "z.txt"), "last\n");
    await writeFile(join(resources, "a.json"), '{"first":true}\n');
    await mkdir(join(resources, "a"));
    await writeFile(join(resources, "a", "nested.md"), "nested\n");
    await writeFile(join(resources, "a.txt"), "before directory\n");
    await writeSkill(root, "evaluation", "review");
    const source = new BundledSkillSource(root);

    const summaries = await source.list("didactic");
    const bundle = await source.load(bundledSkillId("testing"));

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty("files");
    expect(Object.isFrozen(summaries)).toBe(true);
    expect(Object.isFrozen(summaries[0])).toBe(true);
    expect(bundle?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "resources/a.json",
      "resources/a.txt",
      "resources/a/nested.md",
      "resources/z.txt",
    ]);
    expect(bundle?.files.map((file) => file.sizeBytes)).toEqual([130, 15, 17, 7, 5]);
    expect(bundle?.digest).toBe(
      "sha256:3b9ef6154ad564bd32e59011dcbdd7e0616a0a8ccb3bd1698aeb112cb096ac3c",
    );
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle?.files)).toBe(true);
    expect(Object.isFrozen(bundle?.files[0])).toBe(true);
    expect(await source.load(bundledSkillId("missing"))).toBeNull();
  });

  it("changes the digest when a served resource changes", async () => {
    const root = await createRoot();
    const directory = await writeSkill(root, "didactic", "testing");
    const resources = await createResources(directory);
    await writeFile(join(resources, "notes.txt"), "first");
    const before = await new BundledSkillSource(root).load(bundledSkillId("testing"));

    await writeFile(join(resources, "notes.txt"), "second");
    const after = await new BundledSkillSource(root).load(bundledSkillId("testing"));

    expect(before?.digest).not.toBe(after?.digest);
  });

  it("serves every explicitly allowed text resource extension", async () => {
    const root = await createRoot();
    const directory = await writeSkill(root, "didactic", "testing");
    const resources = await createResources(directory);
    for (const name of [
      "resource.csv",
      "resource.json",
      "resource.md",
      "resource.txt",
      "resource.yaml",
      "resource.yml",
    ]) {
      await writeFile(join(resources, name), "text\n");
    }

    const bundle = await new BundledSkillSource(root).load(bundledSkillId("testing"));

    expect(bundle?.files).toHaveLength(7);
  });

  it("allows a file at the exact byte-size limit", async () => {
    const root = await createRoot();
    const directory = await writeSkill(root, "didactic", "testing");
    const resources = await createResources(directory);
    const prefix = skillMarkdown("exact");
    await writeFile(
      join(resources, "exact.txt"),
      prefix + "x".repeat(MAX_BUNDLED_SKILL_FILE_BYTES - Buffer.byteLength(prefix)),
    );

    const bundle = await new BundledSkillSource(root).load(bundledSkillId("testing"));

    expect(bundle?.files.find((file) => file.path === "resources/exact.txt")?.sizeBytes).toBe(
      MAX_BUNDLED_SKILL_FILE_BYTES,
    );
  });

  it("reports an unreadable or missing root as a typed read failure", async () => {
    const root = join(await temporaryDirectory(), "missing");
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "READ_FAILED",
      "exists and is readable",
    );
  });

  it("requires the configured root to be a real directory", async () => {
    const parent = await temporaryDirectory();
    const file = join(parent, "skills.txt");
    await writeFile(file, "not a directory");
    await expectSourceError(
      new BundledSkillSource(file).list("didactic"),
      "ROOT_NOT_DIRECTORY",
      "Configure an existing content/skills directory",
    );
  });

  it("rejects a symbolic-link root", async () => {
    const target = await createRoot();
    const parent = await temporaryDirectory();
    const link = join(parent, "skills");
    await symlink(target, link, "dir");
    await expectSourceError(
      new BundledSkillSource(link).list("didactic"),
      "UNSAFE_SYMLINK",
      "real content/skills directory",
    );
  });

  it("requires both kind entries to be real directories", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "didactic"), "wrong type");
    await mkdir(join(root, "evaluation"));
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "UNSUPPORTED_ENTRY_TYPE",
      "Create a directory",
    );
  });

  it("rejects a symbolic-link kind directory", async () => {
    const root = await temporaryDirectory();
    const target = await temporaryDirectory();
    await symlink(target, join(root, "didactic"), "dir");
    await mkdir(join(root, "evaluation"));
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "UNSAFE_SYMLINK",
      "Replace the kind link",
    );
  });

  it("rejects files and symbolic links where skill directories belong", async () => {
    const fileRoot = await createRoot();
    await writeFile(join(fileRoot, "didactic", "testing"), "wrong type");
    await expectSourceError(
      new BundledSkillSource(fileRoot).list("didactic"),
      "UNSUPPORTED_ENTRY_TYPE",
      "Keep only skill directories",
      "didactic/testing",
    );

    const linkRoot = await createRoot();
    const target = await temporaryDirectory();
    await symlink(target, join(linkRoot, "didactic", "testing"), "dir");
    await expectSourceError(
      new BundledSkillSource(linkRoot).list("didactic"),
      "UNSAFE_SYMLINK",
      "Replace the skill link",
      "didactic/testing",
    );
  });

  it("requires valid skill directory names", async () => {
    const root = await createRoot();
    await mkdir(join(root, "didactic", "Testing"));
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "INVALID_SKILL_NAME",
      "portable lowercase ASCII skill name",
      "didactic/Testing",
    );
  });

  it("detects IDs duplicated between didactic and evaluation catalogs", async () => {
    const root = await createRoot();
    await writeSkill(root, "didactic", "review");
    await writeSkill(root, "evaluation", "review");
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "DUPLICATE_SKILL_ID",
      "must identify exactly one",
    );
  });

  it("requires SKILL.md at the skill root", async () => {
    const root = await createRoot();
    const directory = join(root, "didactic", "testing");
    const resources = await createResources(directory);
    await writeFile(join(resources, "SKILL.md"), skillMarkdown("testing"));
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "MISSING_SKILL_FILE",
      "Add a regular SKILL.md",
      "didactic/testing/SKILL.md",
    );
  });

  it.each([
    ["a root file", "notes.txt", false],
    ["a root directory", "templates", true],
  ])("rejects %s outside the optional resources directory", async (_case, name, directory) => {
    const root = await createRoot();
    const skillDirectory = await writeSkill(root, "didactic", "testing");
    if (directory) {
      await mkdir(join(skillDirectory, name));
    } else {
      await writeFile(join(skillDirectory, name), "outside resources");
    }
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "UNSUPPORTED_SKILL_LAYOUT",
      "Keep only SKILL.md and an optional resources directory",
      name,
    );
  });

  it("requires resources to be a directory when present", async () => {
    const root = await createRoot();
    const skillDirectory = await writeSkill(root, "didactic", "testing");
    await writeFile(join(skillDirectory, "resources"), "not a directory");
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "UNSUPPORTED_ENTRY_TYPE",
      "Replace resources with a directory",
      "resources",
    );
  });

  it.each([".hidden.txt", "bad\\name.txt"])("rejects the unsafe resource path %s", async (name) => {
    const root = await createRoot();
    const directory = await writeSkill(root, "didactic", "testing");
    const resources = await createResources(directory);
    await writeFile(join(resources, name), "unsafe");
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "UNSAFE_PATH",
      "Use visible relative names",
    );
  });

  it("rejects symbolic links inside skills", async () => {
    const root = await createRoot();
    const directory = await writeSkill(root, "didactic", "testing");
    await symlink(join(directory, "SKILL.md"), join(directory, "notes.md"));
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "UNSAFE_SYMLINK",
      "Replace the link",
    );
  });

  it("rejects symbolic links nested under resources", async () => {
    const root = await createRoot();
    const directory = await writeSkill(root, "didactic", "testing");
    const resources = await createResources(directory);
    await symlink(join(directory, "SKILL.md"), join(resources, "notes.md"));
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "UNSAFE_SYMLINK",
      "Replace the link with a regular file or directory",
      "resources/notes.md",
    );
  });

  it("rejects resource file types that cannot be served as text", async () => {
    const root = await createRoot();
    const directory = await writeSkill(root, "didactic", "testing");
    const resources = await createResources(directory);
    await writeFile(join(resources, "image.png"), "not really an image");
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "UNSUPPORTED_FILE_TYPE",
      "Use only .md",
    );
  });

  it("rejects resources above the Marejada-compatible byte limit", async () => {
    const root = await createRoot();
    const directory = await writeSkill(root, "didactic", "testing");
    const resources = await createResources(directory);
    await writeFile(join(resources, "large.txt"), Buffer.alloc(MAX_BUNDLED_SKILL_FILE_BYTES + 1));
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "FILE_TOO_LARGE",
      `${String(MAX_BUNDLED_SKILL_FILE_BYTES)} bytes`,
    );
  });

  it("rejects text resources that are not valid UTF-8", async () => {
    const root = await createRoot();
    const directory = await writeSkill(root, "didactic", "testing");
    const resources = await createResources(directory);
    await writeFile(join(resources, "invalid.txt"), Uint8Array.from([0xff]));
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "INVALID_TEXT_ENCODING",
      "valid UTF-8",
    );
  });

  it("rejects embedded NUL delimiters instead of hashing ambiguous file boundaries", async () => {
    const root = await createRoot();
    const directory = await writeSkill(root, "didactic", "testing");
    const resources = await createResources(directory);
    await writeFile(join(resources, "ambiguous.txt"), "first\0resources/second.txt\0second");
    await expectSourceError(
      new BundledSkillSource(root).list("didactic"),
      "INVALID_TEXT_ENCODING",
      "Remove NUL bytes from the text file.",
    );
  });
});
