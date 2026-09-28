import { readFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { securePrivatePath } from "@marea/private-filesystem";
import { afterEach, expect, it, vi } from "vitest";
import { writePrivateFileAtomically } from "./filesystem.boundary.js";
import { TemporaryDirectories } from "./filesystem-test.fixture.js";

vi.mock("@marea/private-filesystem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marea/private-filesystem")>();
  return { ...actual, securePrivatePath: vi.fn(actual.securePrivatePath) };
});

const directories = new TemporaryDirectories();
afterEach(async () => {
  vi.resetAllMocks();
  await directories.removeAll();
});

it("preserves the previous credential when private permissions cannot be established before writing", async () => {
  const directory = await directories.create("private-write-failure");
  const destination = join(directory, "credential.json");
  await writeFile(destination, "previous credential", { mode: 0o600 });
  const failure = new Error("Private permissions unavailable");
  vi.mocked(securePrivatePath).mockImplementationOnce((path) => {
    expect(path).not.toBe(destination);
    expect(readFileSync(path, "utf8")).toBe("");
    throw failure;
  });

  await expect(writePrivateFileAtomically(destination, "new credential")).rejects.toBe(failure);
  expect(await readFile(destination, "utf8")).toBe("previous credential");
  expect(await readdir(directory)).toEqual(["credential.json"]);
});
