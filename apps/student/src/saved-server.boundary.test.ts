import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createSavedServerStore } from "./saved-server.boundary.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "marea-saved-server-"));
  roots.push(root);
  return root;
}

it("saves the server privately in a file of its own and loads it back", async () => {
  const root = join(stateRoot(), "nested", "state");
  const store = createSavedServerStore(root);
  expect(await store.load()).toBeUndefined();
  expect(existsSync(join(root, "server-problems.jsonl"))).toBe(false);
  await store.save("http://192.168.1.20:18787");
  expect(await createSavedServerStore(root).load()).toBe("http://192.168.1.20:18787");
  const path = join(root, "server.json");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    version: 1,
    server: "http://192.168.1.20:18787",
  });
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  }
  await store.save("https://aula.example");
  expect(await store.load()).toBe("https://aula.example");
  expect(existsSync(join(root, "server-problems.jsonl"))).toBe(false);
});

it("treats a missing file as no saved server, without a diagnostic", async () => {
  const root = stateRoot();
  expect(await createSavedServerStore(root).load()).toBeUndefined();
  expect(existsSync(join(root, "server-problems.jsonl"))).toBe(false);
});

it("ignores a corrupt file and leaves a private diagnostic", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-26T10:00:00.000Z"), toFake: ["Date"] });
  const root = stateRoot();
  writeFileSync(join(root, "server.json"), "{ corrupt");
  expect(await createSavedServerStore(root).load()).toBeUndefined();
  expect(readFileSync(join(root, "server-problems.jsonl"), "utf8")).toBe(
    '{"at":"2026-11-26T10:00:00.000Z","code":"saved-server.invalid"}\n',
  );
  if (process.platform !== "win32")
    expect(statSync(join(root, "server-problems.jsonl")).mode & 0o777).toBe(0o600);
});

it("ignores an unreadable file with its own diagnostic code", async () => {
  const root = stateRoot();
  mkdirSync(join(root, "server.json"));
  expect(await createSavedServerStore(root).load()).toBeUndefined();
  expect(readFileSync(join(root, "server-problems.jsonl"), "utf8")).toContain(
    '"code":"saved-server.unreadable"',
  );
});

it("still ignores a corrupt file when the diagnostic cannot be written", async () => {
  const root = stateRoot();
  writeFileSync(join(root, "server.json"), "nope");
  mkdirSync(join(root, "server-problems.jsonl"));
  expect(await createSavedServerStore(root).load()).toBeUndefined();
});
