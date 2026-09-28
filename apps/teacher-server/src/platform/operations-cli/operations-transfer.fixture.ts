/** Two-root transfer installations for integration tests; needs the node-backed `bun:sqlite`. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect } from "vitest";

import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { NOW } from "../operations/retention/retention.fixture.js";
import type { TransferStep } from "./installation-transfer.js";
import { createOperationsApplication } from "./operations-application.js";
import { readOperationsConfig } from "./operations-config.js";
import { cleanupOperationsInstallations, operationsInstallation } from "./operations.fixture.js";

const destinations: string[] = [];

export function cleanupTransferInstallations(): void {
  cleanupOperationsInstallations();
  for (const root of destinations.splice(0)) rmSync(root, { recursive: true, force: true });
}

export type Source = ReturnType<typeof operationsInstallation>;

/** An empty private installation configured for the same authority under another root. */
export function destinationFor(source: Source, overrides: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marea-transfer-")));
  chmodSync(root, 0o700);
  destinations.push(root);
  for (const directory of ["locks", "config", "state", "backups"])
    mkdirSync(join(root, directory), { mode: 0o700 });
  const config = {
    ...source.config,
    databasePath: join(root, "marea.sqlite"),
    indexPath: join(root, "state", "deletion-index.sqlite"),
    backupRoot: join(root, "backups"),
    rootId: "root:destination",
    ...overrides,
  };
  writeFileSync(join(root, "config", "operations.json"), JSON.stringify(config), { mode: 0o600 });
  return { root, config };
}

export function indexState(path: string): unknown {
  if (!existsSync(path)) return null;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT root_id, generation, state FROM marea_deletion_index_meta")
      .get();
  } finally {
    database.close();
  }
}

export function record(path: string): { handoff: Record<string, unknown> } {
  return JSON.parse(readFileSync(path, "utf8")) as { handoff: Record<string, unknown> };
}

export function continuation(source: Source) {
  const { handoff } = record(join(source.root, "transfer-handoff.json"));
  return {
    handoffId: handoff.handoffId,
    authorityLineage: handoff.authorityLineage,
    expectedIndexGeneration: handoff.expectedIndexGeneration,
    indexDigest: handoff.authorityCheckpointDigest,
    sourceRoot: handoff.sourceRoot,
    destinationRoot: handoff.destinationRoot,
  };
}

export async function activatedSource(): Promise<Source> {
  const source = operationsInstallation();
  expect(await source.run("deletion", "activate")).toMatchObject({ code: 0 });
  return source;
}

export function interruptedApplication(source: Source, step?: TransferStep) {
  const owned = acquireInstallation(source.root);
  const application = createOperationsApplication(
    owned.capability,
    readOperationsConfig(source.root),
    () => NOW,
    {
      acquire: acquireInstallation,
      read: readOperationsConfig,
      durable: (reached) => {
        if (reached === step) throw new Error(`interrupted after ${reached}`);
      },
    },
  );
  return {
    application,
    close: () => {
      application.close();
      owned.release();
    },
  };
}

export const activeStates = (source: Source, destination: { config: { indexPath: string } }) =>
  [indexState(source.config.indexPath), indexState(destination.config.indexPath)].filter(
    (state) => (state as { state: string } | null)?.state === "active",
  ).length;

export function setIndexState(path: string, state: string): void {
  const database = new DatabaseSync(path);
  try {
    database.prepare("UPDATE marea_deletion_index_meta SET state = ?").run(state);
  } finally {
    database.close();
  }
}
