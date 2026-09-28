import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
it("checks Windows file ACLs before returning stored credentials or session content", async () => {
  const root = await mkdtemp(join(tmpdir(), "marea-windows-state-"));
  roots.push(root);
  const file = join(root, "credential.json");
  await writeFile(file, "sensitive synthetic credential", { mode: 0o600 });
  Object.defineProperty(process, "platform", { value: "win32" });
  const inspect = vi.spyOn(privacy, "inspectPrivatePath").mockReturnValue(undefined);
  await expect(readPrivateTextFile(file)).rejects.toThrow(
    "Student state file permissions are unsafe.",
  );
  expect(inspect).toHaveBeenCalledWith(file);
  inspect.mockReturnValue("directory");
  await expect(readPrivateTextFile(file)).rejects.toThrow("permissions are unsafe");
  inspect.mockReturnValue("file");
  await expect(readPrivateTextFile(file)).resolves.toBe("sensitive synthetic credential");
});
