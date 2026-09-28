import type { Dirent, Stats } from "node:fs";
import type * as FileSystemModule from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ReadStats = (path: string) => Promise<Stats>;
type ReadDirectory = (path: string, options: { readonly withFileTypes: true }) => Promise<Dirent[]>;
type ReadBytes = (path: string) => Promise<Buffer>;
type ReadRealPath = (path: string) => Promise<string>;

const fsMocks = vi.hoisted(() => ({
  lstat: vi.fn<ReadStats>(),
  readdir: vi.fn<ReadDirectory>(),
  readFile: vi.fn<ReadBytes>(),
  realpath: vi.fn<ReadRealPath>(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FileSystemModule>("node:fs/promises");
  return {
    ...actual,
    lstat: fsMocks.lstat,
    readdir: fsMocks.readdir,
    readFile: fsMocks.readFile,
    realpath: fsMocks.realpath,
  };
});

import {
  BundledSkillSource,
  MAX_BUNDLED_SKILL_FILE_BYTES,
  isPathOutsideRoot,
} from "./bundled-skill-source.boundary.js";
import { BundledSkillError, type BundledSkillErrorCode } from "./errors.js";

const roots: string[] = [];

beforeEach(async () => {
  const actual = await vi.importActual<typeof FileSystemModule>("node:fs/promises");
  fsMocks.lstat.mockImplementation((path) => actual.lstat(path));
  fsMocks.readdir.mockImplementation((path) => actual.readdir(path, { withFileTypes: true }));
  fsMocks.readFile.mockImplementation((path) => actual.readFile(path));
  fsMocks.realpath.mockImplementation((path) => actual.realpath(path));
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly skillFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "marea-filesystem-boundary-"));
  roots.push(root);
  await mkdir(join(root, "didactic", "testing"), { recursive: true });
  await mkdir(join(root, "evaluation"));
  const skillFile = join(root, "didactic", "testing", "SKILL.md");
  await writeFile(skillFile, "---\nname: testing\ndescription: Test guidance\n---\n\n# Testing\n");
  return { root, skillFile };
}

async function expectCode(
  promise: Promise<object>,
  code: BundledSkillErrorCode,
  message?: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(BundledSkillError);
  await expect(promise).rejects.toMatchObject({ code });
  if (message !== undefined) {
    await expect(promise).rejects.toThrow(message);
  }
}

function changedStats(
  stats: Stats,
  overrides: { readonly symlink: boolean; readonly file: boolean; readonly size?: number },
): Stats {
  const changed = Object.create(stats) as Stats;
  changed.isSymbolicLink = () => overrides.symlink;
  changed.isFile = () => overrides.file;
  if (overrides.size !== undefined) {
    Object.defineProperty(changed, "size", { value: overrides.size });
  }
  return changed;
}

async function mockChangedFile(
  root: string,
  skillFile: string,
  overrides: { readonly symlink: boolean; readonly file: boolean; readonly size?: number },
): Promise<void> {
  const actual = await vi.importActual<typeof FileSystemModule>("node:fs/promises");
  const rootStats = await actual.lstat(root);
  const kindStats = await actual.lstat(join(root, "didactic"));
  const fileStats = await actual.lstat(skillFile);
  fsMocks.lstat
    .mockResolvedValueOnce(rootStats)
    .mockResolvedValueOnce(kindStats)
    .mockResolvedValueOnce(changedStats(fileStats, overrides));
}

function unusualEntry(entry: Dirent): Dirent {
  const changed = Object.create(entry) as Dirent;
  Object.defineProperties(changed, {
    name: { value: "pipe.md" },
    isDirectory: { value: () => false },
    isFile: { value: () => false },
    isSymbolicLink: { value: () => false },
  });
  return changed;
}

describe("bundled skill file-system failures", () => {
  it("keeps deterministic comparison when a listing repeats an entry", async () => {
    const { root } = await fixture();
    const actual = await vi.importActual<typeof FileSystemModule>("node:fs/promises");
    const entries = await actual.readdir(join(root, "didactic"), {
      withFileTypes: true,
    });
    const entry = entries[0];
    if (entry === undefined) {
      throw new Error("The test fixture must contain a skill directory.");
    }
    fsMocks.readdir.mockResolvedValueOnce([entry, entry]);

    await expectCode(new BundledSkillSource(root).list("didactic"), "DUPLICATE_SKILL_ID");
  });

  it("sorts an unsorted file-system listing by portable name", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "didactic", "alpha"));
    await writeFile(
      join(root, "didactic", "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: Alpha guidance\n---\n",
    );
    const actual = await vi.importActual<typeof FileSystemModule>("node:fs/promises");
    const entries = await actual.readdir(join(root, "didactic"), { withFileTypes: true });
    fsMocks.readdir.mockResolvedValueOnce(entries.reverse());

    const summaries = await new BundledSkillSource(root).list("didactic");

    expect(summaries.map((summary) => summary.id)).toEqual(["marea/alpha", "marea/testing"]);
  });

  it("wraps directory listing failures", async () => {
    const { root } = await fixture();
    fsMocks.readdir.mockRejectedValueOnce(new Error("listing denied"));

    await expectCode(new BundledSkillSource(root).list("didactic"), "READ_FAILED");
  });

  it("wraps canonical-path failures", async () => {
    const { root } = await fixture();
    fsMocks.realpath.mockRejectedValueOnce(new Error("canonicalization denied"));

    await expectCode(new BundledSkillSource(root).list("didactic"), "READ_FAILED");
  });

  it("wraps file read failures", async () => {
    const { root } = await fixture();
    fsMocks.readFile.mockRejectedValueOnce(new Error("read denied"));

    await expectCode(new BundledSkillSource(root).list("didactic"), "READ_FAILED");
  });

  it("rechecks and rejects a file changed into a symbolic link", async () => {
    const { root, skillFile } = await fixture();
    await mockChangedFile(root, skillFile, { symlink: true, file: true });

    await expectCode(
      new BundledSkillSource(root).list("didactic"),
      "UNSAFE_SYMLINK",
      "Replace the link with a regular text file",
    );
  });

  it("rechecks and rejects a file changed into another entry type", async () => {
    const { root, skillFile } = await fixture();
    await mockChangedFile(root, skillFile, { symlink: false, file: false });

    await expectCode(
      new BundledSkillSource(root).list("didactic"),
      "UNSUPPORTED_ENTRY_TYPE",
      "Replace the entry with a regular text file",
    );
  });

  it("rejects an entry that is neither a file, directory, nor link", async () => {
    const { root } = await fixture();
    const resources = join(root, "didactic", "testing", "resources");
    await mkdir(resources);
    await writeFile(join(resources, "pipe.md"), "placeholder");
    const actual = await vi.importActual<typeof FileSystemModule>("node:fs/promises");
    const rootEntries = await actual.readdir(join(root, "didactic"), {
      withFileTypes: true,
    });
    const skillEntries = await actual.readdir(join(root, "didactic", "testing"), {
      withFileTypes: true,
    });
    const fileEntries = await actual.readdir(resources, { withFileTypes: true });
    const firstEntry = fileEntries[0];
    if (firstEntry === undefined) {
      throw new Error("The test fixture must contain a resource.");
    }
    fsMocks.readdir
      .mockResolvedValueOnce(rootEntries)
      .mockResolvedValueOnce(skillEntries)
      .mockResolvedValueOnce([unusualEntry(firstEntry)]);

    await expectCode(
      new BundledSkillSource(root).list("didactic"),
      "UNSUPPORTED_ENTRY_TYPE",
      "Use only regular files and directories in bundled skills",
    );
  });

  it("does not read a file whose metadata is already above the size limit", async () => {
    const { root, skillFile } = await fixture();
    await mockChangedFile(root, skillFile, {
      symlink: false,
      file: true,
      size: MAX_BUNDLED_SKILL_FILE_BYTES + 1,
    });

    await expectCode(new BundledSkillSource(root).list("didactic"), "FILE_TOO_LARGE");
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it("rejects a file that grows after its metadata check", async () => {
    const { root } = await fixture();
    fsMocks.readFile.mockResolvedValueOnce(Buffer.alloc(MAX_BUNDLED_SKILL_FILE_BYTES + 1));

    await expectCode(new BundledSkillSource(root).list("didactic"), "FILE_TOO_LARGE");
  });

  it("rejects a canonical target moved outside the bundled root", async () => {
    const { root } = await fixture();
    fsMocks.realpath.mockResolvedValueOnce(root).mockResolvedValueOnce(resolve(root, ".."));

    await expectCode(
      new BundledSkillSource(root).list("didactic"),
      "PATH_OUTSIDE_ROOT",
      "Move the entry inside the configured bundled skill root",
    );
  });
});

describe("path containment classification", () => {
  it("recognizes parent, descendant, absolute, and contained paths", () => {
    expect(isPathOutsideRoot("..")).toBe(true);
    expect(isPathOutsideRoot(join("..", "other"))).toBe(true);
    expect(isPathOutsideRoot(resolve("other"))).toBe(true);
    expect(isAbsolute(resolve("other"))).toBe(true);
    expect(isPathOutsideRoot(join("didactic", "testing"))).toBe(false);
  });
});
