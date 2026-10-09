import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as privateFilesystem from "@marea/private-filesystem";
import { inspectPrivatePath } from "@marea/private-filesystem";
import { installPreviewAtomically } from "./preview-install-transaction.boundary.js";

const filesystemBehavior = vi.hoisted(() => ({ destinationMustBeAbsent: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (filesystemBehavior.destinationMustBeAbsent && actual.existsSync(to))
      throw new Error("Destination directory already exists");
    actual.renameSync(from, to);
  };
  return { ...actual, renameSync };
});

let scratch: string;
let root: string;
beforeEach(() => {
  filesystemBehavior.destinationMustBeAbsent = false;
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-first-install-")));
  root = join(scratch, "managed", "server");
  vi.spyOn(privateFilesystem, "securePrivatePath");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

function prepare(stage: string): Promise<void> {
  expect(stage).not.toBe(root);
  expect(dirname(stage)).toBe(dirname(root));
  expect(stage).toMatch(/\/\.server-install-[A-Za-z0-9]{6}$/u);
  expect(inspectPrivatePath(stage)).toBe("directory");
  // Windows requires explicit ACL inheritance before any prepared files are written.
  expect(privateFilesystem.securePrivatePath).toHaveBeenCalledWith(stage, 0o700);
  mkdirSync(join(stage, "bin"), { mode: 0o700 });
  writeFileSync(join(stage, "bin", "marea-teacher"), "complete launcher");
  writeFileSync(join(stage, "preview.json"), "complete settings");
  return Promise.resolve();
}

it.each([false, true])(
  "promotes the complete installation with a previously empty root: %s",
  async (empty) => {
    if (empty) mkdirSync(root, { recursive: true, mode: 0o700 });
    await installPreviewAtomically(root, async (stage) => {
      await prepare(stage);
      expect(existsSync(join(root, "bin"))).toBe(false);
      expect(existsSync(join(root, "preview.json"))).toBe(false);
    });
    expect(readFileSync(join(root, "bin", "marea-teacher"), "utf8")).toBe("complete launcher");
    expect(readFileSync(join(root, "preview.json"), "utf8")).toBe("complete settings");
    expect(inspectPrivatePath(root)).toBe("directory");
    expect(readdirSync(dirname(root))).toEqual(["server"]);
  },
);

it("cleans failed preparation and allows the same command to retry", async () => {
  await expect(
    installPreviewAtomically(root, async (stage) => {
      await prepare(stage);
      throw new Error("interrupted download or launcher write");
    }),
  ).rejects.toThrow("interrupted download or launcher write");
  expect(existsSync(root)).toBe(false);
  expect(readdirSync(dirname(root))).toEqual([]);
  await installPreviewAtomically(root, prepare);
  expect(existsSync(join(root, "bin", "marea-teacher"))).toBe(true);
});

it("never overwrites an installation created by another process during preparation", async () => {
  await expect(
    installPreviewAtomically(root, async (stage) => {
      await prepare(stage);
      mkdirSync(root, { mode: 0o700 });
      writeFileSync(join(root, "school-data"), "keep existing school");
    }),
  ).rejects.toThrow();
  expect(readFileSync(join(root, "school-data"), "utf8")).toBe("keep existing school");
  expect(readdirSync(dirname(root))).toEqual(["server"]);
});

it("rejects a replaced destination without traversing it or deleting its contents", async () => {
  const elsewhere = join(scratch, "unowned");
  mkdirSync(elsewhere, { mode: 0o700 });
  await expect(
    installPreviewAtomically(root, async (stage) => {
      await prepare(stage);
      symlinkSync(elsewhere, root);
    }),
  ).rejects.toThrow("canonical directory");
  expect(existsSync(elsewhere)).toBe(true);
  expect(readdirSync(elsewhere)).toEqual([]);
});

it("a scratch directory left by a killed process does not prevent retrying", async () => {
  const abandoned = join(dirname(root), ".server-install-ABC123");
  mkdirSync(abandoned, { recursive: true, mode: 0o700 });
  writeFileSync(join(abandoned, "partial"), "interrupted bytes");
  await installPreviewAtomically(root, prepare);
  expect(existsSync(join(root, "preview.json"))).toBe(true);
  expect(readFileSync(join(abandoned, "partial"), "utf8")).toBe("interrupted bytes");
});

it("refuses a linked staging parent before invoking any download or writing private files", async () => {
  mkdirSync(join(scratch, "elsewhere"), { mode: 0o700 });
  symlinkSync(join(scratch, "elsewhere"), dirname(root));
  const download = vi.fn(() => Promise.resolve());
  await expect(installPreviewAtomically(root, download)).rejects.toThrow("canonical directory");
  expect(download).not.toHaveBeenCalled();
  expect(readdirSync(join(scratch, "elsewhere"))).toEqual([]);
});

it("promotes over an empty root on filesystems that cannot replace an existing directory", async () => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  filesystemBehavior.destinationMustBeAbsent = true;
  await installPreviewAtomically(root, prepare);
  expect(existsSync(join(root, "preview.json"))).toBe(true);
});
