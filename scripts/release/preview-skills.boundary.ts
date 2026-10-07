import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory } from "./install.boundary.js";

/** Add the shipped teaching example without replacing an installation's existing skill. */
export function installExampleSkill(installation: string, release: string): void {
  const parent = join(installation, "core", "didactic");
  privateDirectory(parent);
  const destination = join(parent, "testing");
  if (existsSync(destination)) {
    privateDirectory(destination);
    return;
  }
  const source = readFileSync(join(release, "skills", "didactic", "testing", "SKILL.md"));
  mkdirSync(destination, { mode: 0o700 });
  writeFileSync(join(destination, "SKILL.md"), source, { flag: "wx", mode: 0o600 });
}
