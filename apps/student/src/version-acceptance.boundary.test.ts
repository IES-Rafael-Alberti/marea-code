import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createStudentVersionAcceptanceStore } from "./version-acceptance.boundary.js";

const PAIR = {
  serverUrl: "https://teacher.example",
  serverVersion: "0.2.0-preview.48",
  clientVersion: "0.2.0-preview.47",
} as const;

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "marea-version-acceptance-"));
}

describe("remembered version acceptances", () => {
  it("remembers a pair only for the same server and the same two versions", async () => {
    const directory = await root();
    const store = createStudentVersionAcceptanceStore(directory);
    await expect(store.has(PAIR)).resolves.toBe(false);
    await store.remember(PAIR);
    await expect(createStudentVersionAcceptanceStore(directory).has(PAIR)).resolves.toBe(true);
    await expect(store.has({ ...PAIR, serverUrl: "https://other.example" })).resolves.toBe(false);
    await expect(store.has({ ...PAIR, serverVersion: "0.2.0-preview.49" })).resolves.toBe(false);
    await expect(store.has({ ...PAIR, clientVersion: "0.2.0-preview.46" })).resolves.toBe(false);
  });

  it("keeps other settings and does not store a pair twice", async () => {
    const directory = await root();
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({ "marea.usage-line.v1": true }));
    const store = createStudentVersionAcceptanceStore(directory);
    await store.remember(PAIR);
    await store.remember(PAIR);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      "marea.usage-line.v1": true,
      "marea.accepted-version-pairs.v1": [
        JSON.stringify([PAIR.serverUrl, PAIR.serverVersion, PAIR.clientVersion]),
      ],
    });
  });

  it("keeps only the most recent hundred acceptances", async () => {
    const directory = await root();
    const store = createStudentVersionAcceptanceStore(directory);
    for (let index = 0; index < 101; index += 1)
      await store.remember({ ...PAIR, serverVersion: `1.0.${String(index)}` });
    await expect(store.has({ ...PAIR, serverVersion: "1.0.0" })).resolves.toBe(false);
    await expect(store.has({ ...PAIR, serverVersion: "1.0.1" })).resolves.toBe(true);
    await expect(store.has({ ...PAIR, serverVersion: "1.0.100" })).resolves.toBe(true);
  });

  it.each([
    "not-json",
    '{"marea.accepted-version-pairs.v1":"yes"}',
    '{"marea.accepted-version-pairs.v1":[1]}',
  ])("treats unreadable stored data %s as nothing accepted", async (content) => {
    const directory = await root();
    await writeFile(join(directory, "settings.json"), content);
    await expect(createStudentVersionAcceptanceStore(directory).has(PAIR)).resolves.toBe(false);
  });
});
