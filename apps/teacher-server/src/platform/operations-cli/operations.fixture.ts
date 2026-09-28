import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sha256DigestSchema } from "@marea/protocol";
import { initializeSqliteStorage, openSqliteDatabaseFile } from "@marea/sqlite-storage";

import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import { nativeOpens } from "../operator-cli/bun-sqlite.fixture.js";
import { PasswordInput } from "../operator-cli/filesystem.fixture.js";
import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { runOperatorCli } from "../operator-cli/cli.js";
import { runNode } from "../operations/retention/retention-runs.js";
import { NOW, seedGovernance, seedRetention } from "../operations/retention/retention.fixture.js";
import { AuthorityLineageSchema, type TargetRef } from "../operations/schemas.js";
import { parseStorageConfiguration } from "../operations/storage/configuration.js";
import { createSqliteDeletionIndex } from "../operations/storage/sqlite-deletion-index.js";
import { operationsCommands } from "./operations-commands.js";
import { composeOperations } from "./operations-main.js";

const created: string[] = [];

export function cleanupOperationsInstallations(): void {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** A private schema-8 installation with synthetic retention data; needs the node-backed `bun:sqlite`. */
export function operationsInstallation() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-operations-")));
  chmodSync(root, 0o700);
  created.push(root);
  for (const directory of ["locks", "config", "work", "backups"])
    mkdirSync(join(root, directory), { mode: 0o700 });
  const databasePath = join(root, "marea.sqlite");
  const storage = initializeSqliteStorage({ databasePath });
  seedRetention(storage.database);
  seedGovernance(storage.database);
  storage.close();
  chmodSync(databasePath, 0o600);
  const config = {
    version: 1,
    databasePath,
    indexPath: join(root, "deletion-index.sqlite"),
    backupRoot: join(root, "backups"),
    authorityLineage: "lineage:operations",
    rootId: "root:operations",
    databaseLineage: `sha256:${"d".repeat(64)}`,
    releaseId: "release:one",
    limits: { fileCount: 4, fileBytes: 16_000_000, totalBytes: 32_000_000 },
    stateFiles: [],
  };
  const configPath = join(root, "config", "operations.json");
  const writeConfig = (value: unknown) => {
    writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
  };
  writeConfig(config);
  const work = (name: string, value: unknown) => {
    const path = join(root, "work", name);
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const run = async (group: string, action: string, ...flags: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runOperatorCli(
      ["--installation", root, group, action, ...flags],
      {
        acquire: acquireInstallation,
        compose: (capability) => composeOperations(capability, () => NOW),
        stdout: (text) => {
          stdout.push(text);
        },
        stderr: (text) => {
          stderr.push(text);
        },
        prompt: () => undefined,
        stdin: new PasswordInput(),
        signals: { on: () => undefined, removeListener: () => undefined },
        now: () => NOW,
      },
      operationsCommands(),
    );
    const output = stdout.join("");
    return {
      code,
      open: nativeOpens.filter((entry) => !entry.closed).length,
      stderr: stderr.join(""),
      summary: (output === "" ? {} : JSON.parse(output)) as Record<string, unknown>,
    };
  };
  const runNodeOf = (runId: string): TargetRef => {
    const database = new NodeSqliteTestDatabase(databasePath);
    try {
      return (runNode(database, runId) as { readonly node: TargetRef }).node;
    } finally {
      database.close();
    }
  };
  return {
    root,
    config,
    writeConfig,
    work,
    run,
    runNode: runNodeOf,
    readWork: (name: string): unknown => JSON.parse(readFileSync(join(root, "work", name), "utf8")),
  };
}

/** Leaves an activated installation with a prepared, uncommitted deletion of a closed run. */
export async function preparePendingDeletion(
  installation: ReturnType<typeof operationsInstallation>,
): Promise<void> {
  const { config, root } = installation;
  const file = openSqliteDatabaseFile({ databasePath: config.indexPath });
  try {
    await createSqliteDeletionIndex(
      file.database,
      parseStorageConfiguration({
        installationRoot: root,
        databasePath: config.databasePath,
        indexPath: config.indexPath,
        authorityLineage: config.authorityLineage,
        rootId: config.rootId,
        databaseLineage: config.databaseLineage,
      }),
    ).prepare({
      operationId: "operation:pending",
      authorityLineage: AuthorityLineageSchema.parse(config.authorityLineage),
      expectedIndexGeneration: 0,
      targets: [installation.runNode("run:closed")],
      artifactDigest: Sha256DigestSchema.parse(`sha256:${"b".repeat(64)}`),
    });
  } finally {
    file.close();
  }
}
