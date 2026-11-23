import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as privacy from "@marea/private-filesystem";
import { afterEach, expect, it, vi } from "vitest";
import {
  securePrivateDirectory,
  securePrivateFileParent,
} from "./private-file-windows.boundary.js";

const platform = process.platform;
const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("secures and marks a Windows directory as verified", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const secure = vi.spyOn(privacy, "securePrivatePath").mockReturnValue(undefined);
  const mark = vi.spyOn(privacy, "markVerifiedPrivateDirectory").mockReturnValue(undefined);
  securePrivateDirectory("C:\\state");
  expect(secure).toHaveBeenCalledWith("C:\\state", 0o700);
  expect(mark).toHaveBeenCalledWith("C:\\state");
});

it("does not mark directories on POSIX", () => {
  const secure = vi.spyOn(privacy, "securePrivatePath").mockReturnValue(undefined);
  const mark = vi.spyOn(privacy, "markVerifiedPrivateDirectory").mockReturnValue(undefined);
  securePrivateDirectory("/tmp/state");
  expect(secure).toHaveBeenCalledWith("/tmp/state", 0o700);
  expect(mark).not.toHaveBeenCalled();
});

it("secures the file itself on POSIX", () => {
  const secure = vi.spyOn(privacy, "securePrivatePath").mockReturnValue(undefined);
  securePrivateFileParent("/tmp/state.json");
  expect(secure).toHaveBeenCalledWith("/tmp/state.json", 0o600);
});

it("skips securing when the Windows parent directory is already verified", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const secure = vi.spyOn(privacy, "securePrivatePath").mockReturnValue(undefined);
  const verified = vi.spyOn(privacy, "isVerifiedPrivateDirectory").mockReturnValue(true);
  securePrivateFileParent("C:/state/credential.json");
  expect(verified).toHaveBeenCalledWith("C:/state");
  expect(secure).not.toHaveBeenCalled();
});

it("secures an unverified Windows parent directory", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const secure = vi.spyOn(privacy, "securePrivatePath").mockReturnValue(undefined);
  const mark = vi.spyOn(privacy, "markVerifiedPrivateDirectory").mockReturnValue(undefined);
  vi.spyOn(privacy, "isVerifiedPrivateDirectory").mockReturnValue(false);
  securePrivateFileParent("C:/state/credential.json");
  expect(secure).toHaveBeenCalledWith("C:/state", 0o700);
  expect(mark).toHaveBeenCalledWith("C:/state");
});

it("verifies a Windows directory once across many file-parent protections", async () => {
  const root = await mkdtemp(join(tmpdir(), "marea-win-memo-"));
  roots.push(root);
  Object.defineProperty(process, "platform", { value: "win32" });
  const secure = vi.spyOn(privacy, "securePrivatePath").mockReturnValue(undefined);
  // Real mark/is verify the memoization: one secure for the directory, none for files.
  securePrivateDirectory(root);
  securePrivateFileParent(join(root, "one.json"));
  securePrivateFileParent(join(root, "two.json"));
  expect(secure).toHaveBeenCalledTimes(1);
});
