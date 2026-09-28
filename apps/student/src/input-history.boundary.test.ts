import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openInputHistory } from "./input-history.boundary.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(token = "student-a") {
  const path = await mkdtemp(join(tmpdir(), "marea-input-history-"));
  directories.push(path);
  await writeFile(join(path, "credential.json"), JSON.stringify({ token }), { mode: 0o600 });
  return path;
}

it("persists bounded private history across restarts, isolated by credential", async () => {
  const path = await fixture();
  await mkdir(join(path, "input-history"), { mode: 0o755 });
  await chmod(join(path, "input-history"), 0o755);
  expect((await stat(join(path, "input-history"))).mode & 0o777).toBe(0o755);
  const first = await openInputHistory(path);
  expect(first.entries).toEqual([]);
  first.remember("first\nsecond line");
  first.remember("second");
  await first.flush();
  expect((await openInputHistory(path)).entries).toEqual(["second", "first\nsecond line"]);
  const directory = join(path, "input-history");
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  const file = join(directory, files[0] ?? "missing");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readFile(file, "utf8")).toBe('["second","first\\nsecond line"]');
  expect(() => {
    first.remember("x".repeat(8193));
  }).toThrow();
  // Seed the existing history near capacity; exercise both sides of the limit
  // through real atomic saves without queuing hundreds of redundant disk writes.
  await writeFile(
    file,
    JSON.stringify(Array.from({ length: 499 }, (_, index) => String(498 - index))),
  );
  const bounded = await openInputHistory(path);
  bounded.remember("499");
  expect(bounded.entries).toHaveLength(500);
  expect(bounded.entries.at(-1)).toBe("0");
  bounded.remember("500");
  await bounded.flush();
  expect(bounded.entries).toHaveLength(500);
  expect(bounded.entries.at(-1)).toBe("1");
  expect((await openInputHistory(path)).entries).toEqual(bounded.entries);
  await writeFile(join(path, "credential.json"), '{"token":"student-b"}');
  expect((await openInputHistory(path)).entries).toEqual([]);
});

it("rejects missing credentials and malformed history without leaking it", async () => {
  const path = await fixture();
  const history = await openInputHistory(path);
  history.remember("hello");
  await history.flush();
  const directory = join(path, "input-history");
  const [name] = await readdir(directory);
  await writeFile(join(directory, name ?? "missing"), "{}");
  await expect(openInputHistory(path)).rejects.toThrow();
  await rm(join(path, "credential.json"));
  await expect(openInputHistory(path)).rejects.toThrow(
    "Student credentials are required for input history.",
  );
});

it("reports failed atomic saves at the flush boundary without an unhandled rejection", async () => {
  const path = await fixture();
  const history = await openInputHistory(path);
  await rm(join(path, "input-history"), { recursive: true });
  history.remember("kept in memory");
  await expect(history.flush()).rejects.toThrow("Input history could not be saved.");
  expect(history.entries).toEqual(["kept in memory"]);
});
