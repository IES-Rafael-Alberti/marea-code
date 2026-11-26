import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as privacy from "@marea/private-filesystem";
import { createTranslator } from "@marea/i18n";
import { SessionTokenSchema } from "@marea/protocol";
import { expect, it, vi } from "vitest";
import { createFileStudentStores } from "./filesystem.boundary.js";
import { createLocalStateRecovery } from "./local-state-recovery.boundary.js";
import { runLogoutCommand } from "./logout-command.boundary.js";

import { useWindowsPlatformSandbox } from "./windows-platform.fixture.js";

const temporaryRoot = useWindowsPlatformSandbox("marea-windows-state-permissions-");
const token = SessionTokenSchema.parse("synthetic-windows-session-token-0123456789abcdef");

/** A classroom computer where every ACL write and inspection fails, as with `set-acl-failed`. */
function failingWindowsAcl() {
  Object.defineProperty(process, "platform", { value: "win32" });
  const secure = vi.spyOn(privacy, "securePrivatePath").mockImplementation(() => {
    throw new privacy.PrivateFilesystemError("private-fs.set-acl-failed");
  });
  const inspect = vi.spyOn(privacy, "checkWindowsPrivatePath").mockImplementation(() => {
    throw new privacy.PrivateFilesystemError("private-fs.set-acl-failed");
  });
  return { inspect, secure };
}

async function locations() {
  const root = await temporaryRoot();
  const projectRoot = join(root, "project");
  const stateDirectory = join(root, "state");
  await mkdir(projectRoot);
  return { projectRoot, stateDirectory };
}

it("opens, saves and reads the Windows student state without writing any ACL", async () => {
  const acl = failingWindowsAcl();
  const stores = await createFileStudentStores(await locations());
  await stores.credentials.save(token);
  await expect(stores.credentials.load()).resolves.toBe(token);
  await expect(stores.state.load()).resolves.toMatchObject({ run: null });
  await stores.failures.append({ kind: "synthetic" });
  expect(acl.secure).not.toHaveBeenCalled();
  expect(acl.inspect).not.toHaveBeenCalled();
});

it("signs out on Windows even when the folder permissions cannot be set", async () => {
  const acl = failingWindowsAcl();
  const where = await locations();
  await mkdir(where.stateDirectory);
  const credential = join(where.stateDirectory, "credential.json");
  await writeFile(credential, JSON.stringify({ token }), { mode: 0o600 });
  const writes: string[] = [];
  await expect(
    runLogoutCommand({
      ...where,
      translator: createTranslator("es"),
      output: { write: (text) => writes.push(text) },
    }),
  ).resolves.toBe(0);
  expect(existsSync(credential)).toBe(false);
  expect(writes).toEqual([`${createTranslator("es").t("student.cli.logout-done")}\n`]);
  expect(acl.secure).not.toHaveBeenCalled();
});

it("sets damaged Windows state aside without writing any ACL", async () => {
  const acl = failingWindowsAcl();
  const where = await locations();
  await mkdir(where.stateDirectory);
  await writeFile(join(where.stateDirectory, "session.json"), "{", { mode: 0o600 });
  const stores = await createFileStudentStores(where);
  const recovery = createLocalStateRecovery({
    notice: () => undefined,
    probes: [{ file: "session.json", load: () => stores.state.load(), reason: "session" }],
    stateDirectory: where.stateDirectory,
    translator: createTranslator("es"),
  });
  await recovery.prepare();
  expect(recovery.report().recovered).toBe(true);
  expect(await readdir(where.stateDirectory)).toContain("quarantine");
  expect(acl.secure).not.toHaveBeenCalled();
  expect(acl.inspect).not.toHaveBeenCalled();
});
