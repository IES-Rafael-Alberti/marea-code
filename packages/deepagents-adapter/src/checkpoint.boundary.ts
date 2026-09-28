import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

import {
  AgentAdapterError,
  type AgentCheckpoint,
  type LocalCheckpointOptions,
} from "./contracts.js";
import {
  DurableFileSaver,
  MemoryTurnSaver,
  type RuntimeCheckpointSaver,
} from "./durable-checkpoint.boundary.js";

interface RegisteredCheckpoint {
  readonly saver: RuntimeCheckpointSaver;
}

const CHECKPOINT_FILENAME = "checkpoints.bin";
const checkpointRegistry = new WeakMap<AgentCheckpoint, RegisteredCheckpoint>();

export function createLocalCheckpoint(options: LocalCheckpointOptions): AgentCheckpoint {
  const storageDirectory = secureStorageDirectory(options);
  const checkpointPath = join(storageDirectory, CHECKPOINT_FILENAME);
  secureCheckpointFile(checkpointPath);
  return registerCheckpoint(new DurableFileSaver(checkpointPath));
}

export function closeAgentCheckpoint(checkpoint: AgentCheckpoint): void {
  const registered = checkpointRegistry.get(checkpoint);
  if (registered === undefined) {
    throw invalidCheckpoint();
  }
  checkpointRegistry.delete(checkpoint);
}

export function createInMemoryCheckpointForTest(): AgentCheckpoint {
  return registerCheckpoint(new MemoryTurnSaver());
}

export function resolveCheckpoint(
  checkpoint: AgentCheckpoint,
): (BaseCheckpointSaver & RuntimeCheckpointSaver) | undefined {
  return checkpointRegistry.get(checkpoint)?.saver;
}

function registerCheckpoint(saver: RuntimeCheckpointSaver): AgentCheckpoint {
  const handle: AgentCheckpoint = Object.freeze({ kind: "marea-agent-checkpoint" });
  checkpointRegistry.set(handle, { saver });
  return handle;
}

function secureStorageDirectory(options: LocalCheckpointOptions): string {
  const projectDirectory = existingDirectory(options.projectDirectory);
  const target = canonicalTarget(options.storageDirectory);
  if (isWithin(projectDirectory, target)) {
    throw new AgentAdapterError(
      "invalid-runtime-dependency",
      "The checkpoint directory must be outside the project directory.",
    );
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const storageDirectory = realpathSync(target);
  chmodSync(storageDirectory, 0o700);
  return storageDirectory;
}

function existingDirectory(path: string): string {
  if (!isAbsolute(path) || !existsSync(path) || !lstatSync(path).isDirectory()) {
    throw new AgentAdapterError(
      "invalid-runtime-dependency",
      "The project directory must be an existing absolute directory.",
    );
  }
  return realpathSync(path);
}

function canonicalTarget(path: string): string {
  if (!isAbsolute(path)) {
    throw new AgentAdapterError(
      "invalid-runtime-dependency",
      "The checkpoint directory must be an absolute path.",
    );
  }
  const suffix: string[] = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  if (!statSync(ancestor).isDirectory()) {
    throw new AgentAdapterError(
      "invalid-runtime-dependency",
      "The checkpoint path must resolve from a directory.",
    );
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function secureCheckpointFile(checkpointPath: string): void {
  if (existsSync(checkpointPath)) {
    const metadata = lstatSync(checkpointPath);
    if (!metadata.isFile()) {
      throw new AgentAdapterError(
        "invalid-runtime-dependency",
        "The checkpoint state must be a regular file.",
      );
    }
    chmodSync(checkpointPath, 0o600);
    return;
  }
  const descriptor = openSync(
    checkpointPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o600,
  );
  // Stryker disable next-line CallExpression: descriptor closure has no stable black-box signal.
  closeSync(descriptor);
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    !pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent)
  );
}

function invalidCheckpoint(): AgentAdapterError {
  return new AgentAdapterError(
    "invalid-runtime-dependency",
    "Use an open adapter-created checkpoint handle.",
  );
}
