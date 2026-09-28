import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { securePrivatePath } from "@marea/private-filesystem";
import { initializeSqliteStorage } from "@marea/sqlite-storage";
import { syntheticOperatorPolicy } from "../../teaching/configuration/dashboard-module.fixture.js";

function privateRoot(prefix = "marea-cli-"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  securePrivatePath(root, 0o700);
  return root;
}

export function skillMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: Synthetic ${name}\n---\n\nSynthetic ${name} instructions.\n`;
}

/** A complete synthetic schema-8 installation; requires the node-backed `bun:sqlite` test module. */
export function installationFixture(readyClasses: readonly string[] = ["class:ready"]) {
  const root = privateRoot();
  for (const directory of [
    "locks",
    "config",
    "core",
    "core/didactic",
    "core/evaluation",
    "core/evaluation/evaluate",
    "centers",
    "centers/center-a",
    "centers/center-a/didactic",
    "centers/center-a/evaluation",
    "teachers",
    "teachers/teacher-a",
    "teachers/teacher-a/didactic",
    "teachers/teacher-a/evaluation",
    "work",
  ])
    mkdirSync(join(root, directory), { mode: 0o700 });
  writeFileSync(join(root, "core/evaluation/evaluate/SKILL.md"), skillMarkdown("evaluate"), {
    mode: 0o600,
  });
  const databasePath = join(root, "marea.sqlite");
  initializeSqliteStorage({ databasePath }).close();
  securePrivatePath(databasePath, 0o600);
  const operatorPolicyPath = join(root, "policy.json");
  const document = {
    version: 1 as const,
    classes: readyClasses.map((classId) => ({ classId, policy: syntheticOperatorPolicy })),
  };
  writeFileSync(operatorPolicyPath, JSON.stringify(document), { mode: 0o600 });
  const config = {
    version: 1 as const,
    databasePath,
    operatorPolicyPath,
    coreSourcePath: join(root, "core"),
    centers: [{ id: "center:a", root: join(root, "centers/center-a") }],
    teachers: [{ id: "user:teacher", root: join(root, "teachers/teacher-a") }],
    personalOwners: [{ classId: "class:ready", teacherId: "user:teacher" }],
  };
  const configPath = join(root, "config", "operator-cli.json");
  const writeConfig = (value: unknown) => {
    writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
  };
  writeConfig(config);
  const work = (name: string, value: unknown) => {
    const path = join(root, "work", name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  return {
    root,
    databasePath,
    operatorPolicyPath,
    document,
    config,
    configPath,
    writeConfig,
    work,
  };
}
