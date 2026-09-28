import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { deserialize, serialize } from "node:v8";

import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  MemorySaver,
  type Checkpoint,
  type CheckpointMetadata,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import * as z from "zod";

import { AgentAdapterError, type AgentEvent } from "./contracts.js";

const MAX_CHECKPOINT_STATE_BYTES = 64 * 1024 * 1024;

const checkpointEntrySchema = z.tuple([
  z.instanceof(Uint8Array),
  z.instanceof(Uint8Array),
  z.union([z.string(), z.undefined()]),
]);
const writeEntrySchema = z.tuple([z.string(), z.string(), z.instanceof(Uint8Array)]);
const checkpointConfigSchema = z.object({
  checkpoint_id: z.string(),
  checkpoint_ns: z.string().optional(),
  thread_id: z.string(),
});
const turnMetadataSchema = z.object({ messageId: z.string() }).loose();
export interface CheckpointTurnRecord {
  readonly state: "pending-approval" | "in-progress" | "completed" | "cancelled";
  readonly events: readonly AgentEvent[];
}

export interface RuntimeCheckpointSaver extends BaseCheckpointSaver {
  findTurn(sessionId: string, messageId: string): CheckpointTurnRecord | null;
  findTurnCheckpoint(sessionId: string, messageId: string): Promise<RunnableConfig | null>;
  findSessionHead(
    sessionId: string,
    isCompleted: (config: RunnableConfig) => Promise<boolean>,
  ): Promise<RunnableConfig | null>;
  recordTurn(sessionId: string, messageId: string, record: CheckpointTurnRecord): Promise<void>;
  cancelTurn(sessionId: string, messageId: string, events: readonly AgentEvent[]): Promise<void>;
}

export interface CheckpointFileOperations {
  readonly close: (descriptor: number) => void;
  readonly flush: (descriptor: number) => void;
  readonly open: (path: string, flags: number, mode?: number) => number;
  readonly remove: (path: string) => void;
  readonly replace: (source: string, destination: string) => void;
  readonly write: (descriptor: number, data: Uint8Array) => void;
}

export function createCheckpointFileOperations(): CheckpointFileOperations {
  return {
    close: closeSync,
    flush: fsyncSync,
    open: (path, flags, mode) => openSync(path, flags, mode),
    remove: unlinkSync,
    replace: renameSync,
    write: (descriptor, data) => {
      writeFileSync(descriptor, data);
    },
  };
}

export class MemoryTurnSaver extends MemorySaver implements RuntimeCheckpointSaver {
  protected readonly turns = new Map<string, CheckpointTurnRecord>();

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    return super.put(config, checkpoint, metadataWithMessageId(config, metadata));
  }

  findTurn(sessionId: string, messageId: string): CheckpointTurnRecord | null {
    return this.turns.get(turnKey(sessionId, messageId)) ?? null;
  }

  async findTurnCheckpoint(sessionId: string, messageId: string): Promise<RunnableConfig | null> {
    for await (const tuple of this.list(
      { configurable: { thread_id: sessionId } },
      { filter: { messageId }, limit: 1 },
    )) {
      return tuple.config;
    }
    return null;
  }

  async findSessionHead(
    sessionId: string,
    isCompleted: (config: RunnableConfig) => Promise<boolean>,
  ): Promise<RunnableConfig | null> {
    for await (const tuple of this.list({ configurable: { thread_id: sessionId } })) {
      if (
        turnMetadataSchema.safeParse(tuple.metadata).success &&
        (await isCompleted(tuple.config))
      ) {
        return tuple.config;
      }
    }
    return null;
  }

  recordTurn(sessionId: string, messageId: string, record: CheckpointTurnRecord): Promise<void> {
    this.turns.set(turnKey(sessionId, messageId), structuredClone(record));
    return Promise.resolve();
  }

  async cancelTurn(
    sessionId: string,
    messageId: string,
    events: readonly AgentEvent[],
  ): Promise<void> {
    await this.removeTurnCheckpoints(sessionId, messageId);
    this.turns.set(turnKey(sessionId, messageId), {
      state: "cancelled",
      events: structuredClone(events),
    });
  }

  private async removeTurnCheckpoints(sessionId: string, messageId: string): Promise<void> {
    const checkpoints: RunnableConfig[] = [];
    for await (const tuple of this.list(
      { configurable: { thread_id: sessionId } },
      { filter: { messageId } },
    )) {
      checkpoints.push(tuple.config);
    }
    for (const config of checkpoints) this.deleteCheckpoint(config);
  }

  protected exportTurns(): Record<string, CheckpointTurnRecord> {
    return Object.fromEntries(this.turns.entries());
  }

  protected importTurns(turns: Record<string, CheckpointTurnRecord>): void {
    for (const [key, record] of Object.entries(turns)) this.turns.set(key, record);
  }

  private deleteCheckpoint(config: RunnableConfig): void {
    const parsed = checkpointConfigSchema.safeParse(config.configurable);
    if (!parsed.success) {
      throw invalidCheckpointState();
    }
    const threadId = parsed.data.thread_id;
    const checkpointNamespace = parsed.data.checkpoint_ns ?? "";
    const checkpointId = parsed.data.checkpoint_id;
    const thread = this.storage[threadId];
    if (thread === undefined) throw invalidCheckpointState();
    const namespace = thread[checkpointNamespace];
    if (namespace === undefined) throw invalidCheckpointState();
    Reflect.deleteProperty(namespace, checkpointId);
    Reflect.deleteProperty(
      this.writes,
      JSON.stringify([threadId, checkpointNamespace, checkpointId]),
    );
    if (Object.keys(namespace).length === 0) {
      Reflect.deleteProperty(thread, checkpointNamespace);
    }
    if (Object.keys(thread).length === 0) {
      Reflect.deleteProperty(this.storage, threadId);
    }
  }
}

export class DurableFileSaver extends MemoryTurnSaver {
  private readonly statePath: string;
  private readonly fileOperations: CheckpointFileOperations;
  private pendingPersist: Promise<void> = Promise.resolve();

  constructor(
    statePath: string,
    fileOperations: CheckpointFileOperations = createCheckpointFileOperations(),
  ) {
    super();
    this.statePath = statePath;
    this.fileOperations = fileOperations;
    this.load();
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const savedConfig = await super.put(config, checkpoint, metadata);
    await this.persist();
    return savedConfig;
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    await super.putWrites(config, writes, taskId);
    await this.persist();
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    for (const key of this.turns.keys()) {
      if (key.startsWith(`${JSON.stringify(threadId)}\u0000`)) this.turns.delete(key);
    }
    await this.persist();
  }

  override async recordTurn(
    sessionId: string,
    messageId: string,
    record: CheckpointTurnRecord,
  ): Promise<void> {
    await super.recordTurn(sessionId, messageId, record);
    await this.persist();
  }

  override async cancelTurn(
    sessionId: string,
    messageId: string,
    events: readonly AgentEvent[],
  ): Promise<void> {
    await super.cancelTurn(sessionId, messageId, events);
    await this.persist();
  }

  private load(): void {
    if (!existsSync(this.statePath)) {
      return;
    }
    const state = readPersistedState(this.statePath);
    if (state === null) {
      return;
    }
    this.storage = state.storage;
    this.writes = state.writes;
    this.importTurns(state.turns);
  }

  private async persist(): Promise<void> {
    const scheduled = this.pendingPersist.then(() => {
      const serializedState = serialize({
        version: 1,
        storage: this.storage,
        writes: this.writes,
        turns: this.exportTurns(),
      });
      persistCheckpointState(this.statePath, serializedState, this.fileOperations);
    });
    this.pendingPersist = scheduled.catch(() => undefined);
    await scheduled;
  }
}

function persistCheckpointState(
  statePath: string,
  serializedState: Uint8Array,
  operations: CheckpointFileOperations,
): void {
  const temporaryPath = `${statePath}.${randomUUID()}.next`;
  let descriptor: number | null = null;
  try {
    descriptor = operations.open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    operations.write(descriptor, serializedState);
    operations.flush(descriptor);
    operations.close(descriptor);
    descriptor = null;
    operations.replace(temporaryPath, statePath);
    const directoryDescriptor = operations.open(dirname(statePath), constants.O_RDONLY);
    try {
      operations.flush(directoryDescriptor);
    } finally {
      operations.close(directoryDescriptor);
    }
  } catch (error: unknown) {
    if (descriptor !== null) {
      try {
        operations.close(descriptor);
      } catch {
        // Preserve the persistence failure that caused cleanup.
      }
    }
    try {
      operations.remove(temporaryPath);
    } catch {
      // The replacement may already have consumed the temporary path.
    }
    throw error;
  }
}

function metadataWithMessageId(
  config: RunnableConfig,
  metadata: CheckpointMetadata,
): CheckpointMetadata {
  const messageId = config.metadata?.messageId;
  return typeof messageId === "string"
    ? ({ ...metadata, messageId } as CheckpointMetadata)
    : metadata;
}

function turnKey(sessionId: string, messageId: string): string {
  return `${JSON.stringify(sessionId)}\u0000${JSON.stringify(messageId)}`;
}

function createPersistedStateSchema() {
  const agentEventSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("assistant-text-delta"), text: z.string() }).strict(),
    z
      .object({
        type: z.literal("tool-approval-required"),
        reviewId: z.string().min(1),
        toolName: z.string().min(1),
        arguments: z.record(z.string(), z.string()),
        description: z.string().min(1),
        allowedDecisions: z.tuple([z.literal("approve"), z.literal("amend"), z.literal("reject")]),
      })
      .strict(),
    z
      .object({
        type: z.literal("tool-approval-submitted"),
        decision: z.enum(["approve", "amend", "reject"]),
      })
      .strict(),
    z.object({ type: z.literal("turn-completed") }).strict(),
    z.object({ type: z.literal("turn-cancelled") }).strict(),
  ]);
  return z
    .object({
      version: z.literal(1),
      storage: z.record(
        z.string(),
        z.record(z.string(), z.record(z.string(), checkpointEntrySchema)),
      ),
      writes: z.record(z.string(), z.record(z.string(), writeEntrySchema)),
      turns: z
        .record(
          z.string(),
          z
            .object({
              state: z.enum(["pending-approval", "in-progress", "completed", "cancelled"]),
              events: z.array(agentEventSchema),
            })
            .strict(),
        )
        .default({}),
    })
    .strict();
}

function readPersistedState(
  statePath: string,
): z.infer<ReturnType<typeof createPersistedStateSchema>> | null {
  try {
    const size = statSync(statePath).size;
    if (size === 0) {
      return null;
    }
    assertCheckpointStateSize(size);
    const input: unknown = deserialize(readFileSync(statePath));
    return createPersistedStateSchema().parse(input);
  } catch {
    throw invalidCheckpointState();
  }
}

export function assertCheckpointStateSize(size: number): void {
  if (size > MAX_CHECKPOINT_STATE_BYTES) {
    throw invalidCheckpointState();
  }
}

function invalidCheckpointState(): AgentAdapterError {
  return new AgentAdapterError(
    "invalid-checkpoint-state",
    "The checkpoint state is invalid or exceeds the supported size.",
  );
}
