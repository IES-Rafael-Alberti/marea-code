import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeSqliteStorage, openSqliteDatabaseFile } from "@marea/sqlite-storage";

import { TeacherDomainError } from "../../identity/errors.js";
import { acquireInstallation } from "../operator-cli/installation-lock.js";
import { NOW } from "../operations/retention/retention.fixture.js";
import { AuthorityLineageSchema, RootIdSchema } from "../operations/schemas.js";
import { createInstallationTransfer, type TransferStep } from "./installation-transfer.js";
import { createOperationsApplication } from "./operations-application.js";
import { readOperationsConfig } from "./operations-config.js";
import {
  activatedSource,
  cleanupTransferInstallations,
  continuation,
  destinationFor,
  indexState,
  interruptedApplication,
  setIndexState,
} from "./operations-transfer.fixture.js";
import { preparePendingDeletion } from "./operations.fixture.js";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

afterEach(cleanupTransferInstallations);

describe("two-root installation transfer edges", () => {
  it("carries listed state files and refuses to overwrite them at the destination", async () => {
    const source = await activatedSource();
    mkdirSync(join(source.root, "state"), { mode: 0o700 });
    writeFileSync(join(source.root, "state", "marker.json"), '{"marker":true}', { mode: 0o600 });
    source.writeConfig({ ...source.config, stateFiles: ["state/marker.json"] });
    const destination = destinationFor(source, { stateFiles: ["state/marker.json"] });
    expect(await source.run("transfer", "inspect")).toMatchObject({
      code: 0,
      summary: { transfer: null },
    });
    writeFileSync(join(destination.root, "state", "marker.json"), "{}", { mode: 0o600 });
    const start = source.work("files.json", {
      handoffId: "handoff:files",
      destinationInstallation: destination.root,
    });
    expect(await source.run("transfer", "start", "--input", start)).toMatchObject({ code: 4 });
    expect((indexState(source.config.indexPath) as { state: string }).state).toBe("active");
    rmSync(join(destination.root, "state", "marker.json"));
    const interrupted = interruptedApplication(source, "source-quiesced");
    try {
      await expect(
        interrupted.application.transferStart({
          handoffId: "handoff:files",
          destinationInstallation: destination.root,
        }),
      ).rejects.toThrow("interrupted after source-quiesced");
    } finally {
      interrupted.close();
    }
    // Whatever a partial copy left at the destination is replaced by the continuation.
    writeFileSync(join(destination.root, "state", "marker.json"), "{}", { mode: 0o600 });
    writeFileSync(destination.config.databasePath, "partial", { mode: 0o600 });
    writeFileSync(destination.config.indexPath, "partial", { mode: 0o600 });
    expect(
      await source.run(
        "recovery",
        "transfer-continue",
        "--input",
        source.work("files-continue.json", continuation(source)),
      ),
    ).toMatchObject({ code: 0, summary: { state: "destination-active" } });
    expect(readFileSync(join(destination.root, "state", "marker.json"), "utf8")).toBe(
      '{"marker":true}',
    );
  });

  it("never activates the destination unless the source authority is actually retired", async () => {
    const source = await activatedSource();
    const destination = destinationFor(source);
    const interrupted = interruptedApplication(source, "source-retired");
    try {
      await expect(
        interrupted.application.transferStart({
          handoffId: "handoff:reactivated",
          destinationInstallation: destination.root,
        }),
      ).rejects.toThrow("interrupted after source-retired");
    } finally {
      interrupted.close();
    }
    const index = new DatabaseSync(source.config.indexPath);
    try {
      index.prepare("UPDATE marea_deletion_index_meta SET state = 'transfer-prepared'").run();
    } finally {
      index.close();
    }
    expect(
      await source.run(
        "recovery",
        "transfer-continue",
        "--input",
        source.work("reactivated.json", continuation(source)),
      ),
    ).toMatchObject({ code: 6 });
    expect((indexState(destination.config.indexPath) as { state: string }).state).toBe(
      "transfer-prepared",
    );
  });

  it("reports an uncertain outcome when the destination lock cannot be released", async () => {
    const source = await activatedSource();
    const destination = destinationFor(source);
    const owned = acquireInstallation(source.root);
    const application = createOperationsApplication(
      owned.capability,
      readOperationsConfig(source.root),
      () => NOW,
      {
        acquire: (root) => ({ ...acquireInstallation(root), release: () => false }),
        read: readOperationsConfig,
      },
    );
    try {
      await expect(
        application.transferStart({
          handoffId: "handoff:release",
          destinationInstallation: destination.root,
        }),
      ).rejects.toThrow("ownership-uncertain");
    } finally {
      application.close();
      owned.release();
      rmSync(join(destination.root, "locks", "installation.lock"), { force: true });
    }
  });

  it("refuses continuations and aborts that do not match the persisted transfer state", async () => {
    const interruptAt = async (step: TransferStep) => {
      const source = await activatedSource();
      const destination = destinationFor(source);
      const interrupted = interruptedApplication(source, step);
      try {
        await expect(
          interrupted.application.transferStart({
            handoffId: `handoff:${step}`,
            destinationInstallation: destination.root,
          }),
        ).rejects.toThrow(`interrupted after ${step}`);
      } finally {
        interrupted.close();
      }
      const resume = (name: string) =>
        source.run(
          "recovery",
          "transfer-continue",
          "--input",
          source.work(name, continuation(source)),
        );
      return { source, destination, resume };
    };

    const replaced = await interruptAt("copied");
    setIndexState(replaced.destination.config.indexPath, "active");
    expect(await replaced.resume("replaced.json")).toMatchObject({ code: 6 });
    expect((indexState(replaced.source.config.indexPath) as { state: string }).state).toBe(
      "transfer-prepared",
    );

    const halfAborted = await interruptAt("copied");
    setIndexState(halfAborted.destination.config.indexPath, "retired");
    expect(await halfAborted.resume("half.json")).toMatchObject({ code: 6 });

    const early = await interruptAt("source-quiesced");
    expect(
      await early.source.run(
        "transfer",
        "abort",
        "--input",
        early.source.work("other.json", { handoffId: "handoff:other" }),
      ),
    ).toMatchObject({ code: 4 });
    expect(
      await early.source.run(
        "transfer",
        "abort",
        "--input",
        early.source.work("early.json", { handoffId: "handoff:source-quiesced" }),
      ),
    ).toMatchObject({ code: 0, summary: { state: "aborted" } });
    expect(existsSync(early.destination.config.databasePath)).toBe(false);
    expect((indexState(early.source.config.indexPath) as { state: string }).state).toBe("active");

    const pending = await activatedSource();
    const pendingDestination = destinationFor(pending);
    await preparePendingDeletion(pending);
    expect(
      await pending.run(
        "transfer",
        "start",
        "--input",
        pending.work("pending.json", {
          handoffId: "handoff:pending",
          destinationInstallation: pendingDestination.root,
        }),
      ),
    ).toMatchObject({ code: 4 });
    expect(existsSync(join(pending.root, "transfer-handoff.json"))).toBe(false);
    expect(readdirSync(pendingDestination.config.backupRoot)).toEqual([]);
  });

  it("refuses to continue or inspect a source that has no transfer record", async () => {
    const source = await activatedSource();
    const destination = destinationFor(source);
    const storage = initializeSqliteStorage({
      databasePath: source.config.databasePath,
      schema: "retention-audit",
    });
    const index = openSqliteDatabaseFile({ databasePath: source.config.indexPath });
    try {
      const transfer = createInstallationTransfer({
        source: {
          installationRoot: source.root,
          config: readOperationsConfig(source.root),
          storage: () => storage,
          indexDatabase: () => index.database,
        },
        destination: {
          installationRoot: destination.root,
          config: readOperationsConfig(destination.root),
        },
      });
      const conflict = new TeacherDomainError("request.conflict");
      expect(() => transfer.inspect()).toThrow(conflict);
      expect(() => transfer.abort("handoff:none")).toThrow(conflict);
      expect(() =>
        transfer.continue({
          handoffId: "handoff:none",
          authorityLineage: AuthorityLineageSchema.parse(source.config.authorityLineage),
          expectedIndexGeneration: 0,
          indexDigest: `sha256:${"a".repeat(64)}`,
          sourceRoot: RootIdSchema.parse(source.config.rootId),
          destinationRoot: RootIdSchema.parse("root:destination"),
        }),
      ).toThrow(conflict);
    } finally {
      index.close();
      storage.close();
    }
  });
});
