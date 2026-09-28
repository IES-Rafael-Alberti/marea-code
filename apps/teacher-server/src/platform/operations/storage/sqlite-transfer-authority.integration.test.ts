import { Sha256DigestSchema } from "@marea/protocol";
import { openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupOperationsInstallations,
  operationsInstallation,
} from "../../operations-cli/operations.fixture.js";
import { AuthorityLineageSchema } from "../schemas.js";
import { parseStorageConfiguration } from "./configuration.js";
import { createSqliteDeletionIndex } from "./sqlite-deletion-index.js";
import { readConsistentInspection } from "./sqlite-deletion-index-inspection.js";
import { adoptTransferredIndex, transitionTransferAuthority } from "./sqlite-transfer-authority.js";

vi.mock("bun:sqlite", () => import("../../operator-cli/bun-sqlite.fixture.js"));

afterEach(cleanupOperationsInstallations);

const STALE = { code: "stale-authority", message: "Deletion authority is not transferable." };

/** The error a refused transition throws, compared by code and message. */
function refusal(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("The transition was not refused.");
}

async function activatedIndex() {
  const f = operationsInstallation();
  expect(await f.run("deletion", "activate")).toMatchObject({ code: 0 });
  const configuration = parseStorageConfiguration({
    installationRoot: f.root,
    databasePath: f.config.databasePath,
    indexPath: f.config.indexPath,
    authorityLineage: f.config.authorityLineage,
    rootId: f.config.rootId,
    databaseLineage: f.config.databaseLineage,
  });
  const file = openSqliteDatabaseFile({ databasePath: f.config.indexPath });
  return { f, configuration, file };
}

describe("transfer authority transitions", () => {
  it("changes state only from an allowed consistent state at the expected generation", async () => {
    const { configuration, file, f } = await activatedIndex();
    try {
      const move = (
        from: readonly ("active" | "transfer-prepared" | "retired")[],
        to: "active" | "transfer-prepared" | "retired",
        generation = 0,
      ) => transitionTransferAuthority(file.database, configuration, { from, to, generation });
      expect(refusal(() => move(["active"], "transfer-prepared", 1))).toMatchObject(STALE);
      expect(refusal(() => move(["retired"], "transfer-prepared"))).toMatchObject(STALE);
      expect(move(["active"], "transfer-prepared")).toMatchObject({ state: "transfer-prepared" });
      expect(move(["active"], "transfer-prepared")).toMatchObject({ state: "transfer-prepared" });
      expect(move(["transfer-prepared"], "active")).toMatchObject({
        state: "active",
        generation: 0,
      });

      await createSqliteDeletionIndex(file.database, configuration).prepare({
        operationId: "operation:pending",
        authorityLineage: AuthorityLineageSchema.parse(f.config.authorityLineage),
        expectedIndexGeneration: 0,
        targets: [f.runNode("run:closed")],
        artifactDigest: Sha256DigestSchema.parse(`sha256:${"b".repeat(64)}`),
      });
      expect(refusal(() => move(["active"], "transfer-prepared"))).toMatchObject(STALE);
      expect(readConsistentInspection(file.database, configuration).state).toBe("active");
    } finally {
      file.close();
    }
  });

  it("adopts only a quiesced copy of the same lineage under a different root", async () => {
    const { configuration, file } = await activatedIndex();
    try {
      const destination = parseStorageConfiguration({
        ...configuration,
        rootId: "root:destination",
      });
      expect(
        refusal(() => adoptTransferredIndex(file.database, configuration, destination, 0)),
      ).toMatchObject(STALE);
      transitionTransferAuthority(file.database, configuration, {
        from: ["active"],
        to: "transfer-prepared",
        generation: 0,
      });
      for (const incompatible of [
        { ...destination, authorityLineage: "lineage:other" },
        { ...destination, databaseLineage: `sha256:${"f".repeat(64)}` },
        configuration,
      ])
        expect(
          refusal(() =>
            adoptTransferredIndex(
              file.database,
              configuration,
              parseStorageConfiguration(incompatible),
              0,
            ),
          ),
        ).toMatchObject(STALE);
      expect(
        refusal(() => adoptTransferredIndex(file.database, configuration, destination, 1)),
      ).toMatchObject(STALE);
      expect(adoptTransferredIndex(file.database, configuration, destination, 0)).toMatchObject({
        rootId: "root:destination",
        state: "transfer-prepared",
        generation: 0,
      });
    } finally {
      file.close();
    }
  });

  it("never adopts a copy that carries a pending deletion", async () => {
    const { configuration, file, f } = await activatedIndex();
    try {
      await createSqliteDeletionIndex(file.database, configuration).prepare({
        operationId: "operation:pending",
        authorityLineage: AuthorityLineageSchema.parse(f.config.authorityLineage),
        expectedIndexGeneration: 0,
        targets: [f.runNode("run:closed")],
        artifactDigest: Sha256DigestSchema.parse(`sha256:${"b".repeat(64)}`),
      });
      file.database.execute("UPDATE marea_deletion_index_meta SET state = 'transfer-prepared'");
      const destination = parseStorageConfiguration({
        ...configuration,
        rootId: "root:destination",
      });
      expect(
        refusal(() => adoptTransferredIndex(file.database, configuration, destination, 0)),
      ).toMatchObject(STALE);
    } finally {
      file.close();
    }
  });
});
