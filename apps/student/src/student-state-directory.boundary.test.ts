import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  canonicalStateDirectory,
  locateStateDirectory,
} from "./student-state-directory.boundary.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

function legacyDirectory(): string {
  const legacy = join(
    base,
    "student",
    createHash("sha256").update(SERVER).update("\0").update(link).digest("hex"),
  );
  mkdirSync(legacy, { recursive: true });
  return legacy;
}

const SERVER = "https://teacher.example";
let base = "";
let real = "";
let link = "";
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "marea-state-"));
  real = join(base, "real");
  link = join(base, "link");
  mkdirSync(real);
  symlinkSync(real, link, "junction");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

it("gives every spelling of the same folder one state directory", () => {
  expect(canonicalStateDirectory(base, SERVER, link)).toBe(
    canonicalStateDirectory(base, SERVER, real),
  );
  expect(canonicalStateDirectory(base, SERVER, join(base, "other"))).not.toBe(
    canonicalStateDirectory(base, SERVER, real),
  );
});

it("ignores letter case on Windows only", () => {
  expect(canonicalStateDirectory(base, SERVER, join(base, "Proj"))).not.toBe(
    canonicalStateDirectory(base, SERVER, join(base, "proj")),
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  expect(canonicalStateDirectory(base, SERVER, join(base, "Proj"))).toBe(
    canonicalStateDirectory(base, SERVER, join(base, "proj")),
  );
});

it("moves the directory of the raw spelling to the canonical one so the student keeps their state", () => {
  const legacy = legacyDirectory();
  writeFileSync(join(legacy, "session.json"), "kept");
  const canonical = canonicalStateDirectory(base, SERVER, link);
  expect(canonical).not.toBe(legacy);
  expect(locateStateDirectory(base, SERVER, link)).toBe(canonical);
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(join(canonical, "session.json"), "utf8")).toBe("kept");
});

it("keeps the legacy directory when it cannot be moved and prefers an existing canonical one", () => {
  const legacy = legacyDirectory();
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw new Error("locked");
  });
  const canonical = canonicalStateDirectory(base, SERVER, link);
  expect(locateStateDirectory(base, SERVER, link)).toBe(legacy);
  mkdirSync(canonical, { recursive: true });
  expect(locateStateDirectory(base, SERVER, link)).toBe(canonical);
  expect(existsSync(legacy)).toBe(true);
});

it("uses the canonical directory for a new student or when both spellings agree", () => {
  expect(locateStateDirectory(base, SERVER, link)).toBe(
    canonicalStateDirectory(base, SERVER, link),
  );
  expect(locateStateDirectory(base, SERVER, real)).toBe(
    canonicalStateDirectory(base, SERVER, real),
  );
  expect(existsSync(join(base, "student"))).toBe(false);
});
