import { createProfileMigrationCatalog } from "@marea/sqlite-storage";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  openSqliteDatabaseFile,
  type SqliteApplicationDatabase,
  type SqliteStorage,
} from "@marea/sqlite-storage";
import { z } from "zod";

import { TeacherDomainError } from "../../identity/errors.js";
import {
  authorityCheckpointDigest,
  copiedFileDigest,
  transitionTransfer,
  type TransferEvent,
} from "../operations/authority.js";
import { OperationsBoundaryError } from "../operations/canonical-encoder.js";
import { readVerifiedBundle } from "../operations/retention/retention-backups.boundary.js";
import {
  AuthorityCheckpointSchema,
  ManifestSha256Schema,
  TransferHandoffSchema,
  type AuthorityCheckpoint,
  type TransferHandoff,
} from "../operations/schemas.js";
import {
  parseStorageConfiguration,
  type StorageConfiguration,
} from "../operations/storage/configuration.js";
import { readConsistentInspection } from "../operations/storage/sqlite-deletion-index-inspection.js";
import {
  adoptTransferredIndex,
  transitionTransferAuthority,
} from "../operations/storage/sqlite-transfer-authority.js";
import {
  createRecoveryBundle,
  restoreRecoveryBundle,
} from "../recovery/recovery-bundle-service.js";
import type { OperationsConfig } from "./operations-config.js";
import { transferContinuationSchema, type TransferContinuation } from "./transfer-schemas.js";

function recordSchema() {
  return z
    .object({
      format: z.literal("marea-transfer:1"),
      sourceInstallation: z.string().min(1),
      destinationInstallation: z.string().min(1),
      bundleName: z.string().min(1),
      // A recorded handoff always carries the source checkpoint it was prepared from.
      handoff: TransferHandoffSchema.extend({ authorityCheckpoint: AuthorityCheckpointSchema }),
    })
    .strict();
}
type TransferRecord = z.infer<ReturnType<typeof recordSchema>>;

/**
 * Durable points a transfer crosses, in order. The observer runs after each persisted record and
 * after each committed index change that its record does not show yet.
 */
export type TransferStep =
  | "prepared"
  | "source-quiesced"
  | "destination-adopted"
  | "copied"
  | "source-retirement-committed"
  | "source-retired"
  | "destination-activation-committed"
  | "destination-active"
  | "abort-destination-retired"
  | "abort-source-reactivated"
  | "aborted";

export interface TransferRoot {
  readonly installationRoot: string;
  readonly config: OperationsConfig;
}

export interface TransferSummary {
  readonly handoffId: string;
  readonly state: TransferHandoff["state"];
  readonly destinationState: TransferHandoff["destinationState"];
  readonly indexGeneration: number;
  readonly authorityCheckpointDigest: string;
}

function conflict(): TeacherDomainError {
  return new TeacherDomainError("request.conflict");
}

function uncertain(): OperationsBoundaryError {
  return new OperationsBoundaryError("uncertain", "The transfer evidence is not valid.");
}

function storageOf(root: TransferRoot): StorageConfiguration {
  return parseStorageConfiguration({
    installationRoot: root.installationRoot,
    databasePath: root.config.databasePath,
    indexPath: root.config.indexPath,
    authorityLineage: root.config.authorityLineage,
    rootId: root.config.rootId,
    databaseLineage: root.config.databaseLineage,
  });
}

function recordPath(config: OperationsConfig): string {
  return join(dirname(config.indexPath), "transfer-handoff.json");
}

function readRecord(config: OperationsConfig): TransferRecord | undefined {
  const path = recordPath(config);
  return existsSync(path)
    ? recordSchema().parse(JSON.parse(new TextDecoder().decode(readFileSync(path))))
    : undefined;
}

/** The destination recorded by a source installation's transfer, if any. */
export function recordedTransferDestination(config: OperationsConfig): string | undefined {
  return readRecord(config)?.destinationInstallation;
}

function writeRecord(config: OperationsConfig, record: TransferRecord): void {
  const path = recordPath(config);
  const staged = `${path}.${randomUUID()}.staged`;
  writeFileSync(staged, JSON.stringify(recordSchema().parse(record)), { mode: 0o600 });
  renameSync(staged, path);
}

function withIndex<T>(path: string, operation: (database: SqliteApplicationDatabase) => T): T {
  const file = openSqliteDatabaseFile({ databasePath: path });
  try {
    return operation(file.database);
  } finally {
    file.close();
  }
}

function removeDatabaseFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    rmSync(`${path}${suffix}`, { force: true });
}

/**
 * Two-root transfer of an installation's database and deletion authority. Both installations are
 * exclusively owned by the caller. At every durable boundary at most one root is active: the
 * source is quiesced before copying, retired before the destination activates, and an interrupted
 * transfer continues only from its exact persisted handoff.
 */
export function createInstallationTransfer(options: {
  readonly source: TransferRoot & {
    readonly storage: () => SqliteStorage;
    readonly indexDatabase: () => SqliteApplicationDatabase;
  };
  readonly destination: TransferRoot;
  readonly durable?: ((step: TransferStep) => void) | undefined;
}) {
  const { source, destination } = options;
  const observe = (step: TransferStep) => {
    options.durable?.(step);
  };
  const sourceStorage = storageOf(source);
  const destinationStorage = storageOf(destination);
  const bundlePath = (record: TransferRecord) =>
    join(destination.config.backupRoot, record.bundleName);
  // The destination records a handoff only once it has received a recorded copy.
  const persist = (record: TransferRecord, step: TransferStep, destinationToo = true) => {
    writeRecord(source.config, record);
    if (destinationToo) writeRecord(destination.config, record);
    observe(step);
    return record;
  };
  const advanced = (
    record: TransferRecord,
    event: TransferEvent,
    extra: Partial<TransferHandoff>,
  ) => {
    const transition = transitionTransfer(record.handoff, event);
    if (!transition.accepted) throw uncertain();
    return {
      ...record,
      handoff: recordSchema().shape.handoff.parse({
        ...record.handoff,
        ...extra,
        state: transition.state,
        destinationState: transition.destinationState,
      }),
    };
  };
  const stateTargets = () =>
    source.config.stateFiles.map((file) => join(destination.installationRoot, file));
  /** Removes what the transfer wrote to the destination; the index and bundle only when asked. */
  const removeCopy = (
    record: TransferRecord,
    remove: { readonly index: boolean; readonly bundle: boolean },
  ) => {
    removeDatabaseFiles(destination.config.databasePath);
    for (const target of stateTargets()) rmSync(target, { force: true });
    if (remove.index) removeDatabaseFiles(destination.config.indexPath);
    // A repeated abort after an interruption finds the bundle already removed.
    if (remove.bundle) rmSync(bundlePath(record), { recursive: true, force: true });
  };

  const copy = (record: TransferRecord, fresh: boolean): TransferRecord => {
    const generation = record.handoff.expectedIndexGeneration;
    // A bundle prepared before an interruption may miss later writes to a still-active source:
    // that transfer is aborted and started again instead of continued.
    if (
      !fresh &&
      readConsistentInspection(options.source.indexDatabase(), sourceStorage).state === "active"
    )
      throw conflict();
    transitionTransferAuthority(options.source.indexDatabase(), sourceStorage, {
      from: ["active"],
      to: "transfer-prepared",
      generation,
    });
    observe("source-quiesced");
    // Until the copy is recorded the destination never held authority, so partial copies go.
    removeCopy(record, { index: true, bundle: false });
    const bundle = readVerifiedBundle(bundlePath(record), destination.config.limits);
    const staging = join(dirname(destination.config.databasePath), `.transfer-${randomUUID()}`);
    restoreRecoveryBundle(
      {
        destinationRoot: staging,
        path: bundlePath(record),
        schema:
          bundle.manifest.release.schemaVersion === createProfileMigrationCatalog().length
            ? "dashboard-profiles"
            : "retention-audit",
      },
      bundle.manifest.release,
      destination.config.limits,
    ).close();
    try {
      renameSync(join(staging, "database.sqlite"), destination.config.databasePath);
      for (const file of bundle.manifest.files) {
        const target = join(destination.installationRoot, file.path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        renameSync(join(staging, file.path), target);
      }
    } finally {
      rmSync(staging, { recursive: true });
    }
    options.source.indexDatabase().execute("VACUUM INTO ?1", [destination.config.indexPath]);
    chmodSync(destination.config.indexPath, 0o600);
    withIndex(destination.config.indexPath, (database) =>
      adoptTransferredIndex(database, sourceStorage, destinationStorage, generation),
    );
    observe("destination-adopted");
    const copiedBytes = new Uint8Array(readFileSync(join(bundlePath(record), "database.sqlite")));
    return persist(advanced(record, { type: "copy-complete", copiedBytes }, {}), "copied");
  };

  const retire = (record: TransferRecord): TransferRecord => {
    const { handoff } = record;
    const checkpoint = handoff.authorityCheckpoint;
    const evidence = {
      ...checkpoint,
      checkpointDigest: handoff.authorityCheckpointDigest,
      handoffId: handoff.handoffId,
      copiedFileDigest: handoff.copiedFileDigest,
      state: "retired" as const,
    };
    const next = advanced(
      record,
      { type: "source-retired", evidence },
      {
        sourceRetirementEvidence: evidence,
      },
    );
    // A copied destination that is missing or no longer prepared (an interrupted abort retired it)
    // is never activated by continuing.
    if (
      !existsSync(destination.config.indexPath) ||
      withIndex(destination.config.indexPath, (database) =>
        readConsistentInspection(database, destinationStorage),
      ).state !== "transfer-prepared"
    )
      throw uncertain();
    transitionTransferAuthority(options.source.indexDatabase(), sourceStorage, {
      from: ["transfer-prepared"],
      to: "retired",
      generation: handoff.expectedIndexGeneration,
    });
    observe("source-retirement-committed");
    return persist(next, "source-retired");
  };

  const activate = (record: TransferRecord): TransferRecord => {
    const { handoff } = record;
    const checkpoint = handoff.authorityCheckpoint;
    const destinationCheckpoint = { ...checkpoint, rootId: handoff.destinationRoot };
    const next = advanced(
      record,
      { type: "destination-activate", destinationCheckpoint },
      {
        destinationCheckpoint,
      },
    );
    if (readConsistentInspection(options.source.indexDatabase(), sourceStorage).state !== "retired")
      throw uncertain();
    withIndex(destination.config.indexPath, (database) =>
      transitionTransferAuthority(database, destinationStorage, {
        from: ["transfer-prepared"],
        to: "active",
        generation: handoff.expectedIndexGeneration,
      }),
    );
    observe("destination-activation-committed");
    return persist(next, "destination-active");
  };

  const advance = (initial: TransferRecord, fresh: boolean): TransferSummary => {
    let record = initial;
    if (record.handoff.state === "prepared") record = copy(record, fresh);
    if (record.handoff.state === "copied") record = retire(record);
    if (record.handoff.state === "source-retired") record = activate(record);
    return summary(record);
  };

  const summary = (record: TransferRecord): TransferSummary => ({
    handoffId: record.handoff.handoffId,
    state: record.handoff.state,
    destinationState: record.handoff.destinationState,
    indexGeneration: record.handoff.expectedIndexGeneration,
    authorityCheckpointDigest: record.handoff.authorityCheckpointDigest,
  });

  const validatePair = () => {
    if (
      source.config.authorityLineage !== destination.config.authorityLineage ||
      source.config.databaseLineage !== destination.config.databaseLineage ||
      source.config.rootId === destination.config.rootId
    )
      throw conflict();
  };

  return Object.freeze({
    start(handoffId: string): TransferSummary {
      validatePair();
      const existing = readRecord(source.config);
      if (
        (existing !== undefined && existing.handoff.state !== "aborted") ||
        readRecord(destination.config) !== undefined ||
        existsSync(destination.config.databasePath) ||
        existsSync(destination.config.indexPath) ||
        stateTargets().some((target) => existsSync(target))
      )
        throw conflict();
      const inspection = readConsistentInspection(options.source.indexDatabase(), sourceStorage);
      if (inspection.state !== "active" || inspection.pendingCheckpoint !== null) throw conflict();
      // One bundle name per source root, so an unrecorded bundle of an interrupted start is replaced.
      const bundleName = `transfer-${createHash("sha256").update(source.config.rootId).digest("hex").slice(0, 16)}`;
      const storage = options.source.storage();
      rmSync(join(destination.config.backupRoot, bundleName), { recursive: true, force: true });
      const bundle = createRecoveryBundle(join(destination.config.backupRoot, bundleName), {
        release: { id: source.config.releaseId, schemaVersion: storage.schema.version },
        createBackup: storage,
        sourceRoot: source.installationRoot,
        files: source.config.stateFiles,
        limits: source.config.limits,
        createExclusive: (operation) => operation(),
      });
      const verified = readVerifiedBundle(bundle.path, destination.config.limits);
      const checkpoint: AuthorityCheckpoint = {
        authorityLineage: inspection.authorityLineage,
        rootId: inspection.rootId,
        indexGeneration: inspection.generation,
        databaseLineage: inspection.databaseLineage,
        bundleManifestDigest: ManifestSha256Schema.parse(verified.target.key.manifestDigest),
      };
      const record: TransferRecord = {
        format: "marea-transfer:1",
        sourceInstallation: source.installationRoot,
        destinationInstallation: destination.installationRoot,
        bundleName,
        handoff: recordSchema().shape.handoff.parse({
          handoffId,
          authorityLineage: checkpoint.authorityLineage,
          sourceRoot: source.config.rootId,
          destinationRoot: destination.config.rootId,
          expectedIndexGeneration: checkpoint.indexGeneration,
          authorityCheckpoint: checkpoint,
          authorityCheckpointDigest: authorityCheckpointDigest(checkpoint),
          copiedFileDigest: copiedFileDigest(
            new Uint8Array(readFileSync(join(bundle.path, "database.sqlite"))),
          ),
          destinationState: "inactive",
          state: "prepared",
        }),
      };
      return advance(persist(record, "prepared", false), true);
    },

    continue(input: TransferContinuation): TransferSummary {
      const request = transferContinuationSchema().parse(input);
      const record = readRecord(source.config);
      if (record === undefined) throw conflict();
      if (
        record.handoff.handoffId !== request.handoffId ||
        record.handoff.authorityLineage !== request.authorityLineage ||
        record.handoff.expectedIndexGeneration !== request.expectedIndexGeneration ||
        record.handoff.authorityCheckpointDigest !== request.indexDigest ||
        record.handoff.sourceRoot !== request.sourceRoot ||
        record.handoff.destinationRoot !== request.destinationRoot ||
        record.handoff.state === "aborted"
      )
        throw conflict();
      return advance(record, false);
    },

    abort(handoffId: string): TransferSummary {
      const record = readRecord(source.config);
      if (record?.handoff.handoffId !== handoffId) throw conflict();
      if (record.handoff.state === "aborted") return summary(record);
      const next = advanced(record, { type: "abort" }, {});
      // The record may lag behind a committed retirement of the source. Only a source that is
      // still quiesced, or already reactivated by an interrupted abort, can be undone; anything
      // else is left untouched so that continuing can still finish the move.
      const sourceState = readConsistentInspection(
        options.source.indexDatabase(),
        sourceStorage,
      ).state;
      if (sourceState !== "transfer-prepared" && sourceState !== "active") throw uncertain();
      const generation = record.handoff.expectedIndexGeneration;
      // A recorded copy is retired, never removed, so the destination can never be started again;
      // before that record the destination holds nothing but a partial copy.
      const copied = record.handoff.state === "copied";
      if (copied) {
        withIndex(destination.config.indexPath, (database) =>
          transitionTransferAuthority(database, destinationStorage, {
            from: ["transfer-prepared"],
            to: "retired",
            generation,
          }),
        );
        observe("abort-destination-retired");
      }
      removeCopy(record, { index: !copied, bundle: true });
      transitionTransferAuthority(options.source.indexDatabase(), sourceStorage, {
        from: ["transfer-prepared"],
        to: "active",
        generation,
      });
      observe("abort-source-reactivated");
      return summary(persist(next, "aborted", copied));
    },

    inspect(): TransferSummary {
      const record = readRecord(source.config);
      if (record === undefined) throw conflict();
      return summary(record);
    },
  });
}
