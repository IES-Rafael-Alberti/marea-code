import { inspectPrivatePath, securePrivatePath } from "@marea/private-filesystem";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  CanonicalRunEventSchema,
  ClientSessionIdSchema,
  CloseRunReasonSchema,
  ApprovalIdSchema,
  EffectIdSchema,
  IdempotencyKeySchema,
  MessageIdSchema,
  RequestIdSchema,
  RunIdSchema,
  RunTokenSchema,
  SessionTokenSchema,
  Sha256DigestSchema,
  SnapshotIdSchema,
  STARTUP_MESSAGE_ID,
  StudentRunSnapshotSchema,
} from "@marea/protocol";
import * as z from "zod";

import {
  CURRENT_STUDENT_STATE_VERSION,
  type CredentialStore,
  type LegacyValue,
  type StudentState,
  type StudentStateStore,
} from "./contracts.js";

const MAX_FILE_BYTES = 1_048_576;
const MAX_COLLECTION_SIZE = 4_096;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const CredentialFileSchema = z.object({ token: SessionTokenSchema }).strict().readonly();
const LegacyValueSchema: z.ZodType<LegacyValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number(),
    z.string(),
    z.array(LegacyValueSchema),
    z.record(z.string(), LegacyValueSchema),
  ]),
);
const LegacyDataSchema = z.record(z.string(), LegacyValueSchema).readonly();

function hasUniqueValues<T>(values: readonly T[], select: (value: T) => unknown): boolean {
  return new Set(values.map(select)).size === values.length;
}

const StoredOpenIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("new") })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("resume") })
    .strict()
    .readonly(),
]);

const WorkspaceWriteSchema = z
  .object({
    digest: Sha256DigestSchema,
    operation: z.enum(["created", "updated"]),
    path: z.string().min(1).max(512),
  })
  .strict()
  .readonly();

const StoredEffectSchema = z
  .object({ effectId: EffectIdSchema, result: WorkspaceWriteSchema })
  .strict()
  .readonly();

const StoredEffectsSchema = z
  .array(StoredEffectSchema)
  .max(MAX_COLLECTION_SIZE)
  .refine((effects) => hasUniqueValues(effects, (effect) => effect.effectId))
  .readonly();

const StoredApprovalSchema = z
  .object({
    approvalId: ApprovalIdSchema,
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().max(2048).optional(),
  })
  .strict()
  .readonly();

const StoredApprovalsSchema = z
  .array(StoredApprovalSchema)
  .max(MAX_COLLECTION_SIZE)
  .refine((approvals) => hasUniqueValues(approvals, (approval) => approval.approvalId))
  .readonly();

const StoredPendingApprovalSchema = z
  .object({
    approvalId: ApprovalIdSchema,
    content: z.string().max(65_536),
    effectId: EffectIdSchema,
    messageId: MessageIdSchema,
    path: z.string().min(1).max(512),
    summary: z.string().min(1).max(2_048),
  })
  .strict()
  .readonly();

const StoredPendingApprovalsSchema = z
  .array(StoredPendingApprovalSchema)
  .max(MAX_COLLECTION_SIZE)
  .refine((approvals) => hasUniqueValues(approvals, (approval) => approval.approvalId))
  .readonly();

const StoredEventSchema = z
  .object({ key: z.string().min(1).max(256), value: CanonicalRunEventSchema })
  .strict()
  .readonly();

const StoredEventsSchema = z
  .array(StoredEventSchema)
  .max(MAX_COLLECTION_SIZE)
  .refine(
    (events) =>
      hasUniqueValues(events, (event) => event.key) &&
      hasUniqueValues(events, (event) => event.value.sequence),
  )
  .readonly();

const StoredFailureSchema = z
  .object({
    code: z.string().max(64).optional(),
    detail: z.string().max(1024),
    hasPrefix: z.boolean(),
    kind: z.enum([
      "provider-interrupted",
      "request-failed",
      "session-unavailable",
      "unexpected",
      "deadline-exceeded",
      "budget-exhausted",
      "concurrency-limited",
      "recovery-pending",
    ]),
    recoverable: z.boolean(),
    retryable: z.boolean(),
  })
  .strict()
  .readonly();

const StoredTurnSchema = z
  .object({
    lastFailure: StoredFailureSchema.optional(),
    kind: z.literal("startup").optional(),
    messageId: MessageIdSchema,
    state: z.enum(["started", "completed", "cancelled"]),
    studentText: z.string().max(65_536).optional(),
    text: z.string().max(65_536).optional(),
  })
  .strict()
  .refine(
    (turn) =>
      turn.kind !== "startup" ||
      (turn.messageId === STARTUP_MESSAGE_ID && turn.studentText === undefined),
    "An internal startup must use its reserved identity without student input.",
  )
  .readonly();

const StoredTurnsSchema = z
  .array(StoredTurnSchema)
  .max(MAX_COLLECTION_SIZE)
  .refine((turns) => hasUniqueValues(turns, (turn) => turn.messageId))
  .readonly();

const StoredRunSchema = z
  .object({
    clientSessionId: ClientSessionIdSchema,
    closeReason: CloseRunReasonSchema.nullable(),
    closeRequestId: RequestIdSchema.nullable(),
    approvals: StoredApprovalsSchema,
    effects: StoredEffectsSchema,
    eventKeys: z
      .array(z.string().min(1).max(256))
      .max(MAX_COLLECTION_SIZE)
      .refine((keys) => hasUniqueValues(keys, (key) => key))
      .readonly(),
    idempotencyKey: IdempotencyKeySchema,
    legacy: LegacyDataSchema.optional(),
    leaseExpiresAt: z.iso.datetime().nullable().optional().default(null),
    leaseIssuedAt: z.iso.datetime().nullable().optional().default(null),
    nextSequence: z.number().int().positive(),
    openIntent: StoredOpenIntentSchema,
    outbox: StoredEventsSchema,
    pendingApprovals: StoredPendingApprovalsSchema.optional().default([]),
    pendingDelivery: z
      .object({ events: StoredEventsSchema })
      .strict()
      .readonly()
      .nullable()
      .optional()
      .default(null),
    phase: z.enum(["opening", "active", "closing", "closed"]),
    projectDisplayName: z.string().trim().min(1).max(120),
    runId: RunIdSchema.nullable(),
    runToken: RunTokenSchema.nullable(),
    snapshot: StudentRunSnapshotSchema.nullable(),
    snapshotId: SnapshotIdSchema.nullable(),
    turns: StoredTurnsSchema,
  })
  .strict()
  .readonly();

const StudentStateSchema = z
  .object({
    legacy: LegacyDataSchema.optional(),
    run: StoredRunSchema.nullable(),
    version: z.literal(CURRENT_STUDENT_STATE_VERSION),
  })
  .strict()
  .readonly();

export interface FileStudentStoresOptions {
  readonly projectRoot: string;
  readonly stateDirectory: string;
}

export interface FileStudentStores {
  readonly credentials: CredentialStore;
  readonly state: StudentStateStore;
}

export interface PrivateFileHandle {
  close(): Promise<void>;
  sync(): Promise<void>;
  writeFile(value: string, encoding: "utf8"): Promise<void>;
}

export interface AtomicFileOperations {
  chmod(path: string, mode: number): Promise<void>;
  open(path: string, flags: "wx", mode: number): Promise<PrivateFileHandle>;
  remove(path: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}

const NODE_ATOMIC_FILE_OPERATIONS: AtomicFileOperations = Object.freeze({
  chmod: (path: string) => {
    securePrivatePath(path, PRIVATE_FILE_MODE);
    return Promise.resolve();
  },
  open,
  remove: (path: string) => rm(path),
  rename,
});

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function assertOutsideProject(projectRoot: string, stateDirectory: string): void {
  const pathFromProject = relative(projectRoot, stateDirectory);
  const outside =
    pathFromProject === ".." ||
    pathFromProject.startsWith(`..${sep}`) ||
    isAbsolute(pathFromProject);
  if (!outside) {
    throw new Error("Student state must be stored outside the project workspace.");
  }
}

export async function readPrivateTextFile(path: string): Promise<string | null> {
  try {
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) {
      throw new Error("Student state file is unsafe or exceeds its size limit.");
    }
    if (process.platform === "win32" && inspectPrivatePath(path) !== "file") {
      throw new Error("Student state file permissions are unsafe.");
    }
    // Stryker disable next-line StringLiteral: Node treats an empty encoding as a binary read.
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function removeTemporary(path: string, operations: AtomicFileOperations): Promise<void> {
  try {
    await operations.remove(path);
  } catch {
    // A failed write must preserve its original error.
  }
}

export async function writePrivateFileAtomically(
  path: string,
  value: string,
  operations: AtomicFileOperations = NODE_ATOMIC_FILE_OPERATIONS,
): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await operations.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
  try {
    await operations.chmod(temporaryPath, PRIVATE_FILE_MODE);
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } catch (error: unknown) {
    await handle.close();
    await removeTemporary(temporaryPath, operations);
    throw error;
  }
  await handle.close();
  try {
    await operations.rename(temporaryPath, path);
  } catch (error: unknown) {
    await removeTemporary(temporaryPath, operations);
    throw error;
  }
}

class FileCredentialStore implements CredentialStore {
  constructor(private readonly path: string) {}

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  async load(): Promise<z.infer<typeof SessionTokenSchema> | null> {
    const content = await readPrivateTextFile(this.path);
    if (content === null) return null;
    return CredentialFileSchema.parse(parseJson(content)).token;
  }

  async save(token: z.infer<typeof SessionTokenSchema>): Promise<void> {
    await writePrivateFileAtomically(
      this.path,
      JSON.stringify(CredentialFileSchema.parse({ token })),
    );
  }
}

class FileStateStore implements StudentStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StudentState> {
    const content = await readPrivateTextFile(this.path);
    if (content === null) return { run: null, version: CURRENT_STUDENT_STATE_VERSION };
    const raw = parseJson(content);
    const state = parseStudentState(raw);
    if (JSON.stringify(state) !== JSON.stringify(raw)) {
      await writePrivateFileAtomically(this.path, JSON.stringify(StudentStateSchema.parse(state)));
    }
    return state;
  }

  async save(state: StudentState): Promise<void> {
    await writePrivateFileAtomically(this.path, JSON.stringify(StudentStateSchema.parse(state)));
  }
}

export function parseStudentState(value: unknown): StudentState {
  const root = z.record(z.string(), z.unknown()).parse(value);
  if (root.version === 1) {
    return requireExplicitRecovery(
      StudentStateSchema.parse({ ...root, version: CURRENT_STUDENT_STATE_VERSION }),
    );
  }
  if (root.version !== undefined) {
    if (root.version !== CURRENT_STUDENT_STATE_VERSION) {
      throw new Error("The student state version is unsupported.");
    }
    return StudentStateSchema.parse(root);
  }
  if (!("run" in root)) {
    throw new Error("Legacy student state is missing its run field.");
  }
  const rootKnownKeys = new Set(["run"]);
  const rootLegacy = collectLegacy(root, rootKnownKeys);
  const rawRun = root.run;
  const run =
    rawRun === null || rawRun === undefined
      ? null
      : (() => {
          const runRecord = z.record(z.string(), z.unknown()).parse(rawRun);
          const runKnownKeys = new Set([
            "clientSessionId",
            "closeReason",
            "closeRequestId",
            "approvals",
            "effects",
            "eventKeys",
            "idempotencyKey",
            "leaseExpiresAt",
            "leaseIssuedAt",
            "nextSequence",
            "openIntent",
            "outbox",
            "pendingApprovals",
            "pendingDelivery",
            "phase",
            "projectDisplayName",
            "runId",
            "runToken",
            "snapshot",
            "snapshotId",
            "turns",
          ]);
          const legacy = collectLegacy(runRecord, runKnownKeys);
          const known: Record<string, unknown> = Object.fromEntries(
            Object.entries(runRecord).filter(([key]) => runKnownKeys.has(key)),
          );
          assertLegacyTurnsRecoverable(known);
          return {
            ...known,
            ...(Object.keys(legacy).length === 0 ? {} : { legacy }),
          };
        })();
  const migrated = {
    run,
    version: CURRENT_STUDENT_STATE_VERSION,
    ...(Object.keys(rootLegacy).length === 0 ? {} : { legacy: rootLegacy }),
  };
  return requireExplicitRecovery(StudentStateSchema.parse(migrated));
}

function requireExplicitRecovery(state: StudentState): StudentState {
  if (state.run === null) return state;
  return {
    ...state,
    run: {
      ...state.run,
      turns: state.run.turns.map((turn) =>
        turn.state !== "started"
          ? turn
          : {
              ...turn,
              lastFailure: {
                code: "legacy-pending",
                detail: "Resume this saved turn explicitly to continue.",
                hasPrefix: (turn.text ?? "") !== "",
                kind: "recovery-pending",
                recoverable: true,
                retryable: true,
              },
            },
      ),
    },
  };
}

function assertLegacyTurnsRecoverable(run: Readonly<Record<string, unknown>>): void {
  const turns = StoredTurnsSchema.parse(run.turns);
  const pendingApprovals = StoredPendingApprovalsSchema.parse(run.pendingApprovals ?? []);
  const resumableMessageIds = new Set(pendingApprovals.map((approval) => approval.messageId));
  for (const turn of turns) {
    if (turn.state !== "started") continue;
    if (turn.studentText === undefined || !resumableMessageIds.has(turn.messageId)) {
      throw new Error("Legacy student state contains an ambiguous unfinished turn.");
    }
  }
}

function collectLegacy(
  record: Readonly<Record<string, unknown>>,
  knownKeys: ReadonlySet<string>,
): Record<string, LegacyValue> {
  const previous = record.legacy === undefined ? {} : LegacyDataSchema.parse(record.legacy);
  const unknown = LegacyDataSchema.parse(
    Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "legacy" && !knownKeys.has(key)),
    ),
  );
  return { ...previous, ...unknown };
}

export async function createFileStudentStores(
  options: FileStudentStoresOptions,
): Promise<FileStudentStores> {
  const requestedProjectRoot = resolve(options.projectRoot);
  const requestedStateDirectory = resolve(options.stateDirectory);
  assertOutsideProject(requestedProjectRoot, requestedStateDirectory);
  const projectRoot = await realpath(requestedProjectRoot);
  await mkdir(requestedStateDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stateDirectory = await realpath(requestedStateDirectory);
  assertOutsideProject(projectRoot, stateDirectory);
  securePrivatePath(stateDirectory, PRIVATE_DIRECTORY_MODE);
  return Object.freeze({
    credentials: new FileCredentialStore(join(stateDirectory, "credential.json")),
    state: new FileStateStore(join(stateDirectory, "session.json")),
  });
}
