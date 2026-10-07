import * as filesystem from "node:fs";
vi.mock("node:fs", { spy: true });
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { securePrivatePath } from "@marea/private-filesystem";
import { installExampleSkill } from "./preview-skills.boundary.js";
let root: string;
let source: string;
let destination: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marea-skill-")));
  source = join(root, "release/skills/didactic/testing");
  destination = join(root, "core/didactic/testing");
  for (const path of [source, join(root, "core/didactic")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    securePrivatePath(path, 0o700);
  }
  writeFileSync(join(source, "SKILL.md"), "synthetic testing lesson");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
it("ships a private testing skill and preserves teacher edits on later upgrades", () => {
  const write = vi.spyOn(filesystem, "writeFileSync");
  installExampleSkill(root, join(root, "release"));
  expect(write).toHaveBeenCalledWith(join(destination, "SKILL.md"), expect.any(Buffer), {
    flag: "wx",
    mode: 0o600,
  });
  write.mockRestore();
  const skill = join(destination, "SKILL.md");
  expect(readFileSync(skill, "utf8")).toBe("synthetic testing lesson");
  if (process.platform !== "win32") {
    expect(statSync(skill).mode & 0o777).toBe(0o600);
    expect(statSync(destination).mode & 0o777).toBe(0o700);
  }
  writeFileSync(skill, "teacher's customized lesson");
  installExampleSkill(root, "missing-release-is-not-read");
  expect(readFileSync(skill, "utf8")).toBe("teacher's customized lesson");
});
it("rejects an absent packaged lesson before creating an incomplete skill", () => {
  expect(() => {
    installExampleSkill(root, "missing-release");
  }).toThrow();
  expect(existsSync(destination)).toBe(false);
});
it("refuses an existing redirected skill directory", () => {
  symlinkSync(source, destination, "junction");
  expect(() => {
    installExampleSkill(root, join(root, "release"));
  }).toThrow("canonical directory");
  expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe("synthetic testing lesson");
});

it("refuses a redirected library parent before writing a lesson outside the installation", () => {
  const parent = join(root, "core/didactic");
  rmSync(parent, { recursive: true });
  symlinkSync(source, parent, "junction");
  expect(() => {
    installExampleSkill(root, join(root, "release"));
  }).toThrow("canonical directory");
  expect(existsSync(join(source, "testing"))).toBe(false);
});
