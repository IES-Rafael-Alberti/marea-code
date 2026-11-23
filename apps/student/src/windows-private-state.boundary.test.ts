import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as privacy from "@marea/private-filesystem";
import { afterEach, expect, it, vi } from "vitest";
import { readPrivateTextFile } from "./filesystem.boundary.js";

const platform = process.platform;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "marea-windows-state-"));
  roots.push(root);
  const file = join(root, "credential.json");
  await writeFile(file, "sensitive synthetic credential", { mode: 0o600 });
  return file;
}

it("skips the ACL inspect when the parent directory was verified this process", async () => {
  const file = await fixture();
  Object.defineProperty(process, "platform", { value: "win32" });
  const verified = vi.spyOn(privacy, "isVerifiedPrivateDirectory").mockReturnValue(true);
  const check = vi.spyOn(privacy, "checkWindowsPrivatePath");
  await expect(readPrivateTextFile(file)).resolves.toBe("sensitive synthetic credential");
  expect(verified).toHaveBeenCalledWith(dirname(file));
  expect(check).not.toHaveBeenCalled();
});

it("inspects the file when the parent directory was not verified", async () => {
  const file = await fixture();
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.spyOn(privacy, "isVerifiedPrivateDirectory").mockReturnValue(false);
  const check = vi.spyOn(privacy, "checkWindowsPrivatePath").mockReturnValue("file");
  await expect(readPrivateTextFile(file)).resolves.toBe("sensitive synthetic credential");
  expect(check).toHaveBeenCalledWith(file, "inspect");
});

it("rethrows a typed reason as the student permissions message", async () => {
  const file = await fixture();
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.spyOn(privacy, "isVerifiedPrivateDirectory").mockReturnValue(false);
  vi.spyOn(privacy, "checkWindowsPrivatePath").mockImplementation(() => {
    throw new privacy.PrivateFilesystemError("private-fs.owner-mismatch");
  });
  await expect(readPrivateTextFile(file)).rejects.toMatchObject({
    name: "PrivateFilesystemError",
    diagnosticCode: "private-fs.owner-mismatch",
    message: "Student state file permissions are unsafe.",
  });
});

it("rejects a non-file result as an unexpected typed error", async () => {
  const file = await fixture();
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.spyOn(privacy, "isVerifiedPrivateDirectory").mockReturnValue(false);
  vi.spyOn(privacy, "checkWindowsPrivatePath").mockReturnValue("directory");
  await expect(readPrivateTextFile(file)).rejects.toMatchObject({
    diagnosticCode: "private-fs.unexpected",
    message: "Student state file permissions are unsafe.",
  });
});

it("rethrows a non-private error unchanged", async () => {
  const file = await fixture();
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.spyOn(privacy, "isVerifiedPrivateDirectory").mockReturnValue(false);
  vi.spyOn(privacy, "checkWindowsPrivatePath").mockImplementation(() => {
    throw new Error("inspect failure");
  });
  await expect(readPrivateTextFile(file)).rejects.toThrow("inspect failure");
});
