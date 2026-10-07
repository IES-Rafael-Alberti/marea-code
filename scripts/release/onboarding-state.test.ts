import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
import {
  existingOnboarding,
  ownOnboarding,
  markOnboardingPending,
  onboardingPending,
  onboardingMarker,
} from "./onboarding-state.boundary.js";
let root: string;
const url = "http://127.0.0.1:12345/dashboard/setup.html#token=synthetic";
const path = () => join(root, "onboarding-owner.json");
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "marea-onboarding-state-")));
  fs.chmodSync(root, 0o700);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
it("marks setup privately, never overwrites it and rejects malformed or linked markers", () => {
  expect(onboardingPending(root)).toBe(false);
  markOnboardingPending(root);
  expect(onboardingPending(root)).toBe(true);
  expect(fs.statSync(join(root, onboardingMarker)).mode & 0o777).toBe(0o600);
  expect(() => {
    markOnboardingPending(root);
  }).toThrow();
  fs.writeFileSync(join(root, onboardingMarker), '{"format":2}');
  expect(() => onboardingPending(root)).toThrow();
  fs.rmSync(join(root, onboardingMarker));
  fs.symlinkSync("absent", join(root, onboardingMarker));
  // A non-dangling replacement is never followed.
  fs.writeFileSync(join(root, "target"), "{}", { mode: 0o600 });
  fs.rmSync(join(root, onboardingMarker));
  fs.symlinkSync(join(root, "target"), join(root, onboardingMarker));
  expect(() => onboardingPending(root)).toThrow("Invalid onboarding marker");
});
it("recognizes a live owner, refuses another and removes only its own scratch", () => {
  expect(existingOnboarding(root)).toBeNull();
  const owner = ownOnboarding(root, url);
  expect(existingOnboarding(root)).toBe(url);
  expect(() => ownOnboarding(root, url)).toThrow();
  expect(fs.readdirSync(root).filter((name) => name.startsWith(".onboarding-"))).toHaveLength(1);
  owner.close();
  expect(fs.readdirSync(root)).toEqual([]);
  owner.close();
});
it.each([
  new Error("no permission"),
  Object.assign(new Error(), { code: "EPERM" }),
  "unknown failure",
])("treats uncertain process ownership as live", (error) => {
  const owner = ownOnboarding(root, url);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw error as Error;
  });
  expect(existingOnboarding(root)).toBe(url);
  owner.close();
});
it.each([true, false])("cleans a dead owner's scratch if present: %s", (present) => {
  const owner = ownOnboarding(root, url);
  if (!present) fs.rmSync(owner.stage, { recursive: true });
  fs.mkdirSync(join(root, "installation"));
  fs.writeFileSync(join(root, "installation", "keep"), "data");
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(), { code: "ESRCH" });
  });
  expect(existingOnboarding(root)).toBeNull();
  expect(fs.existsSync(owner.stage)).toBe(false);
  expect(fs.readFileSync(join(root, "installation", "keep"), "utf8")).toBe("data");
  owner.close();
});
it("rejects a replaced owner file and a non-directory scratch", () => {
  const owner = ownOnboarding(root, url);
  fs.renameSync(path(), join(root, "original"));
  fs.symlinkSync(join(root, "original"), path());
  expect(() => existingOnboarding(root)).toThrow("Invalid onboarding owner");
  fs.rmSync(path());
  fs.renameSync(join(root, "original"), path());
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(), { code: "ESRCH" });
  });
  fs.rmSync(owner.stage, { recursive: true });
  fs.writeFileSync(owner.stage, "do not delete", { mode: 0o600 });
  expect(() => existingOnboarding(root)).toThrow("Invalid onboarding scratch directory");
});
it.each([
  "https://127.0.0.1/dashboard/setup.html",
  "http://example.test/dashboard/setup.html",
  "http://127.0.0.1/other",
])("rejects nonlocal setup URLs: %s", (address) => {
  expect(() => ownOnboarding(root, address)).toThrow();
  expect(fs.readdirSync(root)).toEqual([]);
});
it.each(["dev", "ino", "mtimeMs"])("refuses ownership changes detected through %s", (field) => {
  ownOnboarding(root, url);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(), { code: "ESRCH" });
  });
  const lstat = fs.lstatSync;
  let reads = 0;
  vi.spyOn(fs, "lstatSync").mockImplementation((value: fs.PathLike, options?: object) => {
    const stat = lstat(value, options);
    if (value === path() && ++reads === 2)
      return Object.assign(stat, { [field]: stat[field as "dev" | "ino" | "mtimeMs"] + 1 });
    return stat;
  });
  expect(() => existingOnboarding(root)).toThrow("Onboarding ownership changed");
  expect(fs.existsSync(path())).toBe(true);
});
it.each(["dev", "ino"])("close does not remove a replaced owner with changed %s", (field) => {
  const owner = ownOnboarding(root, url);
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((value: fs.PathLike, options?: object) => {
    const stat = lstat(value, options);
    return value === path()
      ? Object.assign(stat, { [field]: stat[field as "dev" | "ino" | "mtimeMs"] + 1 })
      : stat;
  });
  owner.close();
  expect(fs.existsSync(path())).toBe(true);
});
it("reads private records explicitly as UTF-8 and removes the dead owner record", () => {
  const read = vi.spyOn(fs, "readFileSync");
  markOnboardingPending(root);
  onboardingPending(root);
  expect(read).toHaveBeenCalledWith(join(root, onboardingMarker), "utf8");
  ownOnboarding(root, url);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(), { code: "ESRCH" });
  });
  existingOnboarding(root);
  expect(read).toHaveBeenCalledWith(path(), "utf8");
  expect(fs.existsSync(path())).toBe(false);
});
it.each(["prefix.onboarding-abc", ".onboarding-abc/other"])(
  "rejects unsafe scratch names: %s",
  (stage) => {
    fs.writeFileSync(path(), JSON.stringify({ pid: process.pid, stage, url }), { mode: 0o600 });
    expect(() => existingOnboarding(root)).toThrow();
  },
);
