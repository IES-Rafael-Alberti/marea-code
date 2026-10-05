import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalizeStorageConfiguration, parseStorageConfiguration } from "./configuration.js";

it("canonicalizes the installation root together with its files and remains idempotent", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-storage-alias-")));
  try {
    const physical = join(scratch, "physical");
    const alias = join(scratch, "alias");
    mkdirSync(join(physical, "installation"), { recursive: true });
    symlinkSync(physical, alias, "dir");
    const root = join(alias, "installation");
    writeFileSync(join(root, "database.sqlite"), "");
    const config = canonicalizeStorageConfiguration(
      parseStorageConfiguration({
        installationRoot: root,
        databasePath: join(root, "database.sqlite"),
        indexPath: join(root, "index.sqlite"),
        authorityLineage: "lineage:alias",
        rootId: "root:alias",
        databaseLineage: `sha256:${"a".repeat(64)}`,
      }),
    );
    const canonical = realpathSync.native(root);
    expect(config.installationRoot).toBe(canonical);
    expect(config.databasePath).toBe(join(canonical, "database.sqlite"));
    expect(config.indexPath).toBe(join(canonical, "index.sqlite"));
    expect(canonicalizeStorageConfiguration(config)).toEqual(config);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
