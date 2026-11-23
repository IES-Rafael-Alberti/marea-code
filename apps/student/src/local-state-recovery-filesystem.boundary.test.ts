import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TemporaryDirectories } from "./filesystem-test.fixture.js";
import { createNodeLocalStateFileSystem } from "./local-state-recovery.boundary.js";

const temporaryDirectories = new TemporaryDirectories();

afterEach(async () => {
  await temporaryDirectories.removeAll();
});

describe("node local state filesystem", () => {
  it("reports missing paths, refuses unreadable ones and secures new directories", async () => {
    const filesystem = createNodeLocalStateFileSystem();
    const root = await temporaryDirectories.create("recovery-port");
    const file = join(root, "session.json");
    await writeFile(file, "{}");

    expect(await filesystem.inspect(join(root, "missing.json"))).toBeNull();
    expect(await filesystem.inspect(file)).toMatchObject({ regularFile: true });
    expect((await filesystem.inspect(file))?.modifiedAt).toBeGreaterThan(0);
    expect(await filesystem.inspect(root)).toMatchObject({ regularFile: false });
    await expect(filesystem.inspect(join(file, "child"))).rejects.toThrow();
    expect(await filesystem.list(join(root, "missing"))).toEqual([]);
    await expect(filesystem.list(file)).rejects.toThrow();

    await filesystem.secureDirectory(join(root, "quarantine", "id"));
    expect((await lstat(join(root, "quarantine", "id"))).mode & 0o777).toBe(0o700);

    await filesystem.move(file, join(root, "moved.json"));
    expect(await filesystem.inspect(file)).toBeNull();
    await filesystem.remove(join(root, "moved.json"));
    expect(await filesystem.inspect(join(root, "moved.json"))).toBeNull();
  });
});
