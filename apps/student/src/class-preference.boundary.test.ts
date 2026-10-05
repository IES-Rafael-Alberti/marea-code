import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileClassPreferenceStore } from "./class-preference.boundary.js";
import { TemporaryDirectories } from "./filesystem-test.fixture.js";

const temporaryDirectories = new TemporaryDirectories();

afterEach(async () => {
  await temporaryDirectories.removeAll();
});

describe("file class preference", () => {
  it("remembers this folder's chosen class privately and validates it", async () => {
    const stateDirectory = join(await temporaryDirectories.create("class-preference"), "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const store = createFileClassPreferenceStore(stateDirectory);

    expect(await store.load()).toBeNull();
    await store.save("class:two");
    expect(await store.load()).toBe("class:two");
    const path = join(stateDirectory, "class.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ classId: "class:two" });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(store.save("-invalid")).rejects.toThrow();
    await writeFile(path, JSON.stringify({ classId: "class:two", extra: true }), { mode: 0o600 });
    await expect(store.load()).rejects.toThrow();
  });
});
