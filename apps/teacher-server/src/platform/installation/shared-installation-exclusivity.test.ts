import { existsSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FilesystemInstallationExclusivity } from "../operations/host/filesystem-exclusivity.js";
import { cleanupInstallations, temporaryInstallation } from "../operator-cli/filesystem.fixture.js";
import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { createSharedInstallationExclusivity } from "./shared-installation-exclusivity.js";

afterEach(() => {
  cleanupInstallations();
});

const HOST_LOCK = ".marea-installation.lock";
const OPERATOR_LOCK = join("locks", "installation.lock");

function shared() {
  return createSharedInstallationExclusivity(
    new FilesystemInstallationExclusivity(),
    acquireInstallation,
  );
}

describe("shared installation exclusivity", () => {
  it("holds the host and operator locks together and releases both", async () => {
    const root = temporaryInstallation();
    const exclusivity = shared();
    expect(await exclusivity.inspect(root)).toBe("free");
    const lock = await exclusivity.acquire(root);
    expect(lock.canonicalRoot).toBe(root);
    expect(lock.releaseState).toBe("owned");
    expect(existsSync(join(root, HOST_LOCK))).toBe(true);
    expect(existsSync(join(root, OPERATOR_LOCK))).toBe(true);
    expect(await exclusivity.inspect(root)).toBe("held");
    expect(() => acquireInstallation(root)).toThrow("installation-busy");
    await expect(exclusivity.acquire(root)).rejects.toMatchObject({ code: "owner-busy" });
    await lock.release();
    expect(lock.releaseState).toBe("released");
    expect(existsSync(join(root, HOST_LOCK))).toBe(false);
    expect(existsSync(join(root, OPERATOR_LOCK))).toBe(false);
    acquireInstallation(root).release();
  });

  it("refuses the host while the operator CLI owns the installation", async () => {
    const root = temporaryInstallation();
    const operator = acquireInstallation(root);
    const exclusivity = shared();
    expect(await exclusivity.inspect(root)).toBe("held");
    await expect(exclusivity.acquire(root)).rejects.toMatchObject({
      code: "owner-busy",
      message: "the operator installation lock is unavailable",
    });
    expect(existsSync(join(root, HOST_LOCK))).toBe(false);
    expect(operator.release()).toBe(true);
    expect(await exclusivity.inspect(root)).toBe("free");
  });

  it("reports an unknown host lock without consulting the operator lock", async () => {
    const root = temporaryInstallation();
    symlinkSync(join(root, "work"), join(root, HOST_LOCK));
    const operator = acquireInstallation(root);
    expect(await shared().inspect(root)).toBe("unknown");
    operator.release();
  });

  it("fails closed without a private operator lock directory", async () => {
    const root = temporaryInstallation();
    renameSync(join(root, "locks"), join(root, "moved"));
    await expect(shared().acquire(root)).rejects.toMatchObject({ code: "path" });
    expect(existsSync(join(root, HOST_LOCK))).toBe(false);
  });

  it("releases the host lock and reports an operator lock it cannot prove", async () => {
    const root = temporaryInstallation();
    const lock = await shared().acquire(root);
    renameSync(join(root, OPERATOR_LOCK), join(root, "old.lock"));
    writeFileSync(join(root, OPERATOR_LOCK), "foreign", { mode: 0o600 });
    await expect(lock.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "the operator installation lock could not be released",
    });
    expect(existsSync(join(root, HOST_LOCK))).toBe(false);
    expect(existsSync(join(root, OPERATOR_LOCK))).toBe(true);
    await expect(lock.release()).rejects.toMatchObject({ code: "owner-busy" });
  });
});
