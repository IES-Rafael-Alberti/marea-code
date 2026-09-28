import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { serialize } from "node:v8";

import {
  CURRENT_PROTOCOL_VERSION,
  ModelGatewayStreamChunkSchema,
  RequestIdSchema,
  type ModelGatewayRequest,
  type ModelGatewayStreamChunk,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { collect, signal, unusedTool, useTemporaryDirectories } from "./adapter.fixture.js";
import {
  closeAgentCheckpoint,
  createLocalCheckpoint,
  createInMemoryCheckpointForTest,
  resolveCheckpoint,
} from "./checkpoint.boundary.js";
import {
  AgentAdapterError,
  type AgentAdapterErrorCode,
  type AgentCheckpoint,
  type MareaModelGateway,
} from "./contracts.js";
import {
  assertCheckpointStateSize,
  type CheckpointFileOperations,
  createCheckpointFileOperations,
  DurableFileSaver,
} from "./durable-checkpoint.boundary.js";
import { createAgentRuntime, createMareaGatewayModel } from "./upstream.boundary.js";

const temporaryRoot = useTemporaryDirectories("marea-checkpoint-");

describe("local checkpoint boundary", () => {
  it("persists conversation history outside the project across process-shaped reopen", async () => {
    const root = temporaryRoot();
    const projectDirectory = join(root, "project");
    const storageDirectory = join(root, "state", "agent");
    mkdirSync(projectDirectory);
    const firstGateway = new TextGateway("first answer");
    const firstCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });

    await collect(
      runtime(firstGateway, firstCheckpoint).streamMessage(
        { messageId: "message:first", sessionId: "persistent-session", text: "first question" },
        signal(),
      ),
    );
    closeAgentCheckpoint(firstCheckpoint);
    const checkpointPath = join(storageDirectory, "checkpoints.bin");
    chmodSync(checkpointPath, 0o644);

    const secondGateway = new TextGateway("second answer");
    const secondCheckpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    expect(lstatSync(checkpointPath).mode & 0o777).toBe(0o600);
    await collect(
      runtime(secondGateway, secondCheckpoint).streamMessage(
        { messageId: "message:second", sessionId: "persistent-session", text: "second question" },
        signal(),
      ),
    );
    await resolveCheckpoint(secondCheckpoint)?.deleteThread("persistent-session");
    closeAgentCheckpoint(secondCheckpoint);

    expect(secondGateway.requests[0]?.messages.map((message) => message.content)).toEqual([
      expect.stringContaining("Synthetic system prompt."),
      "first question",
      "first answer",
      "second question",
    ]);
    expect(lstatSync(storageDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(checkpointPath).mode & 0o777).toBe(0o600);
  });

  it("rejects checkpoint state inside the project or at a relative path", () => {
    const root = temporaryRoot();
    const projectDirectory = join(root, "project");
    mkdirSync(projectDirectory);

    expectAdapterError(() => {
      createLocalCheckpoint({
        projectDirectory,
        storageDirectory: join(projectDirectory, ".marea"),
      });
    }, "The checkpoint directory must be outside the project directory.");
    expectAdapterError(() => {
      createLocalCheckpoint({
        projectDirectory,
        storageDirectory: projectDirectory,
      });
    }, "The checkpoint directory must be outside the project directory.");
    expectAdapterError(() => {
      createLocalCheckpoint({ projectDirectory, storageDirectory: "relative-state" });
    }, "The checkpoint directory must be an absolute path.");
    expectAdapterError(() => {
      createLocalCheckpoint({
        projectDirectory: "relative-project",
        storageDirectory: join(root, "state"),
      });
    }, "The project directory must be an existing absolute directory.");
  });

  it("rejects invalid project, storage, and database filesystem entries", () => {
    const root = temporaryRoot();
    const projectDirectory = join(root, "project");
    const storageFile = join(root, "storage-file");
    const projectFile = join(root, "project-file");
    mkdirSync(projectDirectory);
    writeFileSync(storageFile, "not a directory");
    writeFileSync(projectFile, "not a directory");

    expectAdapterError(() => {
      createLocalCheckpoint({
        projectDirectory: join(root, "missing-project"),
        storageDirectory: join(root, "state"),
      });
    }, "The project directory must be an existing absolute directory.");
    expectAdapterError(() => {
      createLocalCheckpoint({
        projectDirectory: projectFile,
        storageDirectory: join(root, "state"),
      });
    }, "The project directory must be an existing absolute directory.");
    expectAdapterError(() => {
      createLocalCheckpoint({
        projectDirectory,
        storageDirectory: join(storageFile, "state"),
      });
    }, "The checkpoint path must resolve from a directory.");

    const storageDirectory = join(root, "state-with-bad-db");
    mkdirSync(storageDirectory);
    mkdirSync(join(storageDirectory, "checkpoints.bin"));
    expectAdapterError(() => {
      createLocalCheckpoint({ projectDirectory, storageDirectory });
    }, "The checkpoint state must be a regular file.");

    const linkedStorage = join(root, "state-with-linked-file");
    const linkedTarget = join(root, "linked-checkpoint-target");
    mkdirSync(linkedStorage);
    writeFileSync(linkedTarget, "target");
    symlinkSync(linkedTarget, join(linkedStorage, "checkpoints.bin"));
    expectAdapterError(() => {
      createLocalCheckpoint({ projectDirectory, storageDirectory: linkedStorage });
    }, "The checkpoint state must be a regular file.");
  });

  it("sanitizes malformed and unsupported checkpoint state", () => {
    const root = temporaryRoot();
    const projectDirectory = join(root, "project");
    mkdirSync(projectDirectory);
    const invalidStates = [
      { directory: "malformed", content: new Uint8Array([1, 2, 3]) },
      { directory: "unsupported", content: serialize({ version: 2 }) },
    ];

    for (const invalid of invalidStates) {
      const storageDirectory = join(root, invalid.directory);
      mkdirSync(storageDirectory);
      writeFileSync(join(storageDirectory, "checkpoints.bin"), invalid.content);
      expectAdapterError(
        () => {
          createLocalCheckpoint({ projectDirectory, storageDirectory });
        },
        "The checkpoint state is invalid or exceeds the supported size.",
        "invalid-checkpoint-state",
      );
    }
  });

  it("rejects oversized checkpoint state before reading it", () => {
    const root = temporaryRoot();
    const projectDirectory = join(root, "project");
    const storageDirectory = join(root, "oversized");
    const checkpointPath = join(storageDirectory, "checkpoints.bin");
    mkdirSync(projectDirectory);
    mkdirSync(storageDirectory);
    writeFileSync(checkpointPath, serialize({ version: 1, storage: {}, writes: {} }));
    truncateSync(checkpointPath, 64 * 1024 * 1024 + 1);

    expectAdapterError(
      () => {
        createLocalCheckpoint({ projectDirectory, storageDirectory });
      },
      "The checkpoint state is invalid or exceeds the supported size.",
      "invalid-checkpoint-state",
    );
    expect(() => {
      assertCheckpointStateSize(64 * 1024 * 1024);
    }).not.toThrow();
    expectAdapterError(
      () => {
        assertCheckpointStateSize(64 * 1024 * 1024 + 1);
      },
      "The checkpoint state is invalid or exceeds the supported size.",
      "invalid-checkpoint-state",
    );
  });

  it("follows a storage symlink before enforcing project separation", () => {
    const root = temporaryRoot();
    const projectDirectory = join(root, "project");
    const externalDirectory = join(root, "external");
    const linkedDirectory = join(root, "linked");
    mkdirSync(projectDirectory);
    mkdirSync(externalDirectory);
    symlinkSync(externalDirectory, linkedDirectory);
    chmodSync(externalDirectory, 0o755);

    const checkpoint = createLocalCheckpoint({
      projectDirectory,
      storageDirectory: linkedDirectory,
    });
    closeAgentCheckpoint(checkpoint);

    expect(lstatSync(join(externalDirectory, "checkpoints.bin")).isFile()).toBe(true);
    expect(lstatSync(externalDirectory).mode & 0o777).toBe(0o700);
  });

  it("allows checkpoint state in the parent of the project", () => {
    const root = temporaryRoot();
    const projectDirectory = join(root, "project");
    mkdirSync(projectDirectory);

    const checkpoint = createLocalCheckpoint({ projectDirectory, storageDirectory: root });
    closeAgentCheckpoint(checkpoint);

    expect(lstatSync(join(root, "checkpoints.bin")).isFile()).toBe(true);
  });

  it("rejects forged and already closed handles", () => {
    const root = temporaryRoot();
    const projectDirectory = join(root, "project");
    mkdirSync(projectDirectory);
    const checkpoint = createLocalCheckpoint({
      projectDirectory,
      storageDirectory: join(root, "state"),
    });
    closeAgentCheckpoint(checkpoint);

    expectAdapterError(() => {
      closeAgentCheckpoint(checkpoint);
    }, "Use an open adapter-created checkpoint handle.");
    expectAdapterError(() => {
      closeAgentCheckpoint({ kind: "marea-agent-checkpoint" });
    }, "Use an open adapter-created checkpoint handle.");

    const inMemory = createInMemoryCheckpointForTest();
    closeAgentCheckpoint(inMemory);
  });

  it("recovers its persistence queue after a filesystem write failure", async () => {
    const root = temporaryRoot();
    const statePath = join(root, "missing", "checkpoints.bin");
    const saver = new DurableFileSaver(statePath);

    await expect(saver.deleteThread("synthetic-session")).rejects.toThrow();
    mkdirSync(join(root, "missing"));
    await expect(saver.deleteThread("synthetic-session")).resolves.toBeUndefined();
    await saver.recordTurn("other-session", "message:1", {
      state: "completed",
      events: [{ type: "turn-completed" }],
    });
    await saver.deleteThread("synthetic-session");
  });

  it("creates private temporary state and flushes file and directory around atomic replacement", async () => {
    const root = temporaryRoot();
    const statePath = join(root, "checkpoints.bin");
    const order: string[] = [];
    const descriptorKinds = new Map<number, "directory" | "temporary">();
    const actual = createCheckpointFileOperations();
    const operations: CheckpointFileOperations = {
      ...actual,
      open: (path, flags, mode) => {
        const descriptor = actual.open(path, flags, mode);
        const kind = path === root ? "directory" : "temporary";
        descriptorKinds.set(descriptor, kind);
        order.push(`open:${kind}`);
        if (kind === "temporary") {
          expect(mode).toBe(0o600);
          expect(lstatSync(path).mode & 0o777).toBe(0o600);
        }
        return descriptor;
      },
      write: (descriptor, data) => {
        order.push(`write:${descriptorKinds.get(descriptor) ?? "unknown"}`);
        actual.write(descriptor, data);
      },
      flush: (descriptor) => {
        order.push(`flush:${descriptorKinds.get(descriptor) ?? "unknown"}`);
        actual.flush(descriptor);
      },
      close: (descriptor) => {
        order.push(`close:${descriptorKinds.get(descriptor) ?? "unknown"}`);
        actual.close(descriptor);
      },
      replace: (source, destination) => {
        order.push("replace");
        actual.replace(source, destination);
      },
    };

    await new DurableFileSaver(statePath, operations).recordTurn("private", "message:1", {
      state: "completed",
      events: [{ type: "turn-completed" }],
    });

    expect(order).toEqual([
      "open:temporary",
      "write:temporary",
      "flush:temporary",
      "close:temporary",
      "replace",
      "open:directory",
      "flush:directory",
      "close:directory",
    ]);
    expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("does not replace acknowledged state when flushing the temporary file fails", async () => {
    const root = temporaryRoot();
    const statePath = join(root, "checkpoints.bin");
    await new DurableFileSaver(statePath).recordTurn("durable", "message:old", {
      state: "completed",
      events: [{ type: "turn-completed" }],
    });
    const durableBytes = readFileSync(statePath);
    const actual = createCheckpointFileOperations();
    let failed = false;
    const saver = new DurableFileSaver(statePath, {
      ...actual,
      flush: (descriptor) => {
        if (!failed) {
          failed = true;
          throw new Error("synthetic file flush failure");
        }
        actual.flush(descriptor);
      },
    });

    await expect(
      saver.recordTurn("durable", "message:new", {
        state: "completed",
        events: [{ type: "turn-completed" }],
      }),
    ).rejects.toThrow("synthetic file flush failure");
    expect(readFileSync(statePath)).toEqual(durableBytes);
    expect(readdirSync(root)).toEqual(["checkpoints.bin"]);
    expect(new DurableFileSaver(statePath).findTurn("durable", "message:new")).toBeNull();
  });

  it("deletes recovery records for only the selected thread", async () => {
    const root = temporaryRoot();
    const statePath = join(root, "checkpoints.bin");
    const saver = new DurableFileSaver(statePath);
    const completed = {
      state: "completed" as const,
      events: [{ type: "turn-completed" as const }],
    };
    await saver.recordTurn("target-session", "message:target", completed);
    await saver.recordTurn("other-session", "message:other", completed);

    await saver.deleteThread("target-session");

    expect(saver.findTurn("target-session", "message:target")).toBeNull();
    expect(saver.findTurn("other-session", "message:other")).toEqual(completed);
    const reopened = new DurableFileSaver(statePath);
    expect(reopened.findTurn("target-session", "message:target")).toBeNull();
    expect(reopened.findTurn("other-session", "message:other")).toEqual(completed);
  });

  it.each(["amend", "reject"] as const)(
    "persists a completed %s approval result",
    async (decision) => {
      const statePath = join(temporaryRoot(), "checkpoints.bin");
      const saver = new DurableFileSaver(statePath);
      const record = {
        state: "completed" as const,
        events: [
          { type: "tool-approval-submitted" as const, decision },
          { type: "turn-completed" as const },
        ],
      };
      await saver.recordTurn("approval-session", `message:${decision}`, record);

      expect(
        new DurableFileSaver(statePath).findTurn("approval-session", `message:${decision}`),
      ).toEqual(record);
    },
  );

  it("persists pending writes before another saver opens the state", async () => {
    const root = temporaryRoot();
    const statePath = join(root, "checkpoints.bin");
    const saver = new DurableFileSaver(statePath);
    const savedConfig = await saver.put(
      { configurable: { thread_id: "thread-1" } },
      {
        v: 4,
        id: "checkpoint-1",
        ts: "2026-09-03T10:00:00.000Z",
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      },
      { source: "input", step: -1, parents: {} },
    );
    await saver.putWrites(savedConfig, [["messages", "persisted"]], "task-1");

    const reopened = new DurableFileSaver(statePath);
    const tuple = await reopened.getTuple(savedConfig);

    expect(tuple?.pendingWrites).toEqual([["task-1", "messages", "persisted"]]);
    expect(tuple?.metadata).not.toHaveProperty("messageId");
  });
});

class TextGateway implements MareaModelGateway {
  readonly requests: ModelGatewayRequest[] = [];
  private readonly answer: string;

  constructor(answer: string) {
    this.answer = answer;
  }

  async *stream(request: ModelGatewayRequest): AsyncIterable<ModelGatewayStreamChunk> {
    await Promise.resolve();
    this.requests.push(request);
    yield ModelGatewayStreamChunkSchema.parse({
      ...chunkBase(request, 0),
      event: "started",
    });
    yield ModelGatewayStreamChunkSchema.parse({
      ...chunkBase(request, 1),
      event: "text-delta",
      delta: this.answer,
    });
    yield ModelGatewayStreamChunkSchema.parse({
      ...chunkBase(request, 2),
      event: "completed",
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 1 },
    });
  }
}

function runtime(gateway: TextGateway, checkpoint: AgentCheckpoint) {
  return createAgentRuntime({
    model: createMareaGatewayModel({
      gateway,
      nextRequestId: () => RequestIdSchema.parse(`request-${String(gateway.requests.length + 1)}`),
    }),
    checkpoint,
    approvalTool: unusedTool,
    systemPrompt: "Synthetic system prompt.",
  });
}

function chunkBase(request: ModelGatewayRequest, sequence: number) {
  return {
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: request.requestId,
    modelAlias: "marea",
    sequence,
    emittedAt: "2026-09-03T10:00:00.000Z",
  } as const;
}

function expectAdapterError(
  action: () => void,
  message: string,
  code: AgentAdapterErrorCode = "invalid-runtime-dependency",
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentAdapterError);
    if (error instanceof AgentAdapterError) {
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      return;
    }
  }
  throw new Error("Expected an AgentAdapterError.");
}
